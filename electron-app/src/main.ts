/**
 * main.ts - GrayCode Desktop (Electron main process)
 *
 * Hosts the full GrayCode backend (bundled with the `vscode` import aliased to
 * our shim) and serves the existing Vue frontend from frontend/dist over a
 * custom `graycode://` protocol (so fetch()/audio work without CORS issues).
 */

import { app, BrowserWindow, Menu, dialog, ipcMain, protocol } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { BackendHost } from './host/BackendHost';
import { runNative, setPickWorkspaceHandler } from './native';
import { Logger, LogLevel } from '../../backend/core/logger';
// esbuild 把 vscode-shim 内联进主进程 bundle；此处的具名导入会被静态解析，
// 不能使用 require('./vscode-shim')（打包产物中不存在该独立文件，运行时会抛 MODULE_NOT_FOUND）。
import { __setWindowFocused } from './vscode-shim';

const REPO_ROOT = process.env.GRAYCODE_REPO_ROOT || path.resolve(__dirname, '..', '..');
const CUSTOM_SCHEME = 'graycode';

// 便携式多实例：所有数据（会话/设置/工作区/记忆/用量/缓存）默认写入应用自身目录下的 data/，
// 不写入系统路径（AppData / Program Files）。复制一份应用目录即可得到互不影响的独立实例。
// 显式覆盖：`--user-data-dir <path>` 命令行参数或 `GRAYCODE_USER_DATA_DIR` 环境变量优先。
// 必须在任何 app.getPath('userData') 使用之前调用 app.setPath，因此放在模块顶层。
function resolveUserDataDir(): string {
  const cliIndex = process.argv.indexOf('--user-data-dir');
  const cliDir = cliIndex > -1 ? process.argv[cliIndex + 1] : undefined;
  const explicit = process.env.GRAYCODE_USER_DATA_DIR || cliDir;
  if (explicit) {
    return path.resolve(explicit);
  }
  if (app.isPackaged) {
    // 打包版：数据目录与可执行文件同级（win-unpacked/GrayCode.exe → win-unpacked/data）
    return path.join(path.dirname(app.getPath('exe')), 'data');
  }
  // 开发版（electron .）：数据目录在 electron-app/data（已加入 .gitignore）
  return path.join(path.resolve(__dirname, '..'), 'data');
}
app.setPath('userData', resolveUserDataDir());

Logger.setLevel(LogLevel.INFO);

let mainWindow: BrowserWindow | null = null;
let backendHost: BackendHost | null = null;

const workspaceStateFile = () => path.join(app.getPath('userData'), 'workspace.json');

function loadWorkspaceState(): string[] {
  try {
    const raw = JSON.parse(fs.readFileSync(workspaceStateFile(), 'utf-8'));
    if (Array.isArray(raw?.folders)) return raw.folders.filter((f: unknown) => typeof f === 'string');
  } catch {
    // ignore
  }
  return [];
}

function filterExistingFolders(folders: string[]): string[] {
  return folders.filter((f) => {
    try {
      return fs.statSync(f).isDirectory();
    } catch {
      return false;
    }
  });
}

function saveWorkspaceState(folders: string[]): void {
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(workspaceStateFile(), JSON.stringify({ folders }, null, 2), 'utf-8');
  } catch (err) {
    console.error('Failed to persist workspace state:', err);
  }
}

async function setWorkspaceFolders(folders: string[]): Promise<void> {
  saveWorkspaceState(folders);
  backendHost?.setWorkspaceFolders(folders);
  if (mainWindow) {
    const label = folders.length > 0 ? path.basename(folders[0]) : 'No workspace';
    mainWindow.setTitle(`GrayCode \u2014 ${label}`);
  }
}

async function pickWorkspaceFolder(): Promise<void> {
  if (!mainWindow) return;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Open Workspace Folder',
    buttonLabel: 'Choose Folder',
    properties: ['openDirectory']
  });
  if (!result.canceled && result.filePaths.length > 0) {
    await setWorkspaceFolders(result.filePaths);
  }
}

// ============================================================================
// Custom protocol: serves repo files as a standard, fetch-capable scheme
// ============================================================================

protocol.registerSchemesAsPrivileged([
  {
    scheme: CUSTOM_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      bypassCSP: true
    }
  }
]);

