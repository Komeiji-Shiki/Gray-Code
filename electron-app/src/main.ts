/**
 * main.ts - GrayCode Desktop (Electron main process)
 *
 * Hosts the full GrayCode backend (bundled with the `vscode` import aliased to
 * our shim) and serves the existing Vue frontend from frontend/dist over a
 * custom `graycode://` protocol (so fetch()/audio work without CORS issues).
 */

import { app, BrowserWindow, Menu, dialog, ipcMain, protocol, nativeTheme } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { BackendHost } from './host/BackendHost';
import { runNative, setPickWorkspaceHandler, setOpenWorkspaceHandler } from './native';
import { Logger, LogLevel } from '../../backend/core/logger';
// esbuild 把 vscode-shim 内联进主进程 bundle；此处的具名导入会被静态解析，
// 不能使用 require('./vscode-shim')（打包产物中不存在该独立文件，运行时会抛 MODULE_NOT_FOUND）。
import { __setWindowFocused } from './vscode-shim';

// ============================================================================
// stdout/stderr EPIPE 防护（必须在任何日志输出之前安装）
//
// 输出被重定向到管道（`... | xxx`、CI、终端工具）时，读取端可能提前关闭；
// Node 默认把后续 console.log / process.stdout.write 抛出的 EPIPE 当作
// 未捕获异常，Electron 主进程会直接弹「A JavaScript error occurred in the
// main process」并崩溃（e2e 测试大量 console.log 时极易复现）。
// 日志对桌面应用是尽力而为，管道断裂应吞掉而非让进程崩溃。
// ============================================================================
function installStdioEpipeGuard(): void {
  const guard = (stream: NodeJS.WriteStream): void => {
    stream.on('error', (err: NodeJS.ErrnoException) => {
      if (err && err.code === 'EPIPE') return;
      throw err;
    });
  };
  guard(process.stdout);
  guard(process.stderr);
}
installStdioEpipeGuard();

// 未处理拒绝保护：Node 22 起 unhandledRejection 默认是致命错误，会让主进程直接退出。
// 异步链上的偶发错误（插件/三方代码的 promise 泄漏等）不应拖垮整个应用，记录日志即可。
// 日志经 console.error 走 stderr，管道断裂由 installStdioEpipeGuard 兜底，不会二次崩溃。
process.on('unhandledRejection', (reason) => {
  console.error('[main] unhandled rejection:', reason);
});

const REPO_ROOT = process.env.GRAYCODE_REPO_ROOT || path.resolve(__dirname, '..', '..');
const CUSTOM_SCHEME = 'graycode';

function readRootVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8'));
    return typeof pkg.version === 'string' && pkg.version ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

// 便携式多实例：所有数据（会话/设置/工作区/记忆/用量/缓存）默认写入应用自身目录下的 data/，
// 不写入系统路径（AppData / Program Files）。复制一份应用目录即可得到互不影响的独立实例。
// 显式覆盖：`--user-data-dir <path>` 命令行参数或 `GRAYCODE_USER_DATA_DIR` 环境变量优先。
// 必须在任何 app.getPath('userData') 使用之前调用 app.setPath，因此放在模块顶层。
// 目录可写性探测：安装版可能被装进 Program Files 等受保护位置，目录对普通用户只读，
// 直接写入会全部失败且表现不透明。尝试创建/写入/删除探针文件验证可写性。
function probeWritable(dir: string): boolean {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probeFile = path.join(dir, `.write-probe-${process.pid}`);
    fs.writeFileSync(probeFile, 'probe', 'utf-8');
    fs.rmSync(probeFile, { force: true });
    return true;
  } catch {
    return false;
  }
}

