import { BrowserWindow, dialog, ipcMain, screen } from 'electron';
import path from 'node:path';
import { desktopDialogHtml, type DesktopDialogContent } from './desktopDialogContent';
import { resolveAppearancePalette } from '../../../shared/appearance';

function createDialog(content: DesktopDialogContent, parent?: BrowserWindow) {
  const owner = parent && !parent.isDestroyed() && parent.isVisible() ? parent : undefined;
  const area = owner ? screen.getDisplayMatching(owner.getBounds()).workArea : screen.getPrimaryDisplay().workArea;
  const window = new BrowserWindow({
    width: Math.min(650, area.width), height: Math.min(content.items?.length ? 450 : 385, area.height),
    parent: owner, modal: !!owner, show: false, frame: false, resizable: false, minimizable: false, maximizable: false,
    // 与对话框 HTML 相同，只接受十六进制字面值；手动输入的不完整颜色回落默认色板。
    title: content.title, backgroundColor: /^#(?:[\da-f]{3}|[\da-f]{6}|[\da-f]{8})$/i.test(content.colors?.background ?? '') ? content.colors!.background : resolveAppearancePalette('dark').background, autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'desktopDialogPreload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  window.setMenu(null);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  return window;
}
function loadDialog(window: BrowserWindow, content: DesktopDialogContent): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const complete = (error?: Error) => {
      if (settled) return;
      settled = true; clearTimeout(timeout);
      window.webContents.removeListener('preload-error', preloadFailed);
      window.removeListener('closed', closed);
      if (error) reject(error); else resolve();
    };
    const preloadFailed = (_event: unknown, _path: string, error: Error) => complete(error);
    const closed = () => complete(new Error('对话框已关闭。'));
    const timeout = setTimeout(() => complete(new Error('对话框加载超时。')), 15_000);
    timeout.unref();
    window.webContents.once('preload-error', preloadFailed);
    window.once('closed', closed);
    void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(desktopDialogHtml(content))}`).then(() => {
      if (!settled && !window.isDestroyed()) { window.show(); window.focus(); }
      complete();
    }, error => complete(error instanceof Error ? error : new Error(String(error))));
  });
}
/** 仅同一个窗口的主框架能够选择明确列出的动作；关闭窗口视为取消。 */
export async function showDesktopConfirmation(content: DesktopDialogContent & { cancelId: string }, parent?: BrowserWindow): Promise<string> {
  if (!content.actions.some(action => action.id === content.cancelId)) throw new Error('Missing dialog cancel action.');
  const window = createDialog(content, parent);
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const finish = (action: string) => {
      if (settled) return;
      settled = true; ipcMain.removeListener('graycode:dialog-result', choose);
      if (!window.isDestroyed()) window.destroy();
      resolve(action);
    };
    const choose = (event: Electron.IpcMainEvent, action: unknown) => {
      if (window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) return;
      if (typeof action === 'string' && content.actions.some(item => item.id === action)) finish(action);
    };
    ipcMain.on('graycode:dialog-result', choose);
    window.once('closed', () => finish(content.cancelId));
    const fail = () => finish(content.cancelId);
    window.webContents.once('render-process-gone', fail);
    void loadDialog(window, content).catch(async error => {
      if (settled) return;
      // 渲染不可用时保留系统确认，默认动作仍然是取消。
      ipcMain.removeListener('graycode:dialog-result', choose);
      settled = true;
      if (!window.isDestroyed()) window.destroy();
      try {
        const cancelId = content.actions.findIndex(action => action.id === content.cancelId);
        const result = await dialog.showMessageBox({ type: 'question', title: content.title, message: content.message,
          detail: [content.detail, ...content.items ?? []].filter(Boolean).join('\n'),
          buttons: content.actions.map(action => action.label), defaultId: cancelId, cancelId });
        resolve(content.actions[result.response]?.id ?? content.cancelId);
      } catch { reject(error); }
    });
  });
}
export interface DesktopProgress { update(text: string): void; close(): void }
export async function showDesktopProgress(content: Omit<DesktopDialogContent, 'actions'>, parent?: BrowserWindow): Promise<DesktopProgress> {
  const window = createDialog({ ...content, actions: [] }, parent);
  window.on('close', event => event.preventDefault());
  try { await loadDialog(window, { ...content, actions: [] }); }
  catch (error) { if (!window.isDestroyed()) window.destroy(); throw error; }
  return {
    update: text => { if (!window.isDestroyed()) window.webContents.send('graycode:dialog-progress', text); },
    close: () => { if (!window.isDestroyed()) window.destroy(); },
  };
}
