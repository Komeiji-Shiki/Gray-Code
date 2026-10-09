import { showDesktopConfirmation, showDesktopProgress, type DesktopProgress } from './desktopDialog';
import { createIdleCloseCheck } from './idleClose';
import { DesktopSaveAll } from './saveAll';
import { recoverStartup } from './startupRecovery';
const desktopSaveAll = new DesktopSaveAll();
import { DesktopWindowState, restoreWindowBounds } from './windowState';
import { t, getActualLanguage } from '../../../backend/i18n';
import { DesktopUpdates } from './updates';
import { DesktopInstaller, confirmInstalledRecovery } from './installer';
import { DesktopStorageLocation } from './storageLocation';
import { DesktopPortableProfile, portableProfileDirectory } from './portableProfile';
import { ApplicationBackups } from '../../server/src/backups/service';
import { BackupRestoreState } from '../../server/src/backups/restore';
import { desktopNotifications } from './notifications';
import { activateDesktopWindow } from './windowActivation';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  net,
  protocol,
  safeStorage,
  shell,
  session,
  screen,
  Tray,
} from "electron";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PlatformApplication } from "../../server/src/application";
import { ApplicationRouter } from "../../server/src/transport/router";
import { DesktopBrowser } from "./browser";
import { DesktopComputerCapture } from './computerCapture';
import { DesktopPetWindow } from './petWindow';
import { migrateLegacySettings } from './legacySettings';
import { backfillPlaceholderTitles } from '../../server/src/conversations/autoTitles';
import { RemoteAccessService } from '../../server/src/transport/remoteAccess';
import { DesktopOpenFiles, desktopFileArguments, openDesktopPath } from './openFiles';
import { DesktopEditorRegistration } from './editorRegistration';
import { bindDesktopAppearance } from './appearance';
import { resolveAppearancePalette } from '../../../shared/appearance';
import { isTrustedApplicationFrame } from './trustedFrame';
import { desktopRpcReply } from '../../../shared/desktopBridge';
import { DesktopRequests } from './requests';

// 由桌面构建脚本写入，显示当前可执行文件对应的源码版本。
declare const __GRAYCODE_DESKTOP_BUILD__: import('../../../shared/distribution').DistributionInfo & { buildTime: string };

