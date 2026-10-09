import { app, clipboard, ClipboardItem, dialog, Menu, nativeImage, shell, type BrowserWindow } from 'electron';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { t } from '../../../backend/i18n';
import type { DistributionInfo } from '../../../shared/distribution';
import type { PlatformApplication } from '../../server/src/application';
import type { ApplicationBackups } from '../../server/src/backups/service';
import type { ApplicationRouter, ClientSession } from '../../server/src/transport/router';
import type { DesktopEditorRegistration } from './editorRegistration';
import { systemFonts } from './fonts';
import type { DesktopInstaller } from './installer';
import type { desktopNotifications } from './notifications';
import type { DesktopOpenFiles } from './openFiles';
import type { DesktopPetWindow } from './petWindow';
import type { DesktopSaveAll } from './saveAll';
import type { DesktopStorageLocation } from './storageLocation';
import type { DesktopUpdates } from './updates';
import { openOfficeFile, openWorkspaceInExplorer, revealWorkspaceFile } from './workspaceExplorer';

type Params = Record<string, any>;
interface RequestPolicy {
  uiRequest?: boolean;
  owner?: boolean;
  duringClose?: boolean;
}
interface RequestHandler extends RequestPolicy {
  execute(params: Params, senderId: number): unknown;
}
interface RequestGroup extends RequestPolicy {
  prefix: string;
  handlers: Record<string, RequestHandler>;
}
interface DesktopRequestHost {
  application: PlatformApplication;
  router: ApplicationRouter;
  client: ClientSession;
  backups: ApplicationBackups;
  installer: DesktopInstaller;
  updates: DesktopUpdates;
  storageLocation: DesktopStorageLocation;
  desktopFiles: DesktopOpenFiles;
  editorRegistration: DesktopEditorRegistration;
  notifications: ReturnType<typeof desktopNotifications>;
  petWindow: DesktopPetWindow;
  saveAll: DesktopSaveAll;
  dataDirectory: string;
  build: DistributionInfo & { buildTime: string };
  getWindow(): BrowserWindow | undefined;
  createWindow(): Promise<void>;
  isClosing(): boolean;
  dirtyState(): { documents: number; settings: boolean };
  setDirtyDocuments(count: number): void;
  setDirtySettings(dirty: boolean): void;
  activeTasks(): Promise<boolean>;
  quit(relaunch?: boolean): Promise<void>;
  notify(event: Record<string, unknown>): void;
}

/** 桌面处理逻辑和兼容入口、权限、退出阶段放在同一声明中。 */
export class DesktopRequests {
  private readonly handlers = new Map<string, RequestHandler>();
  private readonly uiRequestPrefixes: string[] = [];

