/**
 * main.ts - GrayCode Desktop (Electron main process)
 *
 * Hosts the full GrayCode backend (bundled with the `vscode` import aliased to
 * our shim) and serves the existing Vue frontend from frontend/dist over a
 * custom `graycode://` protocol (so fetch()/audio work without CORS issues).
 */

import { app, BrowserWindow, Menu, dialog, ipcMain, protocol, nativeTheme, powerMonitor } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
// BackendHost 体积大（内联整个 backend + webview 路由），启动路径必须懒加载：
// createBackend 内动态 import('./host/BackendHost.js')，让 when-ready 之前只解析
// 轻量主进程壳（main/native/protocol/vscode-shim），后端初始化在窗口创建后并行进行。
// 此处仅保留类型导入（编译期擦除，不产生运行时依赖）。
import type { BackendHost } from './host/BackendHost.js';
import { runNative, setPickWorkspaceHandler, setOpenWorkspaceHandler } from './native';
import { backfillPortableExecutableDir, persistPortableHomePointer } from './portable-home.js';
import { menuLabel, resolveMenuLang, type MenuLang } from './menu-i18n.js';
import { Logger, LogLevel } from '../../backend/core/logger';
// esbuild 把 vscode-shim 打成独立共享包（dist/vscode-shim.js，主进程壳与 BackendHost 共用同一实例）；
// 此处的具名导入会被静态解析，不能使用 require('./vscode-shim')（打包产物中不存在该独立文件，
// 运行时会抛 MODULE_NOT_FOUND）。
import { __setWindowFocused } from './vscode-shim.js';

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
// 脱敏：错误对象可能携带请求体/配置（含 apiKey 字段）上下文，只输出 message + 截断的堆栈，
// 并遮蔽常见密钥字段，防止敏感信息进入日志管道。
const SECRET_FIELD_RE = /(api[_-]?key|authorization|password|token|secret|credential)/i;

function redactSecrets(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[depth-limit]';
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: String(value.stack || '').split('\n').slice(0, 8).join('\n') };
  }
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((v) => redactSecrets(v, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_FIELD_RE.test(k)) {
      out[k] = typeof v === 'string' && v.length > 4 ? v.slice(0, 2) + '***' + v.slice(-1) : '[redacted]';
    } else if (typeof v === 'string' && v.length > 500) {
      out[k] = v.slice(0, 500) + '...';
    } else {
      out[k] = redactSecrets(v, depth + 1);
    }
  }
  return out;
}

function formatUnhandledRejection(reason: unknown): string {
  try {
    return JSON.stringify(redactSecrets(reason), null, 2).slice(0, 2000);
  } catch {
    return typeof reason === 'string' ? reason.slice(0, 2000) : String(reason).slice(0, 2000);
  }
}

process.on('unhandledRejection', (reason) => {
  console.error('[main] unhandled rejection:', formatUnhandledRejection(reason));
});

// 未捕获异常保护：事件监听器内抛错、同步异常漏网之鱼等都会走这里，直接崩掉主进程
// 会截断写队列丢数据。记录完整堆栈后弹错误对话框，用户可选择「重启」或「退出」，
// 模式与 loadURL 失败（M-7）及 backend 初始化失败（M-8）的既有处理一致。
// EPIPE 在 installStdioEpipeGuard 内已静默吞掉，不走到这里；非 EPIPE 流错误与
// 其它异常一样会弹窗（行为更明确，且不再触发 Electron 默认的崩溃弹窗）。
process.on('uncaughtException', (error) => {
  console.error('[main] uncaught exception:', error);
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  const options: Electron.MessageBoxOptions = {
    type: 'error',
    title: 'GrayCode Crashed',
    message: 'An unexpected error occurred.',
    detail: redactSecrets(String(error?.stack || error?.message || error)) as string,
    buttons: ['Restart', 'Quit'],
    cancelId: 1
  };
  try {
    void (win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options)).then(({ response }) => {
      if (response === 0) app.relaunch();
      app.exit(1);
    });
  } catch {
    // 对话框本身失败（极端情况下 UI 线程已不可用）也必须退出，不能悬挂
    app.exit(1);
  }
});

const REPO_ROOT = process.env.GRAYCODE_REPO_ROOT || path.resolve(__dirname, '..', '..');
const CUSTOM_SCHEME = 'graycode';