function resolveUserDataDir(): string {
  const cliIndex = process.argv.indexOf('--user-data-dir');
  const cliDir = cliIndex > -1 ? process.argv[cliIndex + 1] : undefined;
  const explicit = process.env.GRAYCODE_USER_DATA_DIR || cliDir;
  if (explicit) {
    return path.resolve(explicit);
  }
  if (app.isPackaged) {
    // 便携版（portable target）：NSIS 启动器把程序解压到 %TEMP% 运行，进程退出后临时目录
    // 会被整目录删除；app.getPath('exe') 返回的是临时目录里的 exe，用它推导数据目录会把
    // 全部数据写进临时目录并随退出丢失（每次启动都是“全新应用”，更新后也无法保留数据）。
    // 必须改用启动器注入的 PORTABLE_EXECUTABLE_DIR（便携 exe 实际所在目录）。
    const portableDir = process.env.PORTABLE_EXECUTABLE_DIR;
    if (portableDir) {
      return path.join(path.resolve(portableDir), 'data');
    }
    // 安装版 / zip 免安装版：数据目录与可执行文件同级（win-unpacked/GrayCode.exe → win-unpacked/data）
    const installDataDir = path.join(path.dirname(app.getPath('exe')), 'data');
    if (probeWritable(installDataDir)) {
      return installDataDir;
    }
    // 安装目录不可写（如 Program Files 安装后目录只读）：回退到系统 AppData 数据目录，
    // 保证会话/设置等仍可持久化，而不是静默丢失。
    const fallbackDir = path.join(app.getPath('appData'), 'GrayCode');
    console.warn(
      `[main] user data dir is not writable (${installDataDir}), falling back to ${fallbackDir}`
    );
    return fallbackDir;
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
  // 窗口可能已销毁（关闭竞态）：isDestroyed 的窗口传给 dialog 会抛 "Object has been destroyed"
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Open Workspace Folder',
    buttonLabel: 'Choose Folder',
    properties: ['openDirectory']
  });
  if (!result.canceled && result.filePaths.length > 0) {
    await setWorkspaceFolders(result.filePaths);
    // 与 UI「打开工作区文件夹…」一致：File 菜单打开的工作区同样进入收藏，
    // 多工作区「保存 + 打开 + 重启保留」闭环（不依赖渲染层消息路径）。
    void backendHost?.addSavedWorkspaceFsPaths(result.filePaths).catch((err) => {
      console.error('[main] failed to save workspace favorites:', err);
    });
  }
}

/** 打开指定文件夹作为当前工作区（替换现有工作区，供收藏工作区快速打开） */
async function openWorkspaceFolder(fsPath: string): Promise<void> {
  if (!fsPath) return;
  try {
    if (!fs.statSync(fsPath).isDirectory()) {
      console.warn('[main] openWorkspaceFolder: not a directory:', fsPath);
      return;
    }
  } catch (err) {
    console.warn('[main] openWorkspaceFolder: inaccessible folder:', fsPath, err);
    return;
  }
  await setWorkspaceFolders([fsPath]);
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
      // 不允许 bypassCSP：渲染层加载的是 AI 生成内容渲染出来的页面，
      // CSP 是纵深防御的重要一环，不能对自定义协议豁免。
      bypassCSP: false
    }
  }
]);

// ============================================================================
// 桌面渲染层资源注入（主题变量 / overlay UI）
//
// 为什么用 insertCSS / executeJavaScript 而非依赖 dist 补丁：
// 前端 rebuild 会重新生成 frontend/dist/index.html，patch-dist.mjs 注入的
// theme.css/overlay.js 链接会丢失。CSS 变量一旦缺失，UI 退回浏览器默认样式
// （灰底黑字），这是桌面版对比度问题的根因之一。主进程注入不受 dist 内容影响。
// ============================================================================

function findRendererAsset(name: string): string | null {
  // 打包版：extraResources 把 renderer/ 复制到 resources/renderer/
  const packaged = path.join(REPO_ROOT, 'renderer', name);
  if (fs.existsSync(packaged)) return packaged;
  // 开发版：electron-app/renderer/
  const dev = path.join(REPO_ROOT, 'electron-app', 'renderer', name);
  if (fs.existsSync(dev)) return dev;
  return null;
}

// 记录已注入 CSS 的 key：reload 时先移除旧注入，避免规则翻倍累积（L-6）
const insertedCssKeys = new Map<string, string | null>();