export function registerCustomProtocol(): void {
  const MIME_BY_EXT: Record<string, string> = {
    '.js': 'application/javascript',
    '.mjs': 'application/javascript',
    '.cjs': 'application/javascript',
    '.ts': 'text/plain',
    '.css': 'text/css',
    '.html': 'text/html',
    '.htm': 'text/html',
    '.json': 'application/json',
    '.jsonc': 'application/json',
    '.map': 'application/json',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.avif': 'image/avif',
    '.ico': 'image/x-icon',
    '.bmp': 'image/bmp',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.otf': 'font/otf',
    '.eot': 'application/vnd.ms-fontobject',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',
    '.m4a': 'audio/mp4',
    '.flac': 'audio/flac',
    '.aac': 'audio/aac',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mov': 'video/quicktime',
    '.m4v': 'video/x-m4v',
    '.avi': 'video/x-msvideo',
    '.wasm': 'application/wasm',
    '.pdf': 'application/pdf',
    '.md': 'text/markdown',
    '.txt': 'text/plain',
    '.log': 'text/plain',
    '.csv': 'text/csv',
    '.xml': 'application/xml',
    '.yml': 'application/yaml',
    '.yaml': 'application/yaml',
    '.webmanifest': 'application/manifest+json'
  };
  // In-memory cache keyed by mtime: app reloads re-read the same ~3MB bundle
  // on every launch; serving it from memory keeps startup snappy.
  const fileCache = new Map<string, { body: Buffer; mime: string; mtimeMs: number }>();
  protocol.handle(CUSTOM_SCHEME, async (request) => {
    try {
      const url = new URL(request.url);
      // graycode://local/<relative path from repo root>
      const relPath = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      if (!relPath) return new Response('Not found', { status: 404 });
      const fsPath = path.normalize(path.join(REPO_ROOT, relPath));
      // containment check（Windows 路径不区分大小写，需归一化后比较，并加分隔符边界防止
      // C:\repo 与 C:\repo2 误放行/误拦截）
      const rootNorm = process.platform === 'win32' ? REPO_ROOT.replace(/\\/g, '/').toLowerCase() : REPO_ROOT.replace(/\\/g, '/');
      const pathNorm = process.platform === 'win32' ? fsPath.replace(/\\/g, '/').toLowerCase() : fsPath.replace(/\\/g, '/');
      if (!(pathNorm === rootNorm || pathNorm.startsWith(rootNorm.endsWith('/') ? rootNorm : rootNorm + '/'))) {
        return new Response('Forbidden', { status: 403 });
      }
      const stat = await fs.promises.stat(fsPath);
      if (!stat.isFile()) return new Response('Not found', { status: 404 });
      const mime = MIME_BY_EXT[path.extname(fsPath).toLowerCase()];
      const cached = fileCache.get(fsPath);
      if (cached && cached.mtimeMs === stat.mtimeMs) {
        return new Response(cached.body, {
          status: 200,
          headers: { 'Content-Type': cached.mime }
        });
      }
      const body = await fs.promises.readFile(fsPath);
      const contentType = mime || 'application/octet-stream';
      fileCache.set(fsPath, { body, mime: contentType, mtimeMs: stat.mtimeMs });
      // keep the cache bounded (all assets of the app fit well under this)
      if (fileCache.size > 256) {
        const oldest = fileCache.keys().next().value;
        if (oldest) fileCache.delete(oldest);
      }
      return new Response(body, {
        status: 200,
        headers: { 'Content-Type': contentType }
      });
    } catch (err) {
      return new Response(String(err), { status: 500 });
    }
  });
}

// ============================================================================
// Native operations used by the vscode shim
// ============================================================================

function registerNativeOps(): void {
  ipcMain.handle('graycode:native', (_event, op: string, payload: any) => {
    return runNative(op, payload, mainWindow);
  });
  setPickWorkspaceHandler(() => void pickWorkspaceFolder());
}

// ============================================================================
// Backend + message routing (created once per app run)
// ============================================================================