protocol.registerSchemesAsPrivileged([
  {
    scheme: "graycode",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
  {
    scheme: "graycode-preview",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);
const argumentsList = process.argv.slice(1);
app.setName("GrayCode");
const dataIndex = argumentsList.indexOf("--data");
let dataDirectory =
  dataIndex >= 0
    ? path.resolve(argumentsList[dataIndex + 1])
    : path.join(app.getPath("userData"), "platform-data");
// Separate storage keeps the existing VS Code application and legacy files untouched.
const storageLocation = new DesktopStorageLocation(app.getPath('userData'), path.join(app.getPath('userData'), 'platform-data'), dataIndex >= 0 ? dataDirectory : undefined);
let notifications: ReturnType<typeof desktopNotifications> | undefined;
let petWindowController: DesktopPetWindow | undefined;
let application: PlatformApplication;
let backups: ApplicationBackups | undefined;
let window: BrowserWindow | undefined;
let tray: Tray | undefined;
let browser: DesktopBrowser;
let exitPhase: 'idle' | 'confirming' | 'closing' | 'ready' = 'idle';
let exitOperation: Promise<void> | undefined;
let closePending = false;
let windowState: DesktopWindowState | undefined;
let dirtyDocuments = 0;
let dirtySettings = false;
const trustedWindows = new Set<number>();
const client = { actorId: "owner", clientId: randomUUID(), uiStateKey: 'desktop' };
const preload = path.join(__dirname, "preload.cjs");
const clientDirectory = path.resolve(__dirname, "../../client/dist");
const editorRegistration = new DesktopEditorRegistration(process.execPath, app.isPackaged);
const startupFiles = desktopFileArguments(process.argv.slice(process.defaultApp ? 2 : 1), process.cwd());
const desktopFiles = new DesktopOpenFiles(file => openDesktopPath(application, client, file), (file, error) => {
  notify({ type: 'notification', message: `无法打开 ${file}：${error instanceof Error ? error.message : String(error)}` });
});

function notify(event: Record<string, unknown>): void {
  if (event.clientId && event.clientId !== client.clientId) return;
  if (Array.isArray(event.excludeClientIds) && event.excludeClientIds.includes(client.clientId)) return;
  for (const item of BrowserWindow.getAllWindows())
    if (trustedWindows.has(item.webContents.id) && !item.isDestroyed())
      item.webContents.send("graycode:event", event);
}
function trust(item: BrowserWindow): void {
  const contentsId = item.webContents.id;
  trustedWindows.add(contentsId);
  item.webContents.setWindowOpenHandler(({ url }) => {
    // 桌面界面中的网页链接交给系统浏览器，保持主窗口在本地工作台。
    try {
      const target = new URL(url);
      if (['https:', 'http:'].includes(target.protocol) && !target.username && !target.password)
        void shell.openExternal(target.href).catch(error => notify({ type: 'notification', message: `无法打开网页：${String(error)}` }));
    } catch { /* 无效地址不交给系统执行。 */ }
    return { action: 'deny' };
  });
  item.webContents.on('will-frame-navigate', event => {
    // 聊天也在子框架中，漏接的链接不能导航走整个聊天界面；预览页仍可正常导航。
    if (event.isMainFrame || event.frame?.url.startsWith('graycode://app/chat/')) event.preventDefault();
  });
  item.on("closed", () => trustedWindows.delete(contentsId));
}
async function activeTasks(): Promise<boolean> {
  // 退出已获确认后只重试清理，不能再向正在关闭或已关闭的存储查询运行状态。
  if (application.isClosing) return false;
  const hasRuns = (await application.storage.listRuns({ activeOnly: true, limit: 1 })).length > 0;
  // 在异步查询后读取连接状态，避免连接中的 Bot 被当作空闲程序退出。
  return hasRuns || application.runtime.preparingCount > 0 || application.productUi.chat.hasPendingStarts() || application.pets.keepsAlive || application.screenSense.keepsAlive || backups?.busy === true || application.automations.keepsAlive || application.discord.keepsAlive || application.onebot.keepsAlive || !!application.remoteAccess?.keepsAlive
    || application.nodes.keepsAlive || application.fileActions.hasPending || application.subagents.hasPendingWork() || !!application.terminals.list().length
    || application.interactiveTerminals.hasRunning || application.processes.activeCount > 0 || !!application.subagents.backgroundTasks().length;
}
function quit(relaunch = false, beforeExit?: () => void): Promise<void> {
  if (exitOperation) return exitOperation;
  exitPhase = 'closing';
  closePending = false;
  exitOperation = Promise.resolve().then(async () => {
    let progress: DesktopProgress | undefined;
    if (application && window && !window.isDestroyed() && window.isVisible()) {
      progress = await showDesktopProgress({ language: getActualLanguage(), title: t('desktop.closingTitle'), message: t('desktop.closingMessage'),
        detail: t('desktop.closingDetail'), progress: t('desktop.closingBackups'), colors: desktopColors() }, window)
        .catch(error => { console.warn('退出进度界面不可用：', error); return undefined; });
    }
    try {
      await windowState?.flush();
      await backups?.close();
      progress?.update(t('desktop.closingWindows'));
      notifications?.dispose();
      petWindowController?.dispose();
      browser?.close();
      progress?.update(t('desktop.closingCore'));
      await application?.close();
      if (beforeExit) progress?.update(t('desktop.closingUpdate'));
      beforeExit?.();
      // 保留托盘到清理成功，失败时仍可重试；只有此时才允许 Electron 真正关闭窗口。
      tray?.destroy();
      if (relaunch) app.relaunch();
      exitPhase = 'ready';
      progress?.close();
      app.quit();
    } finally { progress?.close(); }
  }).catch(error => {
    exitPhase = 'idle';
    exitOperation = undefined;
    throw error;
  });
  return exitOperation;
}
function updateTrayStatus(): void {
  tray?.setToolTip(t(closePending ? 'desktop.trayWaiting' : 'desktop.trayResident'));
}
function ensureTray(): void {
  if (tray) { updateTrayStatus(); return; }
  const icon = nativeImage
    .createFromPath(path.resolve(__dirname, "../../../resources/icon.png"))
    .resize({ width: 24, height: 24 });
  tray = new Tray(icon);
  updateTrayStatus();
  tray.on("double-click", () => { void createWindow(); });
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: t('desktop.trayOpen'),
        click: () => { void createWindow(); },
      },
      { label: t('desktop.quit'), click: () => void confirmQuit() },
    ]),
  );
}
function minimizeToTray(): void {
  if (!window || window.isDestroyed()) return;
  // 用户主动选择托盘常驻，与关闭窗口后等待任务完成再退出的行为分开。
  closePending = false;
  ensureTray();
  window.hide();
}
function desktopColors(): Record<string, string> {
  const appearance = application.settings.snapshot().settings.appearance;
  return resolveAppearancePalette(appearance.theme, appearance.colors, !nativeTheme.shouldUseDarkColors, appearance.darkPalette);
}
async function confirmQuit(intent: 'quit' | 'window' = 'quit'): Promise<void> {
  if (exitPhase !== 'idle') return;
  exitPhase = 'confirming';
  try {
    const active = await activeTasks();
    const readDrafts = async () => {
      const settingsDirty = !application.isClosing && (dirtySettings || await application.productUi.hasClientDirtyPreferences(client.clientId));
      const remoteSettings = !application.isClosing && await application.productUi.hasDirtyPreferences(true, client.clientId);
      const remoteDocuments = application.isClosing ? 0 : application.files.dirtyDocumentCount(true, client.clientId);
      const localDocuments = Math.max(dirtyDocuments, application.isClosing ? 0 : application.files.dirtyDocumentCount(true) - remoteDocuments);
      return { settingsDirty, remoteSettings, remoteDocuments, localDocuments };
    };
    const shownDrafts = await readDrafts();
    const { settingsDirty, remoteSettings, remoteDocuments, localDocuments } = shownDrafts;
    const remoteDrafts = remoteDocuments > 0 || remoteSettings;
    const dirty = localDocuments > 0 || settingsDirty || remoteDrafts;
    // 保留干净窗口关闭后等后台任务完成的既有策略。
    if (intent === 'window' && !dirty && active) {
      closePending = true; ensureTray(); window?.hide(); return;
    }
    if (!application.isClosing && (dirty || active)) {
      const items = [
        ...(localDocuments ? [t('desktop.unsavedFiles', { count: localDocuments })] : []),
        ...(settingsDirty ? [t('desktop.unsavedSettings')] : []),
        ...(remoteDocuments ? [t('desktop.unsavedRemoteFiles', { count: remoteDocuments })] : []),
        ...(remoteSettings ? [t('desktop.unsavedRemoteSettings')] : []),
        ...(active ? [t('desktop.activeTasks')] : []),
      ];
      const action = await showDesktopConfirmation({ language: getActualLanguage(), title: t('desktop.quitTitle'), message: t('desktop.quitMessage'),
        detail: t(remoteDrafts ? 'desktop.remoteDraftQuitDetail' : dirty ? 'desktop.saveAllDetail' : 'desktop.quitDetail') + (active ? '\n' + t('desktop.backgroundDetail') : ''), items, cancelId: 'cancel', colors: desktopColors(),
        actions: [{ id: 'cancel', label: t('desktop.continueWorking'), kind: 'primary' },
          ...(dirty && !remoteDrafts ? [{ id: 'save', label: t('desktop.saveAllQuit') }] : []),
          ...(active ? [{ id: 'background', label: t('desktop.background') }] : []),
          { id: 'quit', label: t(dirty ? 'desktop.discardQuit' : 'desktop.quit'), kind: 'danger' }] }, window);
      if (action === 'background') { minimizeToTray(); return; }
      if (action === 'save') {
        if (!window || window.isDestroyed()) throw new Error(t('desktop.saveAllUnavailable'));
        // 保存期间用父窗口模态进度阻止新输入，避免回执确认后又产生未保存草稿。
        const progress = await showDesktopProgress({ language: getActualLanguage(), title: t('desktop.saveAllQuit'), message: t('desktop.saveAllQuit'),
          progress: t('desktop.saveAllProgress'), colors: desktopColors() }, window);
        try {
          await desktopSaveAll.request(window.webContents.id, requestId => window!.webContents.send('graycode:event', { type: 'desktop.saveAll', requestId }));
          if (dirtyDocuments || dirtySettings || application.files.dirtyDocumentCount(true) || await application.productUi.hasDirtyPreferences(true)) throw new Error(t('desktop.saveAllIncomplete'));
        } finally { progress.close(); }
        await quit(); return;
      }
      if (action !== 'quit') return;
    }
    // 模态对话框只阻止本地输入，远端可能在确认期间新增草稿，必须先展示新的放弃范围。
    const latestDrafts = await readDrafts();
    if (latestDrafts.localDocuments !== shownDrafts.localDocuments || latestDrafts.remoteDocuments !== shownDrafts.remoteDocuments
      || latestDrafts.settingsDirty !== shownDrafts.settingsDirty || latestDrafts.remoteSettings !== shownDrafts.remoteSettings) {
      exitPhase = 'idle'; return confirmQuit(intent);
    }
    await quit();
  } catch (error) {
    dialog.showErrorBox('GrayCode', error instanceof Error ? error.message : String(error));
  } finally {
    if (exitPhase === 'confirming') exitPhase = 'idle';
    // 确认期间结束的任务可能不再产生事件，进入托盘后立即补查一次。
    if (closePending) checkIdleClose();
  }
}
const checkIdleClose = createIdleCloseCheck({
  pending: () => closePending && exitPhase === 'idle', active: activeTasks,
  // 等待任务结束期间，远端仍可能产生草稿；实际退出前重新核对并保留确认入口。
  close: async () => { closePending = false; updateTrayStatus(); await confirmQuit('window'); },
  report: error => dialog.showErrorBox('GrayCode', error instanceof Error ? error.message : String(error)),
});
async function createWindow(): Promise<void> {
  closePending = false;
  updateTrayStatus();
  if (window && !window.isDestroyed()) {
    activateDesktopWindow(window);
    return;
  }
  const colors = desktopColors();
  const primary = screen.getPrimaryDisplay();
  const geometry = restoreWindowBounds(windowState?.value, [primary.workArea, ...screen.getAllDisplays().filter(display => display.id !== primary.id).map(display => display.workArea)]);
  window = new BrowserWindow({
    ...geometry.bounds,
    minWidth: geometry.minWidth,
    minHeight: geometry.minHeight,
    title: "GrayCode",
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: colors.chrome, symbolColor: colors.chromeText, height: 38 },
    autoHideMenuBar: true,
    backgroundColor: colors.chrome,
    show: process.env.GRAYCODE_DESKTOP_SMOKE !== "1",
    webPreferences: {
      preload,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      offscreen: process.env.GRAYCODE_DESKTOP_SMOKE === "1",
      backgroundThrottling: process.env.GRAYCODE_DESKTOP_SMOKE !== "1",
    },
  });
  windowState?.bind(window);
  if (geometry.maximized) window.maximize();
  bindDesktopAppearance(window, application);
  desktopFiles.suspend();
  window.webContents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) desktopFiles.suspend(); });
  trust(window);
  window.webContents.on('render-process-gone', () => { void application.computer.clientClosed(client.clientId); void application.nodes.clientClosed(client.clientId); });
  window.on('closed', () => { void application.computer.clientClosed(client.clientId); void application.nodes.clientClosed(client.clientId); });
  window.on("close", (event) => {
    if (exitPhase === 'ready') return;
    event.preventDefault();
    if (exitPhase !== 'idle') return;
    void confirmQuit('window');
  });
  await window.loadURL("graycode://app/index.html");
}