async function insertCssOnce(win: BrowserWindow, css: string, keyName: string): Promise<void> {
  const previousKey = insertedCssKeys.get(keyName) ?? null;
  if (previousKey) {
    try {
      await win.webContents.removeInsertedCSS(previousKey);
    } catch {
      // webContents 已销毁等情况忽略
    }
  }
  const key = await win.webContents.insertCSS(css);
  insertedCssKeys.set(keyName, key);
}

async function injectDesktopRendererAssets(win: BrowserWindow): Promise<void> {
  try {
    const themePath = findRendererAsset('theme.css');
    if (themePath) {
      const css = fs.readFileSync(themePath, 'utf-8');
      await insertCssOnce(win, css, 'theme');
    } else {
      console.warn('[main] theme.css not found; UI will fall back to browser defaults');
    }

    // codicons 图标字体：dist 重建会冲掉 patch-dist.mjs 注入的 <link>，
    // 与 theme.css 同策略改为运行时注入；相对字体 URL 必须改写成绝对 graycode:// URL，
    // 否则会相对页面路径解析（graycode://local/frontend/dist/codicon.ttf）导致字体 404、图标全丢
    const codiconCssPath = path.join(REPO_ROOT, 'resources', 'codicons', 'codicon.css');
    if (fs.existsSync(codiconCssPath)) {
      let codiconCss = fs.readFileSync(codiconCssPath, 'utf-8');
      codiconCss = codiconCss.replace(
        /url\(\s*(['"]?)(\.\/[^)'"]+)\1\s*\)/g,
        (_match, quote, relPath) => {
          const absolute = `graycode://local/resources/codicons/${relPath.replace(/^\.\//, '')}`;
          return `url(${quote}${absolute}${quote})`;
        }
      );
      await insertCssOnce(win, codiconCss, 'codicons');
    }

    const overlayPath = findRendererAsset('overlay.js');
    if (overlayPath) {
      const js = fs.readFileSync(overlayPath, 'utf-8');
      await win.webContents.executeJavaScript(js, false).catch((err) => {
        console.warn('[main] overlay.js injection failed:', err);
      });
    }
  } catch (err) {
    console.warn('[main] Failed to inject renderer assets:', err);
  }
}

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

  // 可服务根目录白名单：只有静态资源目录可被 graycode:// 读取。
  // 用户数据目录（含 API Key 与全部对话历史）默认位于 electron-app/data，
  // 位于 REPO_ROOT 之内，必须显式排除，否则渲染层可 fetch 到全部敏感数据（H-1）。
  const allowedRoots = [
    path.join(REPO_ROOT, 'frontend', 'dist'),
    path.join(REPO_ROOT, 'resources'),
    path.join(REPO_ROOT, 'renderer')
  ];

  function isPathAllowed(fsPath: string): boolean {
    const normalized = path.normalize(fsPath);
    return allowedRoots.some((root) => {
      const rootNorm = process.platform === 'win32'
        ? root.replace(/\\/g, '/').toLowerCase()
        : root.replace(/\\/g, '/');
      const pathNorm = process.platform === 'win32'
        ? normalized.replace(/\\/g, '/').toLowerCase()
        : normalized.replace(/\\/g, '/');
      return pathNorm === rootNorm || pathNorm.startsWith(rootNorm.endsWith('/') ? rootNorm : rootNorm + '/');
    });
  }

  protocol.handle(CUSTOM_SCHEME, async (request) => {
    try {
      const url = new URL(request.url);
      // 只接受 graycode://local/：hostname 不校验时 graycode://evil/ 与 local 服务同一批文件
      if (url.hostname !== 'local') {
        return new Response('Forbidden', { status: 403 });
      }
      // graycode://local/<relative path from an allowed static root>
      const relPath = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      if (!relPath) return new Response('Not found', { status: 404 });
      const fsPath = path.normalize(path.join(REPO_ROOT, relPath));
      // 白名单 containment 校验（用户数据目录不在白名单内，天然被拦截）
      if (!isPathAllowed(fsPath)) {
        return new Response('Forbidden', { status: 403 });
      }
      const stat = await fs.promises.stat(fsPath);
      if (!stat.isFile()) return new Response('Not found', { status: 404 });
      const mime = MIME_BY_EXT[path.extname(fsPath).toLowerCase()];
      const cached = fileCache.get(fsPath);
      if (cached && cached.mtimeMs === stat.mtimeMs) {
        return new Response(cached.body as unknown as BodyInit, {
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
      return new Response(body as unknown as BodyInit, {
        status: 200,
        headers: { 'Content-Type': contentType }
      });
    } catch (err) {
      // 固定文案，不向渲染层泄露内部路径/错误细节
      return new Response('Internal server error', { status: 500 });
    }
  });
}

// ============================================================================
// Native operations used by the vscode shim
// ============================================================================

function registerNativeOps(): void {
  ipcMain.handle('graycode:native', (event, op: string, payload: any) => {
    // 只接受主窗口主框架的调用：渲染层被 XSS 后无法借 iframe/其它 frame 调用
    if (!isTrustedSender(event)) {
      return { ok: false, error: 'Untrusted sender' };
    }
    return runNative(op, payload, mainWindow);
  });
  setPickWorkspaceHandler(() => void pickWorkspaceFolder());
  setOpenWorkspaceHandler((fsPath) => void openWorkspaceFolder(fsPath));
}

/** IPC 发送方校验：必须是主窗口自身的主框架 */
function isTrustedSender(event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): boolean {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  const senderFrame = (event as any).senderFrame as Electron.WebFrameMain | undefined;
  if (!senderFrame) return event.sender === mainWindow.webContents;
  return senderFrame.top === senderFrame && event.sender === mainWindow.webContents;
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
  ipcMain.on('graycode:renderer-to-backend', (event, message: any) => {
    // 只接受主窗口主框架的消息（与 graycode:native 同一套发送方校验）
    if (!isTrustedSender(event)) return;
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
            // macOS 关闭全部窗口后 mainWindow 为 null / 已销毁：退化为无父窗口对话框
            // （与 native.ts 的 usableWindow 模式一致，避免 mainWindow! 抛 TypeError 崩溃）
            const w = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
            void (w
              ? dialog.showMessageBox(w, {
                type: 'info',
                title: 'About',
                message: 'GrayCode Desktop',
                detail:
                  `GrayCode AI coding assistant (standalone desktop edition)\n` +
                  `Based on GrayCode v${readRootVersion()}\n` +
                  `Electron ${process.versions.electron} / Chromium ${process.versions.chrome}`
              })
              : dialog.showMessageBox({
                type: 'info',
                title: 'About',
                message: 'GrayCode Desktop',
                detail:
                  `GrayCode AI coding assistant (standalone desktop edition)\n` +
                  `Based on GrayCode v${readRootVersion()}\n` +
                  `Electron ${process.versions.electron} / Chromium ${process.versions.chrome}`
              }));
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
    // 初始背景跟随系统深浅色，避免浅色系统下启动时深色闪烁（页面加载后由主题变量接管）
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1e1e1e' : '#ffffff',
    autoHideMenuBar: false,
    icon: path.join(REPO_ROOT, 'resources', 'icon.png'),
    title: 'GrayCode',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      // 安全基线：contextIsolation + sandbox 开启，渲染层（渲染 AI 生成的 Markdown/HTML）
      // 即使被 XSS 攻破也无法直接访问 Node/IPC；桥接全部经 preload contextBridge 白名单。
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false
    }
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  // 主题变量与 overlay UI 由主进程注入，不依赖 frontend/dist 是否被 patch-dist 处理：
  // 前端 rebuild 会覆盖 dist/index.html 导致 theme.css/overlay.js 链接丢失，
  // 一旦 CSS 变量缺失，整个 UI 会退回浏览器默认色（灰底黑字），即历史对比度 bug 根因。
  mainWindow.webContents.on('did-finish-load', () => {
    void injectDesktopRendererAssets(mainWindow!);
  });

  mainWindow.on('focus', () => {
    __setWindowFocused(true);
  });
  mainWindow.on('blur', () => {
    __setWindowFocused(false);
  });

  // 拒绝新窗口；对 http/https 链接改用系统浏览器打开（复用 native.ts 的 scheme 校验）
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:' || parsed.protocol === 'mailto:') {
        void import('electron').then(({ shell }) => shell.openExternal(url));
      }
    } catch {
      // 非法 URL 忽略
    }
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    // 严格限定 graycode://local/：前缀过宽会放行 graycode://evil/ 等 host 变体
    if (!url.startsWith(`${CUSTOM_SCHEME}://local/`)) {
      event.preventDefault();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.loadURL(`${CUSTOM_SCHEME}://local/frontend/dist/index.html`).catch((error) => {
    // 加载失败（如 graycode:// 静态资源缺失/损坏）不能让未捕获的 rejection 崩掉主进程；
    // 弹错误对话框说明后退出（与下方后端初始化失败的 M-8 模式一致）。
    console.error('Failed to load main window:', error);
    const win = mainWindow;
    if (win && !win.isDestroyed()) {
      void dialog
        .showMessageBox(win, {
          type: 'error',
          title: 'GrayCode Failed to Start',
          message: 'The main window failed to load.',
          detail: String(error?.message || error),
          buttons: ['Quit']
        })
        .finally(() => app.exit(1));
    } else {
      app.exit(1);
    }
  });

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
  // createBackend() 总在 createWindow() 之前调用，backendHost 必然已就绪；用可选链兜底
  if (backendHost) {
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
  }).catch((error) => {
    // 初始化失败（如数据目录损坏、配置解析崩溃）必须可见，不能留下 unhandled rejection + 空白窗口（M-8）
    console.error('GrayCode backend initialization failed:', error);
    if (mainWindow && !mainWindow.isDestroyed()) {
      void dialog.showMessageBox(mainWindow, {
        type: 'error',
        title: 'GrayCode Failed to Start',
        message: 'The backend failed to initialize.',
        detail: String(error?.message || error),
        buttons: ['Open Data Folder', 'Quit']
      }).then(({ response }) => {
        if (response === 0) {
          const { shell } = require('electron');
          void shell.openPath(app.getPath('userData'));
        }
        app.quit();
      });
    } else {
      app.exit(1);
    }
  });
  }
}

// ============================================================================
// App lifecycle
// ============================================================================

app.setName('GrayCode Desktop');

// ============================================================================
// 单实例锁：同一数据目录同时跑两个实例会让串行写队列交错、状态互相覆盖。
// 未获得锁的实例直接退出；重复启动时通过 second-instance 聚焦已有窗口。
// ============================================================================
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // 聚焦已有窗口（最小化则先恢复）；macOS 下窗口可能已关闭，重建一个。
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    } else if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
}

if (gotSingleInstanceLock) {
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
    // macOS 保留窗口常驻惯例：关闭窗口不退出（activate 时重建）；非 mac 走 app.quit()
    // 触发 before-quit 里的异步 dispose 流程。
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  let quitting = false;

  app.on('before-quit', (event) => {
    // 等待异步写队列排空再退出：直接 quit 会截断 JsonFileMemento/JsonConfigStore 的
    // 串行写队列与进行中的流处理，丢数据。preventDefault 后 await dispose()，
    // 10s 超时兜底（dispose 卡死也必须能退出），然后 app.exit(0) 结束进程。
    if (quitting) return;
    quitting = true;
    event.preventDefault();
    // dispose 可能同步抛错（cancelAllStreams/TaskManager 未包 try 时）：
    // 用 Promise.resolve().then 包裹，保证超时兜底与 app.exit(0) 始终可达
    const disposeDone = backendHost
      ? Promise.resolve().then(() => backendHost!.dispose())
      : Promise.resolve();
    void Promise.race([
      disposeDone,
      new Promise<void>((resolve) => setTimeout(resolve, 10_000))
    ]).catch(() => {
      // dispose 抛错不阻塞退出
    }).finally(() => {
      app.exit(0);
    });
  });
}