function createBackend(): void {
  if (backendHost) return;

  backendHost = new BackendHost({
    userDataPath: app.getPath('userData'),
    extensionPath: REPO_ROOT,
    postToRenderer: (message) => {
      // 内嵌面板方案：所有消息（含子代理 Monitor 的事件推送）都投递到主窗口渲染进程，
      // 前端按 requestId/clientId 自行分发。窗口可能已销毁，逐个判空。
      const target = mainWindow?.webContents;
      if (target && !target.isDestroyed()) {
        target.send('graycode:backend-to-renderer', message);
      }
    },
    native: (op, payload) => runNative(op, payload, mainWindow),
    onOpenDiffPreview: (payload) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('graycode:backend-to-renderer', {
          type: 'command',
          command: 'host.openDiffPreview',
          data: payload
        });
      }
    }
  });

  // 消息入口注册一次（不放在 createWindow 内，避免 macOS activate 重建窗口时重复注册，
  // 导致每条渲染层消息被处理两次）。同一窗口内的所有消息都走同一个入口。
  ipcMain.on('graycode:renderer-to-backend', (_event, message: any) => {
    void backendHost?.handleRendererMessage(message);
  });
}

// ============================================================================
// Window + menu
// ============================================================================

function buildMenu(): void {
  const isMac = process.platform === 'darwin';
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'Open Workspace Folder...',
          accelerator: 'CmdOrCtrl+O',
          click: () => void pickWorkspaceFolder()
        },
        { type: 'separator' },
        { role: 'reload', label: 'Reload' },
        { role: 'forceReload', label: 'Force Reload' },
        ...(isMac ? [] : [{ type: 'separator' as const }, { role: 'quit' as const, label: 'Exit' }])
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo', label: 'Undo' },
        { role: 'redo', label: 'Redo' },
        { type: 'separator' },
        { role: 'cut', label: 'Cut' },
        { role: 'copy', label: 'Copy' },
        { role: 'paste', label: 'Paste' },
        { role: 'selectAll', label: 'Select All' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'togglefullscreen', label: 'Toggle Full Screen' },
        { type: 'separator' },
        { role: 'toggleDevTools', label: 'Developer Tools' }
      ]
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'About GrayCode Desktop',
          click: () => {
            void dialog.showMessageBox(mainWindow!, {
              type: 'info',
              title: 'About',
              message: 'GrayCode Desktop',
              detail:
                `GrayCode AI coding assistant (standalone desktop edition)\n` +
                `Based on GrayCode v1.3.1\n` +
                `Electron ${process.versions.electron} / Chromium ${process.versions.chrome}`
            });
          }
        }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 620,
    show: false,
    backgroundColor: '#1e1e1e',
    autoHideMenuBar: false,
    icon: path.join(REPO_ROOT, 'resources', 'icon.png'),
    title: 'GrayCode',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false
    }
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  mainWindow.on('focus', () => {
    __setWindowFocused(true);
  });
  mainWindow.on('blur', () => {
    __setWindowFocused(false);
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(`${CUSTOM_SCHEME}://`)) {
      event.preventDefault();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  void mainWindow.loadURL(`${CUSTOM_SCHEME}://local/frontend/dist/index.html`);

  // Debug: GRAYCODE_DIAG=1 dumps renderer diagnostics to stdout.
  if (process.env.GRAYCODE_DIAG === '1') {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const diag = await mainWindow!.webContents.executeJavaScript(`(function(){
            const app = document.getElementById('app');
            const bodyText = document.body.innerText.slice(0, 600);
            return {
              appChildren: app ? app.children.length : -1,
              bodyText,
              title: document.title,
              codiconFont: (() => { try { return document.fonts.check('16px codicon') } catch(e){ return 'err' } })(),
              stylesheets: [...document.styleSheets].map(s => s.href || 'inline').slice(0, 10),
              bg: getComputedStyle(document.body).backgroundColor,
              fg: getComputedStyle(document.body).color
            };
          })()`);
          console.log('[diag]', JSON.stringify(diag, null, 2));
        } catch (err) {
          console.error('[diag] failed:', err);
        }
        app.quit();
      }, 10000);
    });
  }

  // Debug: GRAYCODE_SHOT=<path> captures a screenshot after load and exits.
  const shotPath = process.env.GRAYCODE_SHOT;
  if (shotPath) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const image = await mainWindow!.webContents.capturePage();
          fs.writeFileSync(shotPath, image.toPNG());
          console.log('[shot] saved to', shotPath);
          app.quit();
        } catch (err) {
          console.error('[shot] failed:', err);
          app.quit();
        }
      }, 9000);
    });
  }

  // Debug: GRAYCODE_UISMOKE=1 drives the real UI (click through pages, measure
  // responsiveness, collect renderer console errors) and prints a report.
  if (process.env.GRAYCODE_UISMOKE === '1') {
    mainWindow.webContents.on('console-message', (event) => {
      const params = (event as any).message !== undefined ? (event as any) : undefined;
      const level = params ? params.level : (event as any as { level: number }).level;
      const message = params ? params.message : (event as any).message;
      if (typeof message === 'string' && message.startsWith('%cElectron Security')) return;
      if ((level ?? 0) >= 2) {
        console.log('[uismoke:renderer-error]', message);
      } else {
        console.log('[uismoke:console]', message);
      }
    });
    mainWindow.webContents.on('dom-ready', () => {
      mainWindow!.webContents.executeJavaScript(`(function(){
        window.__errs = [];
        window.addEventListener('error', function (e) {
          window.__errs.push('error: ' + (e.message || '') + ' @' + (e.filename || '') + ':' + (e.lineno || 0) + ':' + (e.colno || 0) + ' stack=' + String(e.error && e.error.stack || '').slice(0, 400));
        });
        window.addEventListener('unhandledrejection', function (e) {
          const r = e.reason;
          window.__errs.push('rejection: ' + String(r && r.stack || r).slice(0, 400));
        });
      })()`).catch(() => undefined);
    });
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const report = await mainWindow!.webContents.executeJavaScript(`(async function(){
            const sleep = (ms) => new Promise(r => setTimeout(r, ms));
            const results = {};
            const step = async (name, fn) => {
              const t0 = performance.now();
              try {
                const v = await fn();
                results[name] = { ok: !!v, ms: Math.round(performance.now() - t0), detail: v };
              } catch (e) {
                results[name] = { ok: false, ms: Math.round(performance.now() - t0), error: String(e) };
              }
            };
            const clickCodicon = (cls) => {
              const i = document.querySelector('.' + cls);
              if (!i) return false;
              const btn = i.closest('button') || i;
              btn.click();
              return true;
            };
            const sendCommand = (command, data = {}) => {
              // identical to how the extension pushed commands in VS Code
              window.postMessage({ type: 'command', command, data }, '*');
            };

            // collect long tasks during the whole run
            const longTasks = [];
            try {
              new PerformanceObserver((list) => {
                for (const e of list.getEntries()) {
                  longTasks.push({ ms: Math.round(e.duration), start: Math.round(e.startTime) });
                }
              }).observe({ entryTypes: ['longtask'] });
            } catch (e) { /* longtask unsupported */ }

            // wait for the app to mount and the webviewReady handshake to settle
            // （.tabs-bar 顶部栏常驻渲染，挂载即有；不再等待曾被误用的 .chat-header 死组件，
            //   也不等待 .welcome-panel——后者在初始化完成前就会出现，会让检查与 createTabAction 赛跑）
            for (let i = 0; i < 50; i++) {
              if (document.querySelector('.tabs-bar')) break;
              await sleep(200);
            }
            await sleep(1500);
            const nav = performance.getEntriesByType('navigation')[0];
            const resources = performance.getEntriesByType('resource');
            results.mounted = {
              chatHeader: !!document.querySelector('.chat-header'),
              title: document.title,
              bodyLen: document.body.innerText.length,
              welcome: !!document.querySelector('.welcome-panel'),
              topBarButtons: !!document.querySelector('.tabs-bar .lang-toggle') && !!document.querySelector('.tabs-bar .codicon-settings-gear'),
              toastShown: !!document.querySelector('.gc-toast'),
              firstRunToast: (() => {
                const t = [...document.querySelectorAll('.gc-toast')].map((e) => e.innerText || '');
                const hit = t.find((s) => /Welcome to GrayCode/i.test(s));
                return { found: !!hit, texts: t.slice(0, 3), toastCount: t.length };
              })(),
              overlayScript: !!document.querySelector('script[src*="overlay"]'),
              overlayLoaded: window.__graycodeOverlayLoaded === true,
              overlaySrc: (document.querySelector('script[src*="overlay"]') || {}).src || '',
              overlayFetch: await (async () => {
                try {
                  const r = await fetch((document.querySelector('script[src*="overlay"]') || {}).src);
                  const t = await r.text();
                  return { status: r.status, mime: r.headers.get('content-type'), len: t.length, head: t.slice(0, 60) };
                } catch (e) { return { error: String(e) }; }
              })(),
              overlayHtml: (document.querySelector('.gc-overlay-root') || {}).innerHTML ? document.querySelector('.gc-overlay-root').innerHTML.slice(0, 120) : '(no overlay root)',
              ttiHint: nav ? Math.round(nav.domContentLoadedEventEnd) : -1,
              loadMs: nav ? Math.round(nav.loadEventEnd) : -1,
              mainBundleBytes: (resources.find(r => /index\.js/.test(r.name)) || {}).transferSize || -1,
              totalResourceBytes: Math.round(resources.reduce((s, r) => s + (r.transferSize || 0), 0)),
              heapMB: Math.round((performance.memory ? performance.memory.usedJSHeapSize / 1048576 : 0))
            };

            // history page: same command the extension sends from the activity bar
            await step('history', async () => {
              sendCommand('showHistory');
              for (let i = 0; i < 40 && !document.querySelector('.history-page'); i++) await sleep(100);
              const page = document.querySelector('.history-page');
              return page ? { found: true, text: page.innerText.slice(0, 120) } : 'history page missing';
            });

            // usage page (button lives in the history page header)
            await step('usage', async () => {
              const btn = document.querySelector('.history-page .header-btn');
              if (!btn) {
                sendCommand('showUsage');
              } else {
                btn.click();
              }
              for (let i = 0; i < 40 && !document.querySelector('.usage-page'); i++) await sleep(100);
              const page = document.querySelector('.usage-page');
              return page ? { found: true, text: page.innerText.slice(0, 120) } : 'usage page missing';
            });

            // settings page: opened via the dedicated top-bar gear button
            await step('settings', async () => {
              const gear = document.querySelector('.tabs-bar .tab-action-btn .codicon-settings-gear') || document.querySelector('.codicon-settings-gear');
              if (gear) {
                const btn = gear.closest('button') || gear;
                btn.click();
              } else {
                sendCommand('showSettings');
              }
              for (let i = 0; i < 60 && !document.querySelector('.settings-panel'); i++) await sleep(100);
              const panel = document.querySelector('.settings-panel');
              if (!panel) return 'settings panel missing';
              await sleep(1500); // allow settings data to load
              const tabs = [...document.querySelectorAll('.settings-tab')].map(e => (e.innerText || '').trim()).filter(Boolean);
              return { found: true, tabs: tabs.slice(0, 12), tabCount: tabs.length, text: panel.innerText.slice(0, 150) };
            });

            // switch a settings tab (e.g. the "Tools" one) to make sure sub-pages render
            await step('settings.tabSwitch', async () => {
              const tabs = [...document.querySelectorAll('.settings-tab')];
              const target = tabs.find(e => /tool/i.test(e.innerText || '')) || tabs[Math.min(1, tabs.length - 1)];
              if (!target) return 'no tabs';
              target.click();
              await sleep(1200);
              const panel = document.querySelector('.settings-panel');
              return { clicked: (target.innerText || '').trim().slice(0, 30), panelText: panel ? panel.innerText.length : -1 };
            });

            // language toggle: click the top-bar language button, expect the
            // UI text to flip between zh and en, then switch back

            // language toggle: click the top-bar language button, expect the
            // UI text to flip between zh and en, then cycle back to Chinese
            await step('languageToggle', async () => {
              // leave settings back to chat first
              const closeBtn = document.querySelector('.settings-close-btn');
              if (closeBtn) closeBtn.click();
              await sleep(300);
              const langBtn = document.querySelector('.tabs-bar .lang-toggle') || [...document.querySelectorAll('button')].find(b => /中|EN|Auto/.test(b.innerText || ''));
              if (!langBtn) return 'no language button in top bar';
              const labelBefore = langBtn.innerText.trim();
              langBtn.click();
              await sleep(400);
              const isEn = /New Chat|Welcome to GrayCode/i.test(document.body.innerText);
              // cycle until back to Chinese (zh -> en -> ja -> auto -> zh)
              let backToZh = false;
              for (let i = 0; i < 4; i++) {
                if (/欢迎使用 GrayCode|新对话/i.test(document.body.innerText)) { backToZh = true; break; }
                const btn = document.querySelector('.tabs-bar .lang-toggle');
                if (!btn) break;
                btn.click();
                await sleep(350);
              }
              return { found: true, toggledToEn: isEn, cycledBackToZh: backToZh, labelBefore };
            });

            // sub-agent monitor embedded panel: the host.openSubAgentMonitor command
            // must open the in-window panel (.monitor-root) without a separate window
            await step('monitorPanel', async () => {
              // ensure we're on the chat view
              const back = document.querySelector('.settings-close-btn');
              if (back) back.click();
              await sleep(300);
              sendCommand('host.openSubAgentMonitor');
              for (let i = 0; i < 40 && !document.querySelector('.monitor-root'); i++) await sleep(100);
              const monitorRoot = document.querySelector('.monitor-root');
              if (!monitorRoot) return 'monitor panel missing';
              // close it again via the panel close button (or the top-bar toggle)
              const closeBtn = document.querySelector('.monitor-close-btn');
              if (closeBtn) closeBtn.click();
              await sleep(300);
              const stillOpen = !!document.querySelector('.monitor-panel:not([style*="display: none"])');
              return { found: true, header: !!(monitorRoot.querySelector('.monitor-header') || monitorRoot.querySelector('h1')), closedAfterCloseBtn: !stillOpen };
            });

            // send from empty state: with the welcome panel (recent conversations
            // bar) visible and no conversation open, typing + pressing send must
            // create a conversation and render the user message card
            await step('sendFromEmpty', async () => {
              const back = document.querySelector('.settings-close-btn');
              if (back) back.click();
              await sleep(300);
              const storeProbe = () => {
                const app = document.querySelector('#app')?.__vue_app__;
                const pinia = app?.config?.globalProperties?.$pinia;
                const chat = pinia?._s?.get('chat');
                if (!chat) return null;
                return {
                  allMessages: chat.allMessages?.length,
                  isWaitingForResponse: chat.isWaitingForResponse,
                  isStreaming: chat.isStreaming,
                  error: chat.error ? (chat.error.message || JSON.stringify(chat.error)).slice(0, 200) : null,
                  currentConversationId: chat.currentConversationId,
                  configId: chat.configId,
                  selectedModelId: chat.selectedModelId,
                  storeCurrentConfig: chat.currentConfig ? { id: chat.currentConfig.id, model: chat.currentConfig.model, name: chat.currentConfig.name } : null,
                  hasPendingToolConfirmation: chat.hasPendingToolConfirmation
                };
              };
              const before = storeProbe();
              const editor = document.querySelector('.input-box [contenteditable="true"], .input-area [contenteditable="true"], [contenteditable="true"]');
              if (!editor) return { missing: 'no editor', before };
              editor.focus();
              document.execCommand('insertText', false, 'send smoke test');
              await sleep(300);
              const editorText = (editor.innerText || '').trim();
              const sendBtn = [...document.querySelectorAll('button')].find(b => !!b.querySelector('.codicon-send') || /发送|Send/i.test(b.innerText || ''));
              const btnDisabled = sendBtn ? sendBtn.disabled : null;
              if (sendBtn) sendBtn.click();
              let userCard = null;
              for (let i = 0; i < 150 && !userCard; i++) {
                await sleep(100);
                userCard = document.querySelector('.message-list .user-message');
              }
              const after = storeProbe();
              const errorBox = document.querySelector('.error-panel, .retry-panel, [class*="error-box"]');
              return {
                found: !!userCard,
                before,
                after,
                editorText,
                btnDisabled,
                welcomeGone: !document.querySelector('.welcome-panel'),
                userText: userCard ? (userCard.innerText || '').slice(0, 60) : null,
                errorVisible: !!errorBox,
                errorText: errorBox ? (errorBox.innerText || '').slice(0, 120) : null
              };
            });

            // code-change viewer: the host.openDiffPreview command (vscode.diff
            // interception) must open the embedded GitHub-style panel (.diff-panel)
            // inside the main window - no separate window, no full-screen modal
            await step('diffPanel', async () => {
              const back = document.querySelector('.settings-close-btn');
              if (back) back.click();
              await sleep(300);
              sendCommand('host.openDiffPreview', {
                id: 1,
                previewId: 'diff-smoke',
                sessionId: 'diff-smoke-1',
                title: 'Smoke diff',
                filePath: 'e2e-diff-test.txt',
                originalContent: 'line1\\nline2\\nline3\\nline4',
                newContent: 'line1-changed\\nline2\\nline3\\nline4\\nline5',
                preview: false
              });
              for (let i = 0; i < 40 && !document.querySelector('.diff-panel'); i++) await sleep(100);
              const panel = document.querySelector('.diff-panel');
              if (!panel) return 'diff panel missing';
              const fileRows = panel.querySelectorAll('.diff-file-item').length;
              const addLines = panel.querySelectorAll('.diff-row.added').length;
              const delLines = panel.querySelectorAll('.diff-row.deleted').length;
              const hunkHeaders = panel.querySelectorAll('.diff-hunk-header').length;
              const closeBtn = panel.querySelector('.diff-close-btn');
              if (closeBtn) closeBtn.click();
              await sleep(300);
              const stillOpen = !!document.querySelector('.diff-panel:not([style*="display: none"])');
              return { found: true, fileRows, addLines, delLines, hunkHeaders, closedAfterCloseBtn: !stillOpen };
            });

            // back to chat via the settings close button
            await step('backToChat', async () => {
              const back = document.querySelector('.settings-close-btn');
              if (back) { back.click(); }
              for (let i = 0; i < 40 && !document.querySelector('.chat-view, .welcome-panel'); i++) await sleep(100);
              return document.querySelector('.welcome-panel') || document.querySelector('.chat-view') ? true : false;
            });

            // input area sanity: editor present + send button present
            await step('inputArea', async () => {
              const input = document.querySelector('.input-area, .input-box, [contenteditable="true"]');
              const send = [...document.querySelectorAll('button')].find(b => (b.innerText || '').includes('发送') || (b.innerText || '').includes('Send') || !!b.querySelector('.codicon-send'));
              return { input: !!input, send: !!send, sendLabel: send ? (send.innerText || '').trim().slice(0, 20) : null };
            });

            results.rendererErrors = window.__errs || [];
            results.longTasks = longTasks;

            return results;
          })()`);
          console.log('[uismoke] ' + JSON.stringify(report, null, 2));
          app.quit();
        } catch (err) {
          console.error('[uismoke] failed:', err);
          app.quit();
        }
      }, 12000);
    });
  }

  // restore workspace
  void backendHost.ready.then(() => {
    const folders = filterExistingFolders(loadWorkspaceState());
    if (folders.length > 0) {
      void setWorkspaceFolders(folders);
    } else if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setTitle('GrayCode \u2014 No workspace');
      // Let the renderer know there is no usable workspace (e.g. a previously
      // saved folder was deleted or moved) so it can surface a hint.
      mainWindow.webContents.send('graycode:backend-to-renderer', {
        type: 'command',
        command: 'host.noWorkspace',
        data: { message: 'No workspace folder is open. Use File > Open Workspace Folder... to get started.' }
      });
    }
  });
}

// ============================================================================
// App lifecycle
// ============================================================================

app.setName('GrayCode Desktop');

if (process.env.GRAYCODE_E2E === '1') {
  app.whenReady().then(async () => {
    const { runE2E } = await import('./e2e');
    await runE2E();
  });
} else if (process.env.GRAYCODE_MONITOR_SMOKE === '1') {
  app.whenReady().then(async () => {
    const { runMonitorSmoke } = await import('./monitor-smoke');
    await runMonitorSmoke();
  });
} else {
  app.whenReady().then(() => {
  registerCustomProtocol();
  registerNativeOps();
  buildMenu();
  createBackend();
  createWindow();

  app.on('activate', () => {
    // macOS：点击 Dock 图标时若无窗口则重建；已有窗口时恢复/聚焦。
    // BackendHost 与 IPC 监听只创建一次，这里只重建窗口，避免双重注册。
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    } else if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    void backendHost?.dispose();
    app.quit();
  }
});

app.on('before-quit', () => {
  void backendHost?.dispose();
});