// 启动阶段计时（GRAYCODE_DIAG=1 时输出各里程碑耗时到 stdout，与 BackendHost.markInitStage 配套）
const MAIN_STARTED_AT = performance.now();
function diagLog(stage: string): void {
  if (process.env.GRAYCODE_DIAG === '1') {
    console.log(`[startup] main ${stage} at +${Math.round(performance.now() - MAIN_STARTED_AT)}ms`);
  }
}

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
    // 全部数据写进临时目录并随退出丢失（每次启动都是"全新应用"，更新后也无法保留数据）。
    // 必须改用启动器注入的 PORTABLE_EXECUTABLE_DIR（便携 exe 实际所在目录）。
    const portableDir = process.env.PORTABLE_EXECUTABLE_DIR;
    if (portableDir) {
      const portableDataDir = path.join(path.resolve(portableDir), 'data');
      // 与安装版分支同一套只读探测：便携 exe 位于只读介质（U 盘/网络共享/受限权限目录）
      // 时数据目录不可写，若直接使用会静默丢全部会话/设置/记忆——回退系统 AppData。
      if (probeWritable(portableDataDir)) {
        return portableDataDir;
      }
      // 回退目录与安装版的 AppData/GrayCode 分开：两者同时存在时不互相串写数据，
      // 也不因共享 userData 而互相占用单实例锁
      const portableFallbackDir = path.join(app.getPath('appData'), 'GrayCodePortable');
      console.warn(
        `[main] portable data dir is not writable (${portableDataDir}), falling back to ${portableFallbackDir}`
      );
      return portableFallbackDir;
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
// 任务栏固定等场景下 explorer 直接启动解压缓存里的内层 exe（拿不到启动器注入的
// PORTABLE_EXECUTABLE_DIR），先从 gc-portable-home 指针找回外层目录再解析数据目录
// （详见 portable-home.ts）；正常经启动器启动时环境变量已存在，本调用为空操作。
const portableExeDir = path.dirname(app.getPath('exe'));
if (backfillPortableExecutableDir(portableExeDir, process.env)) {
  console.log(`[main] recovered portable home from cache: ${process.env.PORTABLE_EXECUTABLE_DIR}`);
}
persistPortableHomePointer(portableExeDir, process.env.PORTABLE_EXECUTABLE_DIR);
app.setPath('userData', resolveUserDataDir());

Logger.setLevel(LogLevel.INFO);

let mainWindow: BrowserWindow | null = null;
let backendHost: BackendHost | null = null;

// ===== 电源/冻结防御（Windows 空闲挂起：前端壳无响应而后端正常） =====
// powerMonitor 监听只注册一次（macOS activate 重建窗口时跳过重复注册）；
// rendererProbeTimer/rendererProbeFailures 为渲染进程健康自检探针状态。
let powerMonitorListenersInstalled = false;
let rendererProbeTimer: NodeJS.Timeout | null = null;
let rendererProbeFailures = 0;

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
    // 原子写：先写同目录 .tmp 临时文件再 rename 覆盖，崩溃/断电不会留下半截 JSON
    // 导致下次启动 loadWorkspaceState 解析失败（与 vscode-shim JsonConfigStore/
    // JsonFileMemento 的既有策略一致）。Windows 上 rename 目标已存在时会直接替换。
    const file = workspaceStateFile();
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ folders }, null, 2), 'utf-8');
    fs.renameSync(tmp, file);
  } catch (err) {
    console.error('Failed to persist workspace state:', err);
  }
}

async function setWorkspaceFolders(folders: string[]): Promise<void> {
  saveWorkspaceState(folders);
  backendHost?.setWorkspaceFolders(folders);
  if (mainWindow) {
    // 窗口标题本地化：无工作区时的占位文案随界面语言（menu-i18n 字典），
    // 有工作区时显示文件夹名（用户路径，不做翻译）。
    const label = folders.length > 0 ? path.basename(folders[0]) : menuLabel('windowTitleNoWorkspace', currentMenuLang);
    mainWindow.setTitle(`GrayCode \u2014 ${label}`);
  }
}

