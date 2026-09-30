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
  clipboard,
  ClipboardItem,
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
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { PlatformApplication } from "../../server/src/application";
import { ApplicationRouter } from "../../server/src/transport/router";
import { DesktopBrowser } from "./browser";
import { DesktopComputerCapture } from './computerCapture';
import { DesktopPetWindow } from './petWindow';
import { systemFonts } from "./fonts";
import { migrateLegacySettings } from './legacySettings';
import { backfillPlaceholderTitles } from '../../server/src/conversations/autoTitles';
import { RemoteAccessService } from '../../server/src/transport/remoteAccess';
import { DesktopOpenFiles, desktopFileArguments, openDesktopPath } from './openFiles';
import { DesktopEditorRegistration } from './editorRegistration';
import { bindDesktopAppearance } from './appearance';
import { resolveAppearancePalette } from '../../../shared/appearance';
import { isTrustedApplicationFrame } from './trustedFrame';
import { openWorkspaceInExplorer, revealWorkspaceFile } from './workspaceExplorer';
import { desktopRpcReply } from '../../../shared/desktopBridge';

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
  return resolveAppearancePalette(appearance.theme, appearance.colors, !nativeTheme.shouldUseDarkColors);
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
    titleBarOverlay: { color: colors.background, symbolColor: colors.text, height: 38 },
    autoHideMenuBar: true,
    backgroundColor: colors.background,
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
  ipcMain.handle(
    "graycode:rpc",
    (event, method: string, params: Record<string, any> = {}) => desktopRpcReply(async () => {
      const trustedContents = trustedWindows.has(event.sender.id);
      if (!isTrustedApplicationFrame(trustedContents, event.senderFrame, event.sender.mainFrame)) {
        throw new Error("Untrusted application frame.");
      }
      if (method === 'ui.request' && typeof params.type === 'string' && params.type.startsWith('desktop.editor.')) {
        method = params.type; params = params.data ?? {};
      }
      if (method === 'ui.request' && typeof params.type === 'string' && params.type.startsWith('backup.')) {
        method = params.type; params = params.data ?? {};
      }
      if (method === 'desktop.editor.status') return editorRegistration.status();
      if (method === 'desktop.editor.register') return editorRegistration.register();
      if (method === 'desktop.editor.defaults') {
        const status = await editorRegistration.status();
        if (!status.registered) throw new Error('请先将当前 GrayCode 注册为代码编辑器。');
        await shell.openExternal('ms-settings:defaultapps?registeredAppUser=GrayCode'); return { success: true };
      }
      if (method === 'desktop.files.ready') { await desktopFiles.clientReady(); return { success: true }; }
      if (method === 'ui.request' && (params.type?.startsWith('desktop.updates.') || ['getAppInfo', 'getUpdateStatus', 'checkUpdateNow', 'updateNow', 'installUpdate', 'openUpdatePage', 'notifications.agentStop', 'notifications.preview', 'exportPromptModes', 'conversation.revealInExplorer', 'storagePath.getConfig', 'storagePath.validate', 'storagePath.selectFolder', 'storagePath.openInExplorer', 'storagePath.migrate', 'storagePath.reset', 'reloadWindow', 'openDirectory', 'desktop.fonts', 'desktop.chooseWorkspace', 'desktop.dirtySettings', 'settings.import', 'settings.export'].includes(params.type))) {
        method = params.type;
        params = params.data ?? {};
      }
      if (exitPhase === 'closing' || exitPhase === 'ready' || application.isClosing) throw new Error('应用正在关闭，请稍后重新打开。');
      if (method === 'files.reveal') return revealWorkspaceFile(application, shell, client.actorId, params as { workspaceId: string; path: string });
      if (method === 'workspace.openInExplorer') return openWorkspaceInExplorer(application, shell, client.actorId, params);
      if (method === 'desktop.pet.expand') return petWindowController!.expand(params.expanded === true);
      if (['desktop.pet.manage', 'desktop.pet.screenSense', 'desktop.pet.openConversation'].includes(method)) {
        if (method === 'desktop.pet.openConversation') await application.conversation(client.actorId, params.conversationId);
        if (!window || window.isDestroyed()) await createWindow(); else { window.show(); window.focus(); }
        if (method === 'desktop.pet.manage') notify({ type: 'pets.open' });
        else if (method === 'desktop.pet.screenSense') notify({ type: 'screenSense.open' });
        else await router.call(client, 'ui.command', { command: 'platform.openModeConversation', data: { conversationId: params.conversationId } });
        return { success: true };
      }
      application.requireOwner(client.actorId);
      if (method === 'backup.status') return backups!.status();
      if (method === 'backup.cancel') { backups!.cancel(); return { success: true }; }
      if (method === 'backup.cancelRestore') { await backups!.cancelRestore(); return { success: true }; }
      if (method === 'backup.preview') return backups!.previewRestore();
      if (method === 'backup.select') return backups!.selectRestore(params.selection);
      if (method === 'backup.export') {
        const selected = await dialog.showSaveDialog(window!, { title: '备份程序数据',
          defaultPath: `GrayCode-${new Date().toISOString().slice(0, 10)}.graycode-backup`,
          filters: [{ name: 'GrayCode 程序数据备份', extensions: ['graycode-backup'] }] });
        if (selected.canceled || !selected.filePath) return { cancelled: true };
        return backups!.export(selected.filePath, params.password || undefined);
      }
      if (method === 'backup.restore') {
        if (storageLocation.getConfig().config.pendingMigration) throw new Error('请先完成数据目录迁移，再恢复备份。');
        const selected = await dialog.showOpenDialog(window!, { title: '选择程序数据备份', properties: ['openFile'],
          filters: [{ name: 'GrayCode 程序数据备份', extensions: ['graycode-backup'] }] });
        if (selected.canceled || !selected.filePaths[0]) return { cancelled: true };
        return backups!.prepareRestore(selected.filePaths[0], params.password || undefined, { previewOnly: params.previewOnly === true });
      }
      if (method === 'backup.restart') {
        const pending = (await backups!.status()).pending;
        if (!pending) throw new Error('没有等待应用的备份。');
        if (pending.requiresSelection && !pending.selection) throw new Error('请先选择恢复范围并查看最终预览。');
        if (dirtySettings || dirtyDocuments || application.files.dirtyDocumentCount(true) || await application.productUi.hasDirtyPreferences(true)) throw new Error('请先保存或放弃编辑器与设置中的修改，再应用备份。');
        const selected = await dialog.showMessageBox(window!, { type: 'question', title: '恢复程序数据',
          message: pending.selection?.mode === 'selective' ? '重启并恢复最终预览中的所选数据？' : '重启并应用完整备份？', detail: '当前任务和连接将停止，恢复前的数据目录会完整保留。项目源码不会被替换。',
          buttons: ['重启并恢复', '继续工作'], defaultId: 1, cancelId: 1 });
        if (selected.response !== 0) return { cancelled: true };
        await backups!.restore.confirm();
        setTimeout(() => { void quit(true).catch(error => dialog.showErrorBox('GrayCode 恢复失败', String(error))); }, 100);
        return { success: true };
      }
      if (method === 'getAppInfo') return { name: 'GrayCode', displayName: 'GrayCode', version: app.getVersion(), publisher: 'Komeiji-Shiki', runtime: 'desktop',
        ...__GRAYCODE_DESKTOP_BUILD__, executablePath: app.getPath('exe') };
      if (method === 'getUpdateStatus') return updates.get();
      if (method === 'checkUpdateNow') return updates.check();
      if (method === 'openUpdatePage') return updates.open();
      if (method === 'updateNow' || method === 'installUpdate') return updates.prepare(method === 'updateNow');
      if (method === 'desktop.updates.status') return installer.status();
      if (method === 'desktop.updates.apply') return installer.apply();
      if (method === 'desktop.updates.rollback') return installer.rollback();
      if (method === 'desktop.updates.openRecovery') {
        const recovery = (await installer.status()).recovery;
        if (!recovery) throw new Error('当前没有保存的回退点。');
        const error = await shell.openPath(path.dirname(recovery.backupPath));
        if (error) throw new Error(error);
        return { success: true };
      }
      if (method === 'desktop.updates.local') {
        const selected = await dialog.showOpenDialog(window!, { title: '选择离线更新清单', properties: ['openFile'],
          filters: [{ name: 'GrayCode 更新清单（releases.win-x64.json）', extensions: ['json'] }] });
        if (selected.canceled || !selected.filePaths[0]) return { cancelled: true };
        if (path.basename(selected.filePaths[0]) !== 'releases.win-x64.json') throw new Error('请选择发行包附带的 releases.win-x64.json，并将完整更新包放在同一目录。');
        return installer.prepare(path.dirname(selected.filePaths[0]));
      }
      if (method.startsWith('storagePath.') || ['reloadWindow', 'notifications.agentStop', 'notifications.preview', 'exportPromptModes', 'conversation.revealInExplorer'].includes(method)) application.requireOwner(client.actorId);
      if (method === 'notifications.agentStop' || method === 'notifications.preview') {
        if (!['error', 'awaiting_user_action', 'continue_required'].includes(params.reason) || method === 'notifications.agentStop' && typeof params.dedupeKey !== 'string') throw new Error('通知参数无效。');
        if (params.conversationId) await application.conversation(client.actorId, params.conversationId);
        return { success: true, ...await (method === 'notifications.preview' ? notifications!.preview(params as any) : notifications!.notify(params as any)) };
      }
      if (method === 'exportPromptModes') {
        if (typeof params.content !== 'string') throw new Error('预设内容无效。');
        const selected = await dialog.showSaveDialog(window!, { title: '导出提示词预设', defaultPath: path.basename(String(params.filename ?? 'graycode-prompt-modes.json')), filters: [{ name: 'JSON', extensions: ['json'] }] });
        if (selected.canceled || !selected.filePath) return { success: false, cancelled: true };
        await writeFile(selected.filePath, params.content, 'utf8'); return { success: true, filePath: selected.filePath };
      }
      if (method === 'storagePath.getConfig') return storageLocation.getConfig();
      if (method === 'storagePath.validate') return storageLocation.validate(params.path);
      if (method === 'storagePath.migrate' || method === 'storagePath.reset') {
        if ((await backups!.status()).pending) throw new Error('请先应用或取消备份恢复，再迁移数据目录。');
        return storageLocation.schedule(method === 'storagePath.reset' ? storageLocation.defaultPath : params.path);
      }
      if (method === 'storagePath.selectFolder') {
        const selected = await dialog.showOpenDialog(window!, { title: '选择数据目录', properties: ['openDirectory', 'createDirectory'] });
        return { path: selected.canceled ? null : selected.filePaths[0] };
      }
      if (method === 'storagePath.openInExplorer' || method === 'conversation.revealInExplorer') {
        if (method === 'conversation.revealInExplorer') await application.conversation(client.actorId, params.conversationId);
        const target = method === 'storagePath.openInExplorer' && params.path ? String(params.path) : dataDirectory;
        if (!path.isAbsolute(target)) throw new Error('请选择完整目录路径。');
        const error = await shell.openPath(target); if (error) throw new Error(error); return { success: true };
      }
      if (method === 'reloadWindow') {
        if (await activeTasks() || dirtySettings || dirtyDocuments || application.files.dirtyDocumentCount(true) || await application.productUi.hasDirtyPreferences(true)) throw new Error('请先结束任务、保存或放弃编辑器与设置中的修改，再重启应用。');
        setTimeout(() => { void quit(true).catch(error => dialog.showErrorBox('GrayCode 重启失败', String(error))); }, 100);
        return { success: true };
      }
      if (method === 'openDirectory') {
        application.requireOwner(client.actorId);
        const target = String(params.path ?? '');
        if (!path.isAbsolute(target)) throw new Error('请选择完整的目录路径。');
        const error = await shell.openPath(target);
        if (error) throw new Error(error);
        return { success: true };
      }
      if (method === 'settings.import') {
        const selected = await dialog.showOpenDialog(window!, { title: '导入 GrayCode 设置', properties: ['openFile'], filters: [{ name: 'GrayCode 设置', extensions: ['json'] }] });
        if (selected.canceled) return { cancelled: true };
        const value = JSON.parse((await readFile(selected.filePaths[0], 'utf8')).replace(/^\uFEFF/, ''));
        return router.call(client, 'ui.request', { type: 'settings.importData', data: { value } });
      }
      if (method === 'settings.export') {
        const selected = await dialog.showSaveDialog(window!, { title: '导出 GrayCode 设置', defaultPath: 'graycode-settings.json', filters: [{ name: 'JSON', extensions: ['json'] }] });
        if (selected.canceled || !selected.filePath) return { cancelled: true };
        const value = await router.call(client, 'ui.request', { type: 'settings.exportData', data: {} });
        await writeFile(selected.filePath, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
        return { success: true, filePath: selected.filePath };
      }
      if (method === "desktop.chooseWorkspace") {
        const result = await dialog.showOpenDialog({
          properties: ["openDirectory"],
        });
        return result.canceled
          ? null
          : {
              directory: result.filePaths[0],
              name: path.basename(result.filePaths[0]),
            };
      }
      if (method === 'desktop.menu') {
        const item = Menu.getApplicationMenu()?.items.find(item => item.label === params.label);
        item?.submenu?.popup({ window: window! }); return;
      }
      if (method === "desktop.fonts") return systemFonts(params.refresh === true);
      if (method === 'desktop.clipboard.writeText') {
        if (typeof params.text !== 'string') throw new Error('复制内容必须是文本。');
        await clipboard.writeText(params.text); return { success: true };
      }
      if (method === 'desktop.clipboard.writeImage') {
        // 图片来自查看器的原始像素；先约束编码大小，再交给原生解码，避免 IPC 分配无界数据。
        const maxBytes = 50 * 1024 * 1024;
        if (typeof params.data !== 'string' || params.data.length > Math.ceil(maxBytes / 3) * 4)
          throw new Error(t('desktop.shell.previewCopyFailed'));
        const bytes = Buffer.from(params.data, 'base64');
        if (!bytes.length || bytes.length > maxBytes || bytes.toString('base64') !== params.data)
          throw new Error(t('desktop.shell.previewCopyFailed'));
        const image = nativeImage.createFromBuffer(bytes);
        if (image.isEmpty()) throw new Error(t('desktop.shell.previewCopyFailed'));
        await clipboard.write([new ClipboardItem({ 'image/png': new Blob([Uint8Array.from(bytes)], { type: 'image/png' }) })]);
        return { success: true };
      }
      if (method === 'files.download') {
        const file = await application.fileActions.download(client.actorId, params.workspaceId, params.path);
        const selected = await dialog.showSaveDialog(window!, { title: '另存文件', defaultPath: file.name, properties: ['showOverwriteConfirmation'] });
        if (selected.canceled || !selected.filePath) return { cancelled: true };
        const sameFile = process.platform === 'win32' ? path.resolve(selected.filePath).toLowerCase() === file.absolute.toLowerCase() : path.resolve(selected.filePath) === file.absolute;
        if (sameFile) throw new Error('请选择不同的保存位置。');
        await copyFile(file.absolute, selected.filePath); return { success: true, filePath: selected.filePath };
      }
      if (method === 'desktop.saveResult') { desktopSaveAll.complete(event.sender.id, params); return { success: true }; }
      if (method === "desktop.dirtyDocuments") {
        dirtyDocuments = Math.max(0, Number(params.count) || 0);
        return;
      }
      if (method === "desktop.dirtySettings") {
        dirtySettings = params.dirty === true;
        return;
      }
      return router.call(client, method, params);
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