async function main(): Promise<void> {
  await app.whenReady();
  dataDirectory = await storageLocation.startup();
  await confirmInstalledRecovery(app.getPath('userData'), process.execPath, app.getVersion(), dataDirectory);
  await new BackupRestoreState(dataDirectory).apply();
  windowState = new DesktopWindowState(path.join(dataDirectory, 'desktop-window.json'));
  await windowState.load();
  session.defaultSession.setPermissionRequestHandler(
    (_contents, _permission, callback) => callback(false),
  );
  protocol.handle("graycode", async (request) => {
    const url = new URL(request.url);
    if (url.host !== "app") return new Response("Not found", { status: 404 });
    if (url.pathname.startsWith('/assets/background/')) {
      const image = await application?.images.get(url.pathname.slice('/assets/background/'.length));
      if (!image) return new Response('Not found', { status: 404 });
      return new Response(new Uint8Array(image.bytes), { headers: { 'Content-Type': image.mimeType, 'Cache-Control': 'private, max-age=31536000, immutable' } });
    }
    const file = path.resolve(
      clientDirectory,
      `.${decodeURIComponent(url.pathname)}`,
    );
    const relative = path.relative(clientDirectory, file);
    if (relative.startsWith("..") || path.isAbsolute(relative))
      return new Response("Forbidden", { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });
  const secretCodec = {
    encrypt: async (value: string) => {
      if (!safeStorage.isEncryptionAvailable() || process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')
        throw new Error('系统密钥服务不可用，无法加密保存密钥。');
      return safeStorage.encryptString(value);
    },
    decrypt: async (value: Uint8Array) => safeStorage.decryptString(Buffer.from(value)),
  };
  const portableDirectory = portableProfileDirectory(process.execPath, app.isPackaged, dataIndex >= 0);
  application = await PlatformApplication.open({
    dataDirectory,
    configurationPersistence: portableDirectory ? new DesktopPortableProfile(portableDirectory) : undefined,
    documentsDirectory: app.getPath('documents'),
    browser: application => browser = new DesktopBrowser(application, () => window, notify),
    computerCapture: new DesktopComputerCapture(),
    remoteAccess: application => new RemoteAccessService(application, { clientDirectory }),
    secretCodec,
  });
  backups = new ApplicationBackups(application.storage, { appVersion: app.getVersion(), secretCodec,
    skillsDirectory: application.skills.directory(), notify: progress => application.publish({ type: 'ui.message',
      message: { type: 'command', command: 'backup.progress', data: progress } }) });
  await migrateLegacySettings(application, app.getPath('appData')).catch(error => {
    console.error('旧配置自动导入未完成：', error instanceof Error ? error.message : String(error));
  });
  // 后台补齐历史遗留的占位对话标题（一次性，写入标记后不再扫描）。
  void backfillPlaceholderTitles(application).catch(error => console.warn('[autoTitles] Backfill failed:', error));
  const installer = new DesktopInstaller({ executable: process.execPath, userData: app.getPath('userData'), dataDirectory,
    recoveryTemplate: path.resolve(__dirname, '../../../resources/installer/restore-program.ps1'),
    currentVersion: app.getVersion(), restartArgs: process.argv.slice(app.isPackaged ? 1 : 2).filter(value => !value.startsWith('--veloapp-')),
    backup: destination => backups!.export(destination),
    assertCanRestart: async restoreId => {
      if (exitPhase !== 'idle' || application.isClosing || dirtySettings || dirtyDocuments || application.files.dirtyDocumentCount(true) || await application.productUi.hasDirtyPreferences(true))
        throw new Error('请先保存或放弃编辑器与设置中的修改，再安装或回退。');
      const pendingRestore = (await backups!.status()).pending;
      if (restoreId && pendingRestore?.id !== restoreId) throw new Error('本次回退的恢复准备已经改变，请重新操作。');
      if (storageLocation.getConfig().config.pendingMigration || pendingRestore && pendingRestore.id !== restoreId || backups!.busy)
        throw new Error('请先完成或取消数据目录迁移、备份和恢复，再安装或回退。');
    },
    restore: async archive => (await backups!.prepareRestore(archive)).pending.id,
    cancelRestore: () => backups!.cancelRestore(),
    confirm: async (message, detail) => (await showDesktopConfirmation({ language: getActualLanguage(), title: t('desktop.installerTitle'), message, detail,
      colors: desktopColors(), cancelId: 'cancel', actions: [{ id: 'cancel', label: t('desktop.continueWorking'), kind: 'primary' },
        { id: 'restart', label: t('desktop.restart') }] }, window)) === 'restart',
    restart: async apply => {
      setTimeout(() => { void quit(false, apply).catch(async error => {
        await backups!.cancelRestore().catch(() => {});
        dialog.showErrorBox('GrayCode 更新器未能启动', `当前程序包未被替换。请重新启动后重试。\n${String(error)}`);
      }); }, 150);
    },
  });
  const updates = new DesktopUpdates(application, installer);
  const router = new ApplicationRouter(application);
  notifications = desktopNotifications(application, () => window, async conversationId => {
    // Foreground synchronously in createWindow before awaiting conversation access/navigation.
    await createWindow();
    if (conversationId) {
      await application.conversation(client.actorId, conversationId);
      await router.call(client, 'ui.command', { command: 'platform.openModeConversation', data: { conversationId } });
    }
  });
  petWindowController = new DesktopPetWindow(application, client, preload, trust);
  const webPortIndex = argumentsList.indexOf('--web-port');
  if (webPortIndex >= 0) {
    const port = Number(argumentsList[webPortIndex + 1]);
    const tokenIndex = argumentsList.indexOf('--web-token-env');
    const originIndex = argumentsList.indexOf('--web-public-origin');
    const variable = tokenIndex >= 0 ? argumentsList[tokenIndex + 1] : undefined;
    const token = variable ? process.env[variable] : undefined;
    if (!Number.isInteger(port) || port < 0 || port > 65535 || !token) throw new Error('Web 入口需要有效的 --web-port 和 --web-token-env 参数。');
    await application.remoteAccess!.initialize({ port, token, publicOrigin: originIndex >= 0 ? argumentsList[originIndex + 1] : undefined });
  } else await application.remoteAccess!.initialize();
  if (application.remoteAccess!.status().address) console.log(`GrayCode Web: ${application.remoteAccess!.status().address}`);
  await application.nodes.activate();
  application.subscribe((event) => {
    notify(event);
    if (event.type === 'settings.changed') updateTrayStatus();
    if (closePending && exitPhase === 'idle' && (event.type === 'runtime.preparation.changed' || event.type === 'chat.preparation.changed' || event.type === "file.activity" || event.type === 'nodes.changed' || event.type === 'processes.changed' || event.type === "remote.changed" || event.type === "bot.connection.changed" || event.type === "terminal.changed" || event.type === "event" || event.type === "automation.changed" || event.type === "background.followup.changed" || event.type === "ui.message" && ['taskEvent', 'backup.progress'].includes((event.message as { command?: string })?.command ?? '')))
      checkIdleClose();
  });
  const desktopRequests = new DesktopRequests({
    application, router, client, backups: backups!, installer, updates, storageLocation, desktopFiles,
    editorRegistration, notifications, petWindow: petWindowController, saveAll: desktopSaveAll,
    dataDirectory, build: __GRAYCODE_DESKTOP_BUILD__, getWindow: () => window, createWindow,
    isClosing: () => exitPhase === 'closing' || exitPhase === 'ready' || application.isClosing,
    dirtyState: () => ({ documents: dirtyDocuments, settings: dirtySettings }),
    setDirtyDocuments: count => { dirtyDocuments = count; },
    setDirtySettings: dirty => { dirtySettings = dirty; },
    activeTasks, quit, notify,
  });
  ipcMain.handle(
    "graycode:rpc",
    (event, method: string, params: Record<string, any> = {}) => desktopRpcReply(async () => {
      const trustedContents = trustedWindows.has(event.sender.id);
      if (!isTrustedApplicationFrame(trustedContents, event.senderFrame, event.sender.mainFrame)) {
        throw new Error("Untrusted application frame.");
      }
      return desktopRequests.call(event.sender.id, method, params);
    }),
  );
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "编辑",
        submenu: [
          { role: "undo", label: "撤销" },
          { role: "redo", label: "重做" },
          { type: "separator" },
          { role: "cut", label: "剪切" },
          { role: "copy", label: "复制" },
          { role: "paste", label: "粘贴" },
          { role: "selectAll", label: "全选" },
          { label: "设置", visible: false, accelerator: "CmdOrCtrl+,", click: () => notify({ type: "settings.open" }) },
        ],
      },
      {
        label: "视图",
        submenu: [
          { label: "最小化到托盘", click: () => minimizeToTray() },
          { label: t('desktop.quit'), accelerator: 'CmdOrCtrl+Q', click: () => void confirmQuit() },
          { type: "separator" },
          { role: "resetZoom", label: "恢复实际大小" },
          { role: "zoomIn", label: "放大" },
          { role: "zoomOut", label: "缩小" },
          {
            label: "开发者工具",
            accelerator: "CmdOrCtrl+Shift+I",
            click: () => window?.webContents.openDevTools({ mode: "detach" }),
          },
        ],
      },
    ]),
  );
  await createWindow();
  // 窗口可用后分别连接；一个平台连接失败不会阻塞另一个平台和桌面启动。
  void application.discord.autoConnect();
  void application.onebot.autoConnect();
}
if (!app.requestSingleInstanceLock({ dataDirectory, files: startupFiles })) app.quit();
else {
  desktopFiles.enqueue(startupFiles);
  app.on('open-file', (event, file) => { event.preventDefault(); desktopFiles.enqueue([file]); if (application && window) void createWindow(); });
  app.on("second-instance", (_event, commandLine, workingDirectory, additionalData) => {
    const supplied = additionalData as { files?: unknown } | undefined;
    const files = Array.isArray(supplied?.files) && supplied.files.every(file => typeof file === 'string')
      ? supplied.files : desktopFileArguments(commandLine.slice(process.defaultApp ? 2 : 1), workingDirectory);
    desktopFiles.enqueue(files);
    closePending = false;
    if (application && window) void createWindow();
  });
  app.on("activate", () => {
    if (application) void createWindow();
  });
  app.on("before-quit", (event) => {
    if (exitPhase !== 'ready' && application) {
      event.preventDefault();
      if (exitPhase === 'idle') void confirmQuit();
    }
  });
  app.on("window-all-closed", () => {
    /* Lifetime is controlled by the close policy and running tasks. */
  });
  void main().catch(async (error) => {
    try {
      await recoverStartup(error, args => quit(false, () => app.relaunch(args ? { args } : undefined)));
      await quit();
    }
    catch (cleanupError) { dialog.showErrorBox('GrayCode 关闭失败', String(cleanupError)); }
  });
}