async function pickWorkspaceFolder(): Promise<void> {
  // 窗口可能已销毁（关闭竞态）：isDestroyed 的窗口传给 dialog 会抛 "Object has been destroyed"
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: menuLabel('pickFolderTitle', currentMenuLang),
    buttonLabel: menuLabel('pickFolderButton', currentMenuLang),
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
    // codicons 图标字体：dist 重建会冲掉 patch-dist.mjs 注入的 <link>，
    // 与 theme.css 同策略改为运行时注入；相对字体 URL 必须改写成绝对 graycode:// URL，
    // 否则会相对页面路径解析（graycode://local/frontend/dist/codicon.ttf）导致字体 404、图标全丢
    const codiconCssPath = path.join(REPO_ROOT, 'resources', 'codicons', 'codicon.css');
    const overlayPath = findRendererAsset('overlay.js');

    // 三类注入互不依赖（insertedCssKeys 按 keyName 分键），并行执行省两次跨进程 IPC 往返
    const [themeCss, codiconCss, overlayJs] = await Promise.all([
      themePath ? fs.promises.readFile(themePath, 'utf-8') : Promise.resolve(null),
      fs.existsSync(codiconCssPath)
        ? fs.promises.readFile(codiconCssPath, 'utf-8').then((css) => css.replace(
          /url\(\s*(['"]?)(\.\/[^)'"]+)\1\s*\)/g,
          (_match, quote, relPath) => {
            const absolute = `graycode://local/resources/codicons/${relPath.replace(/^\.\//, '')}`;
            return `url(${quote}${absolute}${quote})`;
          }
        ))
        : Promise.resolve(null),
      overlayPath ? fs.promises.readFile(overlayPath, 'utf-8') : Promise.resolve(null)
    ]);

    // 三类注入互不依赖（insertedCssKeys 按 keyName 分键），并行注入省两次跨进程 IPC 往返
    await Promise.all([
      themeCss !== null
        ? insertCssOnce(win, themeCss, 'theme')
        : Promise.resolve(console.warn('[main] theme.css not found; UI will fall back to browser defaults')),
      codiconCss !== null
        ? insertCssOnce(win, codiconCss, 'codicons')
        : Promise.resolve(),
      overlayJs !== null
        ? win.webContents.executeJavaScript(overlayJs, false).catch((err) => {
          console.warn('[main] overlay.js injection failed:', err);
        })
        : Promise.resolve()
    ]);
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
      // 缓存命中校验 mtime：资源在运行期可能被替换（便携版覆盖更新、用户手动覆盖），
      // 不一致则丢弃缓存条目并按 miss 重新读取，避免返回过期内容
      const cached = fileCache.get(fsPath);
      if (cached) {
        let mtimeValid = false;
        try {
          const cachedStat = await fs.promises.stat(fsPath);
          mtimeValid = cachedStat.mtimeMs === cached.mtimeMs;
        } catch {
          mtimeValid = false;
        }
        if (mtimeValid) {
          // LRU 刷新：命中项先删后设、移到 Map 末尾（最新位置），避免热点大 bundle
          // 被后续小资源挤到淘汰位反复读盘（与 BackendHost.diffPreviewContents 同策略）
          fileCache.delete(fsPath);
          fileCache.set(fsPath, cached);
          return new Response(cached.body as unknown as BodyInit, {
            status: 200,
            headers: { 'Content-Type': cached.mime }
          });
        }
        fileCache.delete(fsPath);
      }
      const stat = await fs.promises.stat(fsPath);
      if (!stat.isFile()) return new Response('Not found', { status: 404 });
      const mime = MIME_BY_EXT[path.extname(fsPath).toLowerCase()];
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

/**
 * 渲染层可调用的 native op 白名单（收口 attack surface）：
 * 前端全仓库仅 overlay.js 使用 workspace:pickFolder；dialog/shell/clipboard/fs
 * 等其余 op 只经主进程内 host.native（BackendHost 直连 runNative）被 shim 使用，
 * 渲染层无需也不应触达——渲染层渲染 AI 生成的 HTML，一旦 XSS 失守，
 * 白名单外的 op（剪贴板读写、任意路径探测、shell 打开）不可达。
 */
const RENDERER_ALLOWED_NATIVE_OPS = new Set<string>(['workspace:pickFolder']);

function registerNativeOps(): void {
  ipcMain.handle('graycode:native', (event, op: string, payload: any) => {
    // 只接受主窗口主框架的调用：渲染层被 XSS 后无法借 iframe/其它 frame 调用
    if (!isTrustedSender(event)) {
      return { ok: false, error: 'Untrusted sender' };
    }
    // op 白名单：白名单外的 op 直接拒绝（返回错误，不抛异常，避免渲染层崩溃）
    if (typeof op !== 'string' || !RENDERER_ALLOWED_NATIVE_OPS.has(op)) {
      return { ok: false, error: 'Forbidden native op' };
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

  // 懒加载后端宿主：BackendHost 及其内联的 backend/webview 代码从主进程壳中拆出
  // （build.mjs 三包拆分：main.js / host/BackendHost.js / vscode-shim.js），
  // 启动路径不再解析/执行 ~1.2MB 后端代码，when-ready 与窗口首帧提前。
  void import('./host/BackendHost.js').then(({ BackendHost: BackendHostCtor }) => {
    if (backendHost) return;

    backendHost = new BackendHostCtor({
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
      },
      // 渲染层 UI 语言生效后重建应用菜单（含 auto 解析后的实际语言）
      onMenuLanguageChange: (lang) => rebuildMenu(lang),
      // 渲染层主题生效后同步原生窗口背景色与 nativeTheme（含 auto 解析后的实际主题）
      onThemeChange: (theme) => applyDesktopThemeToWindow(theme),
      // 界面语言为 auto/未配置时的系统 locale 回退（app.getLocale）
      systemLocale: () => app.getLocale()
    });

    // 工作区恢复必须在 backendHost 就绪后执行（懒加载就绪前 createWindow 里
    // backendHost 仍为 null，放这里保证恢复只跑一次、且早于渲染层 splashDone）。
    restoreWorkspace();

    // 补投懒加载窗口期内到达的渲染层消息（窗口可能在 BackendHost 就绪前完成加载）
    const queued = pendingRendererMessages.splice(0);
    for (const message of queued) {
      void backendHost.handleRendererMessage(message);
    }
  }).catch((error) => {
    // 懒加载失败（chunk 缺失/损坏）必须可见，不能静默挂起（消息缓冲会无限堆积）
    console.error('[main] failed to lazy-load backend host:', error);
    const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
    void (win ? dialog.showMessageBox(win, {
      type: 'error',
      title: 'GrayCode Failed to Start',
      message: 'The backend failed to load.',
      detail: String(error?.message || error),
      buttons: ['Quit']
    }) : dialog.showMessageBox({
      type: 'error',
      title: 'GrayCode Failed to Start',
      message: 'The backend failed to load.',
      detail: String(error?.message || error),
      buttons: ['Quit']
    })).then(() => app.exit(1)).catch(() => app.exit(1));
  });
}

/** BackendHost 懒加载就绪前到达的渲染层消息（窗口先于后端加载完成时排队，就绪后补投） */
const pendingRendererMessages: unknown[] = [];
/** 懒加载窗口期内消息缓冲上限：防止后端加载失败（弹窗等待用户确认）期间无限堆积内存 */
const PENDING_MESSAGES_MAX = 200;
/** 缓冲满丢弃统计（限频告警用） */
let pendingDrops = 0;
let lastPendingDropLogAt = 0;

// 消息入口注册一次（不放在 createWindow 内，避免 macOS activate 重建窗口时重复注册，
// 导致每条渲染层消息被处理两次）。同一窗口内的所有消息都走同一个入口。
ipcMain.on('graycode:renderer-to-backend', (event, message: any) => {
  // 只接受主窗口主框架的消息（与 graycode:native 同一套发送方校验）
  if (!isTrustedSender(event)) return;
  if (backendHost) {
    void backendHost.handleRendererMessage(message);
  } else if (pendingRendererMessages.length < PENDING_MESSAGES_MAX) {
    pendingRendererMessages.push(message);
  } else {
    // 缓冲区已满：静默丢弃会让对应前端请求悬挂到超时且无排障线索——限频告警
    if (pendingDrops++ === 0 || Date.now() - lastPendingDropLogAt > 5000) {
      lastPendingDropLogAt = Date.now();
      console.warn(`[main] pending renderer message buffer full (${PENDING_MESSAGES_MAX}), dropping type=${String(message?.type || '?')}`);
    }
  }
});

// ============================================================================
// Window + menu
// ============================================================================

/** 当前菜单语言（buildMenu 时写入，供 pickWorkspaceFolder 等对话框复用） */
let currentMenuLang: MenuLang = 'en';

/**
 * 读取设置文件里的界面语言（启动时后端尚未就绪，直接读 vscode-config.json）。
 * 设置文件不存在/损坏时返回空串，由调用方回退系统 locale。
 */
function readUiLanguageFromDisk(): string {
  try {
    const file = path.join(app.getPath('userData'), 'graycode', 'settings', 'vscode-config.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const lang = raw?.graycode?.ui?.language;
    if (typeof lang === 'string' && lang) return lang;
  } catch {
    // 首次启动或设置文件尚未写入：回退系统 locale
  }
  return '';
}

/** 解析当前界面语言：设置项优先，'auto'/未配置时跟随系统 locale */
function resolveUiLanguage(): MenuLang {
  const saved = readUiLanguageFromDisk();
  if (saved && saved !== 'auto') return resolveMenuLang(saved);
  return resolveMenuLang(app.getLocale());
}

/** 渲染层上报语言变更后重建菜单（更新菜单文案，不重启窗口） */
function rebuildMenu(lang: string): void {
  buildMenu(lang);
}

function buildMenu(lang?: string): void {
  const L = resolveMenuLang(lang || currentMenuLang);
  currentMenuLang = L;
  const isMac = process.platform === 'darwin';
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: menuLabel('menuFile', L),
      submenu: [
        {
          label: menuLabel('openWorkspaceFolder', L),
          accelerator: 'CmdOrCtrl+O',
          click: () => void pickWorkspaceFolder()
        },
        { type: 'separator' },
        { role: 'reload', label: menuLabel('reload', L) },
        { role: 'forceReload', label: menuLabel('forceReload', L) },
        ...(isMac ? [] : [{ type: 'separator' as const }, { role: 'quit' as const, label: menuLabel('exit', L) }])
      ]
    },
    {
      label: menuLabel('menuEdit', L),
      submenu: [
        { role: 'undo', label: menuLabel('undo', L) },
        { role: 'redo', label: menuLabel('redo', L) },
        { type: 'separator' },
        { role: 'cut', label: menuLabel('cut', L) },
        { role: 'copy', label: menuLabel('copy', L) },
        { role: 'paste', label: menuLabel('paste', L) },
        { role: 'selectAll', label: menuLabel('selectAll', L) }
      ]
    },
    {
      label: menuLabel('menuView', L),
      submenu: [
        { role: 'togglefullscreen', label: menuLabel('toggleFullScreen', L) },
        { type: 'separator' },
        { role: 'toggleDevTools', label: menuLabel('developerTools', L) }
      ]
    },
    {
      label: menuLabel('menuHelp', L),
      submenu: [
        {
          label: menuLabel('about', L),
          click: () => {
            // macOS 关闭全部窗口后 mainWindow 为 null / 已销毁：退化为无父窗口对话框
            // （与 native.ts 的 usableWindow 模式一致，避免 mainWindow! 抛 TypeError 崩溃）
            const w = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
            const detail = menuLabel('aboutDetail', L)
              .replace('{version}', readRootVersion())
              .replace('{electron}', process.versions.electron)
              .replace('{chromium}', process.versions.chrome);
            const options: Electron.MessageBoxOptions = {
              type: 'info',
              title: menuLabel('aboutTitle', L),
              message: menuLabel('aboutMessage', L),
              detail
            };
            void (w ? dialog.showMessageBox(w, options) : dialog.showMessageBox(options));
          }
        }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ============================================================================
// Workspace restore
// ============================================================================

// 注：createBackend 的懒加载意味着 createWindow 执行时 backendHost 可能还是 null，
// 恢复必须放在 BackendHost 就绪之后（见 createBackend 内的 restoreWorkspace() 调用），
// 放在 createWindow 内会因为 backendHost 为 null 而静默跳过。
function restoreWorkspace(): void {
  const host = backendHost;
  if (!host) return;
  void host.ready.then(() => {
    diagLog('backend-ready');
    // 工作区行为 'none'（不打开任何工作区）：跳过恢复，也不发「未打开工作区」提示
    // （用户显式选择不打开，启动提示只会造成打扰；BackendHost 侧同样跳过）。
    if (host.getWorkspaceBehavior() === 'none') {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.setTitle(`GrayCode \u2014 ${menuLabel('windowTitleNoWorkspace', currentMenuLang)}`);
      }
      return;
    }
    const folders = filterExistingFolders(loadWorkspaceState());
    if (folders.length > 0) {
      void setWorkspaceFolders(folders);
    } else if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setTitle(`GrayCode \u2014 ${menuLabel('windowTitleNoWorkspace', currentMenuLang)}`);
      // 「未打开工作区」提示统一由 BackendHost 在渲染层开场动画结束后发送
      // （webviewReady 握手路径，重查工作区状态 + 本地化文案 + 动画门控），
      // 此处不再重复发送，避免与握手路径双弹。
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
      }).then(async ({ response }) => {
        if (response === 0) {
          const { shell } = await import('electron');
          void shell.openPath(app.getPath('userData'));
        }
        app.quit();
      });
    } else {
      app.exit(1);
    }
  });
}

// ============================================================================
// 主题（亮色/暗色/跟随系统）→ 原生窗口
//
// 渲染层 CSS 变量负责界面配色；这里负责原生部分：BrowserWindow 背景色
// （启动/加载/resize 露出的边缘）与 nativeTheme.themeSource（系统对话框、
// 原生菜单、渲染层 prefers-color-scheme——首帧启动画面与 auto 模式 matchMedia
// 都依赖它）。设置持久化在 {userData}/graycode/settings/vscode-config.json
// （BackendHost __initConfigStore 同路径），启动时同步预读，免首帧闪烁。
// ============================================================================
function resolveSavedTheme(): string {
  try {
    const raw = fs.readFileSync(
      path.join(app.getPath('userData'), 'graycode', 'settings', 'vscode-config.json'),
      'utf-8'
    );
    const parsed = JSON.parse(raw) as { ui?: { theme?: unknown } };
    const theme = parsed?.ui?.theme;
    if (theme === 'light' || theme === 'dark') return theme;
  } catch {
    // 文件不存在/损坏：回退 auto（跟随系统）
  }
  return 'auto';
}

/** 窗口背景色：与 theme.css 的 --vscode-editor-background（dark #1e1e1e / light #ffffff）一致 */
function resolveWindowBackgroundColor(): string {
  return nativeTheme.shouldUseDarkColors ? '#1e1e1e' : '#ffffff';
}

/**
 * 应用主题 → nativeTheme.themeSource + 窗口背景色。
 * themeSource 同步后渲染层 prefers-color-scheme 跟随（auto 模式下 matchMedia
 * change 事件触发渲染层重新应用）；窗口背景色实时更新（页面加载中/重载瞬间生效）。
 */
function applyDesktopThemeToWindow(theme: string): void {
  nativeTheme.themeSource = theme === 'light' || theme === 'dark' ? theme : 'system';
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setBackgroundColor(resolveWindowBackgroundColor());
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 620,
    show: false,
    // 初始背景跟随应用主题（预读设置文件；读取失败时按系统深浅色兜底），
    // 页面加载后由渲染层 app.setTheme 上报实时同步（见 applyDesktopThemeToWindow）
    backgroundColor: resolveWindowBackgroundColor(),
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
      backgroundThrottling: false,
      // 应用不做拼写检查：关闭可省渲染进程拼写词典初始化开销（启动提速）
      spellcheck: false
    }
  });

  mainWindow.once('ready-to-show', () => {
    diagLog('window-shown');
    mainWindow?.show();
  });

  // 主题变量与 overlay UI 由主进程注入，不依赖 frontend/dist 是否被 patch-dist 处理：
  // 前端 rebuild 会覆盖 dist/index.html 导致 theme.css/overlay.js 链接丢失，
  // 一旦 CSS 变量缺失，整个 UI 会退回浏览器默认色（灰底黑字），即历史对比度 bug 根因。
  mainWindow.webContents.on('did-finish-load', () => {
    diagLog('did-finish-load');
    // 兜底移除首帧静态启动画面：正常路径 Vue 挂载时（App.vue/Splash.vue）已移除，
    // 这里防渲染层脚本加载失败等场景下 #gc-boot 残留（与启动画面 z-index 9998 无冲突）
    mainWindow?.webContents.executeJavaScript('document.querySelector(\'#gc-boot\')?.remove()', true)
      .catch(() => undefined);
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

  // 渲染进程「冻结」（非崩溃）检测：Windows 电源事件（睡眠/Modern Standby/显示器关闭/
  // 效率模式）可能挂起渲染进程线程——主进程与后端仍正常，但界面完全无响应，且
  // render-process-gone 不会触发（进程没死）。冻结 5s 后自动 reload 恢复；
  // 与崩溃计数（rendererCrashCount）分开，冻结恢复不参与「连续崩溃弹对话框」判定。
  let frozenReloadTimer: NodeJS.Timeout | null = null;
  mainWindow.webContents.on('unresponsive', () => {
    console.error('[main] renderer unresponsive (frozen), auto-reload scheduled in 5s');
    if (frozenReloadTimer !== null) clearTimeout(frozenReloadTimer);
    frozenReloadTimer = setTimeout(() => {
      frozenReloadTimer = null;
      if (mainWindow && !mainWindow.isDestroyed()) {
        console.error('[main] renderer still frozen after 5s, auto reloading');
        mainWindow.webContents.reload();
      }
    }, 5000);
  });
  mainWindow.webContents.on('responsive', () => {
    if (frozenReloadTimer !== null) {
      clearTimeout(frozenReloadTimer);
      frozenReloadTimer = null;
      console.error('[main] renderer responsive again');
    }
  });
  mainWindow.on('closed', () => {
    if (frozenReloadTimer !== null) clearTimeout(frozenReloadTimer);
  });

  // 渲染进程崩溃处理：记录崩溃原因后先自动 reload 恢复（最多 2 次）；若仍连续崩溃
  // （确定性崩溃 reload 也救不回来），改弹错误对话框由用户选择「重载」或「退出」，
  // 避免无限 reload 循环（计数不随 did-finish-load 重置，防刷屏式崩溃自愈假象）。
  let rendererCrashCount = 0;
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('[main] renderer process gone:', details?.reason, 'exitCode=' + details?.exitCode);
    rendererCrashCount++;
    if (rendererCrashCount <= 2) {
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.reload();
        }
      }, 300);
      return;
    }
    const win = mainWindow;
    const options: Electron.MessageBoxOptions = {
      type: 'error',
      title: 'GrayCode Interface Crashed',
      message: 'The interface crashed repeatedly.',
      detail: `Reason: ${details?.reason || 'unknown'} (exit code: ${details?.exitCode ?? 'n/a'})`,
      buttons: ['Reload', 'Quit'],
      cancelId: 1
    };
    void (win && !win.isDestroyed() ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options))
      .then(({ response }) => {
        if (response === 0) {
          if (win && !win.isDestroyed()) win.webContents.reload();
        } else {
          app.quit();
        }
      })
      .catch(() => undefined);
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
          // 测试钩子：GRAYCODE_UISMOKE_WORKSPACE=<dir> 在 smoke 开始前打开一个工作区，
          // 让 workspaceSelector 步骤能验证「点击打开的工作区 → 激活工作区跟随」。
          const smokeWs = process.env.GRAYCODE_UISMOKE_WORKSPACE;
          if (smokeWs && mainWindow && !mainWindow.isDestroyed()) {
            await setWorkspaceFolders([smokeWs]);
            await new Promise((r) => setTimeout(r, 1500));
          }
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
              bodyText: document.body.innerText.slice(0, 600),
              wsLabel: (document.querySelector('.ws-label') || {}).innerText || null,
              wsLabelLate: await (async () => {
                await new Promise((r) => setTimeout(r, 1500));
                return (document.querySelector('.ws-label') || {}).innerText || null;
              })(),
              docLang: document.documentElement.lang,
              langToggleLabel: (document.querySelector('.lang-toggle') || {}).innerText || null,
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

            // workspace selector dropdown (top-right): open the menu, click an
            // open-workspace item (or auto when none), then verify the store's
            // active workspace follows the click. Regression guard for the
            // 1.7.3 "dropdown cannot switch workspace" fix.
            await step('workspaceSelector', async () => {
              const back = document.querySelector('.settings-close-btn');
              if (back) back.click();
              await sleep(300);
              const storeProbe = () => {
                const app = document.querySelector('#app')?.__vue_app__;
                const pinia = app?.config?.globalProperties?.$pinia;
                const chat = pinia?._s?.get('chat');
                if (!chat) return null;
                return {
                  currentWorkspaceUri: chat.currentWorkspaceUri,
                  workspaceCount: chat.workspaceList?.length ?? -1,
                  savedCount: chat.savedWorkspaces?.length ?? -1,
                  currentConversationId: chat.currentConversationId
                };
              };
              const before = storeProbe();
              const trigger = document.querySelector('.ws-selector');
              if (!trigger) return { found: false, reason: 'no .ws-selector trigger', before };
              trigger.click();
              await sleep(250);
              const menu = document.querySelector('.ws-menu');
              if (!menu) return { found: true, menu: 'menu did not open', before };
              const itemTexts = [...menu.querySelectorAll('.ws-menu-item')].map((e) => (e.innerText || '').trim().slice(0, 40));
              // click the first open-workspace item; fall back to auto when none.
              // 排除底部动作条目（打开工作区文件夹）与收藏（带移除按钮）
              const isAuto = (e) => /auto|跟随/i.test(e.innerText || '');
              const isAction = (e) => e.classList.contains('ws-menu-action');
              const isSaved = (e) => !!e.querySelector('.ws-item-remove');
              const isLocked = (e) => !!e.querySelector('.ws-locked-item') || e.classList.contains('ws-locked-item');
              const target = [...menu.querySelectorAll('.ws-menu-item')].find((e) => !isAuto(e) && !isAction(e) && !isSaved(e) && !isLocked(e));
              const targetLabel = target ? (target.innerText || '').trim().slice(0, 40) : '(auto)';
              if (target) {
                target.click();
              } else {
                const auto = [...menu.querySelectorAll('.ws-menu-item')].find(isAuto);
                if (auto) auto.click();
              }
              await sleep(500);
              const after = storeProbe();
              const expectedUri = before && before.workspaceCount > 0
                ? (() => {
                    const app = document.querySelector('#app')?.__vue_app__;
                    const pinia = app?.config?.globalProperties?.$pinia;
                    return pinia?._s?.get('chat')?.workspaceList?.[0]?.uri ?? null;
                  })()
                : null;
              return {
                found: true,
                menuItems: itemTexts.slice(0, 12),
                clicked: targetLabel,
                menuClosedAfterClick: !document.querySelector('.ws-menu'),
                // 点击打开的工作区条目后，激活工作区应跟随到该条目（非 null）
                followedOpenItem: expectedUri ? after.currentWorkspaceUri === expectedUri : null,
                before,
                after
              };
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
      // 第二次双击可能发生在首个实例完全就绪之前（便携版解压慢时最常见）：
      // 此时 createWindow 会在 app ready 前抛错、协议也尚未注册，必须等 whenReady；
      // 回调执行时再复查一次窗口，避免连续两次双击排队创建出两个窗口。
      void app.whenReady().then(() => {
        if (!mainWindow || mainWindow.isDestroyed()) createWindow();
      });
    }
  });
}