  constructor(private readonly host: DesktopRequestHost) {
    const { application, router, client, backups, installer, updates, storageLocation } = host;
    const hasDirtyState = async () => {
      const dirty = host.dirtyState();
      return dirty.settings || dirty.documents || application.files.dirtyDocumentCount(true)
        || await application.productUi.hasDirtyPreferences(true);
    };
    const scheduleStorage = async (target: string) => {
      if ((await backups.status()).pending) throw new Error('请先应用或取消备份恢复，再迁移数据目录。');
      return storageLocation.schedule(target);
    };
    const openDataDirectory = async (target: string) => {
      if (!path.isAbsolute(target)) throw new Error('请选择完整目录路径。');
      const error = await shell.openPath(target); if (error) throw new Error(error); return { success: true };
    };
    const openPetSurface = async (surface: 'manage' | 'screenSense' | 'conversation', params: Params) => {
      if (surface === 'conversation') await application.conversation(client.actorId, params.conversationId);
      const window = host.getWindow();
      if (!window || window.isDestroyed()) await host.createWindow(); else { window.show(); window.focus(); }
      if (surface === 'manage') host.notify({ type: 'pets.open' });
      else if (surface === 'screenSense') host.notify({ type: 'screenSense.open' });
      else await router.call(client, 'ui.command', { command: 'platform.openModeConversation', data: { conversationId: params.conversationId } });
      return { success: true };
    };
    const agentNotification = async (params: Params, preview: boolean) => {
      if (!['error', 'awaiting_user_action', 'continue_required'].includes(params.reason) || !preview && typeof params.dedupeKey !== 'string') throw new Error('通知参数无效。');
      if (params.conversationId) await application.conversation(client.actorId, params.conversationId);
      return { success: true, ...await (preview ? host.notifications.preview(params as any) : host.notifications.notify(params as any)) };
    };
    const groups: RequestGroup[] = [
      {
        prefix: 'desktop.editor.', uiRequest: true, owner: false, duringClose: true,
        handlers: {
          status: { execute: () => host.editorRegistration.status() },
          register: { execute: () => host.editorRegistration.register() },
          defaults: { execute: async () => {
            const status = await host.editorRegistration.status();
            if (!status.registered) throw new Error('请先将当前 GrayCode 注册为代码编辑器。');
            await shell.openExternal('ms-settings:defaultapps?registeredAppUser=GrayCode'); return { success: true };
          } },
        },
      },
      {
        prefix: 'backup.', uiRequest: true,
        handlers: {
          status: { execute: () => backups.status() },
          cancel: { execute: () => { backups.cancel(); return { success: true }; } },
          cancelRestore: { execute: async () => { await backups.cancelRestore(); return { success: true }; } },
          preview: { execute: () => backups.previewRestore() },
          select: { execute: params => backups.selectRestore(params.selection) },
          export: { execute: async params => {
            const selected = await dialog.showSaveDialog(host.getWindow()!, { title: '备份程序数据',
              defaultPath: `GrayCode-${new Date().toISOString().slice(0, 10)}.graycode-backup`,
              filters: [{ name: 'GrayCode 程序数据备份', extensions: ['graycode-backup'] }] });
            if (selected.canceled || !selected.filePath) return { cancelled: true };
            return backups.export(selected.filePath, params.password || undefined);
          } },
          restore: { execute: async params => {
            if (storageLocation.getConfig().config.pendingMigration) throw new Error('请先完成数据目录迁移，再恢复备份。');
            const selected = await dialog.showOpenDialog(host.getWindow()!, { title: '选择程序数据备份', properties: ['openFile'],
              filters: [{ name: 'GrayCode 程序数据备份', extensions: ['graycode-backup'] }] });
            if (selected.canceled || !selected.filePaths[0]) return { cancelled: true };
            return backups.prepareRestore(selected.filePaths[0], params.password || undefined, { previewOnly: params.previewOnly === true });
          } },
          restart: { execute: async () => {
            const pending = (await backups.status()).pending;
            if (!pending) throw new Error('没有等待应用的备份。');
            if (pending.requiresSelection && !pending.selection) throw new Error('请先选择恢复范围并查看最终预览。');
            if (await hasDirtyState()) throw new Error('请先保存或放弃编辑器与设置中的修改，再应用备份。');
            const selected = await dialog.showMessageBox(host.getWindow()!, { type: 'question', title: '恢复程序数据',
              message: pending.selection?.mode === 'selective' ? '重启并恢复最终预览中的所选数据？' : '重启并应用完整备份？', detail: '当前任务和连接将停止，恢复前的数据目录会完整保留。项目源码不会被替换。',
              buttons: ['重启并恢复', '继续工作'], defaultId: 1, cancelId: 1 });
            if (selected.response !== 0) return { cancelled: true };
            await backups.confirmRestore(pending);
            setTimeout(() => { void host.quit(true).catch(error => dialog.showErrorBox('GrayCode 恢复失败', String(error))); }, 100);
            return { success: true };
          } },
        },
      },
      {
        prefix: 'desktop.updates.', uiRequest: true,
        handlers: {
          status: { execute: () => installer.status() },
          apply: { execute: () => installer.apply() },
          rollback: { execute: () => installer.rollback() },
          openRecovery: { execute: async () => {
            const recovery = (await installer.status()).recovery;
            if (!recovery) throw new Error('当前没有保存的回退点。');
            const error = await shell.openPath(path.dirname(recovery.backupPath));
            if (error) throw new Error(error);
            return { success: true };
          } },
          local: { execute: async () => {
            const selected = await dialog.showOpenDialog(host.getWindow()!, { title: '选择离线更新清单', properties: ['openFile'],
              filters: [{ name: 'GrayCode 更新清单（releases.win-x64.json）', extensions: ['json'] }] });
            if (selected.canceled || !selected.filePaths[0]) return { cancelled: true };
            if (path.basename(selected.filePaths[0]) !== 'releases.win-x64.json') throw new Error('请选择发行包附带的 releases.win-x64.json，并将完整更新包放在同一目录。');
            return installer.prepare(path.dirname(selected.filePaths[0]));
          } },
        },
      },
      {
        prefix: '',
        handlers: {
          'desktop.files.ready': { owner: false, duringClose: true, execute: async () => { await host.desktopFiles.clientReady(); return { success: true }; } },
          'files.reveal': { owner: false, execute: params => revealWorkspaceFile(application, shell, client.actorId, params as { workspaceId: string; path: string }) },
          'files.openOffice': { owner: false, execute: params => openOfficeFile(application, shell, client.actorId, params as { workspaceId: string; path: string }) },
          'workspace.openInExplorer': { owner: false, execute: params => openWorkspaceInExplorer(application, shell, client.actorId, params) },
          'desktop.pet.expand': { owner: false, execute: params => host.petWindow.expand(params.expanded === true) },
          'desktop.pet.manage': { owner: false, execute: params => openPetSurface('manage', params) },
          'desktop.pet.screenSense': { owner: false, execute: params => openPetSurface('screenSense', params) },
          'desktop.pet.openConversation': { owner: false, execute: params => openPetSurface('conversation', params) },
          getAppInfo: { uiRequest: true, execute: () => ({ name: 'GrayCode', displayName: 'GrayCode', version: app.getVersion(), publisher: 'Komeiji-Shiki', runtime: 'desktop',
            ...host.build, executablePath: app.getPath('exe') }) },
          getUpdateStatus: { uiRequest: true, execute: () => updates.get() },
          checkUpdateNow: { uiRequest: true, execute: () => updates.check() },
          openUpdatePage: { uiRequest: true, execute: () => updates.open() },
          updateNow: { uiRequest: true, execute: () => updates.prepare(true) },
          installUpdate: { uiRequest: true, execute: () => updates.prepare(false) },
          'notifications.agentStop': { uiRequest: true, execute: params => agentNotification(params, false) },
          'notifications.preview': { uiRequest: true, execute: params => agentNotification(params, true) },
          exportPromptModes: { uiRequest: true, execute: async params => {
            if (typeof params.content !== 'string') throw new Error('预设内容无效。');
            const selected = await dialog.showSaveDialog(host.getWindow()!, { title: '导出提示词预设', defaultPath: path.basename(String(params.filename ?? 'graycode-prompt-modes.json')), filters: [{ name: 'JSON', extensions: ['json'] }] });
            if (selected.canceled || !selected.filePath) return { success: false, cancelled: true };
            await writeFile(selected.filePath, params.content, 'utf8'); return { success: true, filePath: selected.filePath };
          } },
          'storagePath.getConfig': { uiRequest: true, execute: () => storageLocation.getConfig() },
          'storagePath.validate': { uiRequest: true, execute: params => storageLocation.validate(params.path) },
          'storagePath.migrate': { uiRequest: true, execute: params => scheduleStorage(params.path) },
          'storagePath.reset': { uiRequest: true, execute: () => scheduleStorage(storageLocation.defaultPath) },
          'storagePath.selectFolder': { uiRequest: true, execute: async () => {
            const selected = await dialog.showOpenDialog(host.getWindow()!, { title: '选择数据目录', properties: ['openDirectory', 'createDirectory'] });
            return { path: selected.canceled ? null : selected.filePaths[0] };
          } },
          'storagePath.openInExplorer': { uiRequest: true, execute: params => openDataDirectory(params.path ? String(params.path) : host.dataDirectory) },
          'conversation.revealInExplorer': { uiRequest: true, execute: async params => {
            await application.conversation(client.actorId, params.conversationId);
            return openDataDirectory(host.dataDirectory);
          } },
          reloadWindow: { uiRequest: true, execute: async () => {
            if (await host.activeTasks() || await hasDirtyState()) throw new Error('请先结束任务、保存或放弃编辑器与设置中的修改，再重启应用。');
            setTimeout(() => { void host.quit(true).catch(error => dialog.showErrorBox('GrayCode 重启失败', String(error))); }, 100);
            return { success: true };
          } },
          openDirectory: { uiRequest: true, execute: async params => {
            const target = String(params.path ?? '');
            if (!path.isAbsolute(target)) throw new Error('请选择完整的目录路径。');
            const error = await shell.openPath(target);
            if (error) throw new Error(error);
            return { success: true };
          } },
          'settings.import': { uiRequest: true, execute: async () => {
            const selected = await dialog.showOpenDialog(host.getWindow()!, { title: '导入 GrayCode 设置', properties: ['openFile'], filters: [{ name: 'GrayCode 设置', extensions: ['json'] }] });
            if (selected.canceled) return { cancelled: true };
            const value = JSON.parse((await readFile(selected.filePaths[0], 'utf8')).replace(/^\uFEFF/, ''));
            return router.call(client, 'ui.request', { type: 'settings.importData', data: { value } });
          } },
          'settings.export': { uiRequest: true, execute: async () => {
            const selected = await dialog.showSaveDialog(host.getWindow()!, { title: '导出 GrayCode 设置', defaultPath: 'graycode-settings.json', filters: [{ name: 'JSON', extensions: ['json'] }] });
            if (selected.canceled || !selected.filePath) return { cancelled: true };
            const value = await router.call(client, 'ui.request', { type: 'settings.exportData', data: {} });
            await writeFile(selected.filePath, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
            return { success: true, filePath: selected.filePath };
          } },
          'desktop.chooseWorkspace': { uiRequest: true, execute: async () => {
            const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
            return result.canceled ? null : { directory: result.filePaths[0], name: path.basename(result.filePaths[0]) };
          } },
          'desktop.menu': { execute: params => {
            const item = Menu.getApplicationMenu()?.items.find(item => item.label === params.label);
            item?.submenu?.popup({ window: host.getWindow()! });
          } },
          'desktop.fonts': { uiRequest: true, execute: params => systemFonts(params.refresh === true) },
          'desktop.clipboard.writeText': { execute: async params => {
            if (typeof params.text !== 'string') throw new Error('复制内容必须是文本。');
            await clipboard.writeText(params.text); return { success: true };
          } },
          'desktop.clipboard.writeImage': { execute: async params => {
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
          } },
          'files.download': { execute: async params => {
            const file = await application.fileActions.download(client.actorId, params.workspaceId, params.path);
            const selected = await dialog.showSaveDialog(host.getWindow()!, { title: '另存文件', defaultPath: file.name, properties: ['showOverwriteConfirmation'] });
            if (selected.canceled || !selected.filePath) return { cancelled: true };
            const sameFile = process.platform === 'win32' ? path.resolve(selected.filePath).toLowerCase() === file.absolute.toLowerCase() : path.resolve(selected.filePath) === file.absolute;
            if (sameFile) throw new Error('请选择不同的保存位置。');
            await copyFile(file.absolute, selected.filePath); return { success: true, filePath: selected.filePath };
          } },
          'desktop.saveResult': { execute: (params, senderId) => { host.saveAll.complete(senderId, params); return { success: true }; } },
          'desktop.dirtyDocuments': { execute: params => { host.setDirtyDocuments(Math.max(0, Number(params.count) || 0)); } },
          'desktop.dirtySettings': { uiRequest: true, execute: params => { host.setDirtySettings(params.dirty === true); } },
        },
      },
    ];
    for (const { prefix, handlers, ...policy } of groups) {
      // 整组前缀保留旧协议对未知子方法的转换，再交给既有服务端路由报告错误。
      if (prefix && policy.uiRequest) this.uiRequestPrefixes.push(prefix);
      for (const [name, handler] of Object.entries(handlers)) this.handlers.set(prefix + name, { ...policy, ...handler });
    }
  }

  async call(senderId: number, method: string, params: Params = {}): Promise<unknown> {
    const uiMethod = method === 'ui.request' && typeof params.type === 'string' ? params.type : undefined;
    if (uiMethod && (this.handlers.get(uiMethod)?.uiRequest || this.uiRequestPrefixes.some(prefix => uiMethod.startsWith(prefix)))) {
      method = uiMethod; params = params.data ?? {};
    }
    const handler = this.handlers.get(method);
    if (!handler?.duringClose && this.host.isClosing()) throw new Error('应用正在关闭，请稍后重新打开。');
    // 原桌面入口在处理完文件、桌宠等特定分支后，对其余消息及服务端回退统一要求 owner。
    if (handler?.owner !== false) this.host.application.requireOwner(this.host.client.actorId);
    return handler ? handler.execute(params, senderId) : this.host.router.call(this.host.client, method, params);
  }
}