if (gotSingleInstanceLock) {
  if (process.env.GRAYCODE_E2E === '1') {
    app.whenReady().then(async () => {
      const { runE2E } = await import('./e2e');
      await runE2E();
    }).catch((err) => {
      // 兜底退出：e2e 内部异常（如动态导入失败）未走 process.exit 时，这里必须以
      // 失败状态码收尾，否则无窗口的 Electron 进程会一直挂着拖死 CI。
      console.error('[main] e2e run failed:', err);
      app.exit(1);
    });
  } else if (process.env.GRAYCODE_MONITOR_SMOKE === '1') {
    app.whenReady().then(async () => {
      const { runMonitorSmoke } = await import('./monitor-smoke');
      await runMonitorSmoke();
    }).catch((err) => {
      console.error('[main] monitor smoke run failed:', err);
      app.exit(1);
    });
  } else {
    app.whenReady().then(() => {
      diagLog('when-ready');
      registerCustomProtocol();
      registerNativeOps();
      buildMenu(resolveUiLanguage());
      // 主题在窗口创建前落地：首帧启动画面（boot-splash 的 prefers-color-scheme
      // 媒体查询）与 BrowserWindow 背景色随应用主题而非系统，避免亮色主题下深色首帧
      applyDesktopThemeToWindow(resolveSavedTheme());
      createBackend();
      createWindow();

      // ===== 电源事件恢复 + 渲染进程健康自检（Windows 空闲挂起防御） =====
      // 症状：空闲太久（显示器关闭/Modern Standby/锁屏/效率模式）后前端壳无响应，后端正常——
      // Windows 会冻结渲染进程线程并丢失 GPU 合成上下文，恢复后界面不重绘且输入无效。
      // 三层防御：
      //  1) powerMonitor resume/lock-screen/unlock-screen → 强制合成重绘 + 通知前端重排；
      //  2) 30s 周期 executeJavaScript 探针 → 无电源事件（仅进程被挂起）时也能发现并自动 reload；
      //  3) webContents unresponsive → 5s 自动 reload（见 createWindow，冻结兜底）。
      if (!powerMonitorListenersInstalled) {
        powerMonitorListenersInstalled = true;
        const reviveRenderer = () => {
          rendererProbeFailures = 0;
          if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
          // 强制合成器重绘（GPU 上下文丢失后恢复）
          mainWindow.webContents.invalidate();
          // 通知前端重排：CustomScrollbar 监听 window resize → 重算滚动条与布局；
          // 消息列表/虚拟窗口同步刷新（命令信封与 BackendHost 推送格式一致）
          mainWindow.webContents.send('graycode:backend-to-renderer', {
            type: 'command',
            command: 'host.powerResume',
            data: {}
          });
        };
        powerMonitor.on('resume', () => {
          diagLog('power-resume');
          reviveRenderer();
        });
        // Windows 锁屏/解锁（睡眠常伴随锁屏；解锁恢复时同样需要 revive）
        powerMonitor.on('lock-screen', () => diagLog('power-lock'));
        powerMonitor.on('unlock-screen', () => {
          diagLog('power-unlock');
          reviveRenderer();
        });
      }
      // 渲染进程健康探针：executeJavaScript 必须由渲染进程执行才能 resolve；
      // 线程被系统挂起时 2s 超时 → 连续 2 次判定冻结 → 自动 reload（无需用户交互）。
      if (rendererProbeTimer === null) {
        rendererProbeTimer = setInterval(() => {
          if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
          const wc = mainWindow.webContents;
          // 页面加载中不探测（避免误报）；冻结后 reload 是自愈手段，探针本身无副作用
          if (wc.isLoading()) return;
          void Promise.race([
            wc.executeJavaScript('1', true).then(() => true).catch(() => false),
            new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2000))
          ]).then((ok) => {
            if (!ok) {
              rendererProbeFailures++;
              if (rendererProbeFailures >= 2) {
                rendererProbeFailures = 0;
                console.error('[main] renderer frozen (probe failed twice), auto reloading');
                if (mainWindow && !mainWindow.isDestroyed()) {
                  mainWindow.webContents.reload();
                }
              }
            } else {
              rendererProbeFailures = 0;
            }
          });
        }, 30_000);
      }

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
    if (quitting) {
      // 首次触发已 preventDefault 进入异步 dispose（最长 10s 排空写队列），
      // 此间再次触发的 before-quit 若放行默认退出流程，可能先于 dispose 完成截断
      // 串行写队列丢数据；继续 preventDefault，统一由首次触发的 app.exit(0) 收尾。
      event.preventDefault();
      return;
    }
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
      if (rendererProbeTimer !== null) {
        clearInterval(rendererProbeTimer);
        rendererProbeTimer = null;
      }
      app.exit(0);
    });
  });
}
