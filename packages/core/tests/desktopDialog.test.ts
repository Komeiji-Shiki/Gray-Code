import { BrowserWindow, dialog, ipcMain } from 'electron';
import { desktopDialogHtml } from '../../../apps/desktop/src/desktopDialogContent';
import { showDesktopConfirmation, showDesktopProgress } from '../../../apps/desktop/src/desktopDialog';
import { createIdleCloseCheck } from '../../../apps/desktop/src/idleClose';

jest.mock('electron', () => {
  const { EventEmitter } = require('node:events');
  class Window extends EventEmitter {
    static all: Window[] = [];
    destroyed = false;
    webContents = Object.assign(new EventEmitter(), { mainFrame: {}, setWindowOpenHandler: jest.fn(), send: jest.fn() });
    options: unknown;
    constructor(options: unknown) { super(); this.options = options; Window.all.push(this); }
    isDestroyed() { return this.destroyed; }
    isVisible() { return true; }
    getBounds() { return { x: 0, y: 0, width: 1000, height: 700 }; }
    setMenu = jest.fn(); show = jest.fn(); focus = jest.fn();
    loadURL = jest.fn().mockResolvedValue(undefined);
    destroy() { if (!this.destroyed) { this.destroyed = true; this.emit('closed'); } }
  }
  return { BrowserWindow: Window, ipcMain: new EventEmitter(), dialog: { showMessageBox: jest.fn() },
    screen: { getPrimaryDisplay: () => ({ workArea: { width: 1920, height: 1080 } }), getDisplayMatching: () => ({ workArea: { width: 1920, height: 1080 } }) } };
});
const windows = () => (BrowserWindow as any).all as any[];
const content = { title: '退出', message: '结束工作？', cancelId: 'cancel', actions: [{ id: 'cancel', label: '继续工作' }, { id: 'quit', label: '退出应用' }] };
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
afterEach(() => { for (const window of windows()) window.destroy(); windows().length = 0; ipcMain.removeAllListeners(); jest.clearAllMocks(); });

test('对话框转义动态文本，只有安全颜色可进入 CSS，取消按钮默认聚焦', () => {
  const html = desktopDialogHtml({ ...content, title: '<script>x</script>', colors: { accent: '#aabbcc', text: 'red; background:url(http://evil)' }, items: ['<img src=x>'] });
  expect(html).toContain('&lt;script&gt;'); expect(html).not.toContain('<script>'); expect(html).toContain('&lt;img src=x&gt;');
  expect(html).toContain('--accent:#aabbcc'); expect(html).not.toContain('http://evil'); expect(html).toContain('data-dialog-cancel="true" autofocus'); expect(html).toContain("default-src 'none'");
});
test('对话框默认取品牌色板，主按钮使用主按钮配色，窗口底色跟随传入色板', async () => {
  const html = desktopDialogHtml(content);
  expect(html).toContain('--background:#17181b'); expect(html).toContain('--button:#f2eee5'); expect(html).toContain('--button-text:#232a42');
  expect(html).toMatch(/button\.primary\{[^}]*background:var\(--button\);color:var\(--button-text\)/);
  const promise = showDesktopConfirmation({ ...content, colors: { background: '#181817' } });
  expect(windows().at(-1).options.backgroundColor).toBe('#181817');
  windows().at(-1).destroy(); expect(await promise).toBe('cancel');
});
test('只有本窗口主框架和允许的动作可完成确认，完成后移除监听', async () => {
  const promise = showDesktopConfirmation(content); const window = windows().at(-1);
  expect(window.options.webPreferences).toMatchObject({ sandbox: true, nodeIntegration: false, contextIsolation: true });
  const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
  ipcMain.emit('graycode:dialog-result', { ...event, senderFrame: {} }, 'quit');
  ipcMain.emit('graycode:dialog-result', { ...event, sender: {} }, 'quit');
  ipcMain.emit('graycode:dialog-result', event, 'arbitrary-command'); expect(window.destroyed).toBe(false);
  ipcMain.emit('graycode:dialog-result', event, 'quit'); expect(await promise).toBe('quit'); expect(ipcMain.listenerCount('graycode:dialog-result')).toBe(0);
});
test('渲染进程崩溃或窗口关闭一律取消', async () => {
  const promise = showDesktopConfirmation(content); windows().at(-1).webContents.emit('render-process-gone'); expect(await promise).toBe('cancel');
  const next = showDesktopConfirmation(content); windows().at(-1).destroy(); expect(await next).toBe('cancel');
});
test('预加载失败时使用默认取消的原生兜底，保留详细提示', async () => {
  (dialog.showMessageBox as jest.Mock).mockResolvedValue({ response: 0 });
  const promise = showDesktopConfirmation({ ...content, items: ['未保存的文件'] });
  windows().at(-1).webContents.emit('preload-error', {}, '/missing.cjs', new Error('preload failed'));
  expect(await promise).toBe('cancel'); expect(dialog.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({ defaultId: 0, cancelId: 0, detail: '未保存的文件' }));
});
test('进度窗口仅更新状态，清理可重复调用', async () => {
  const progress = await showDesktopProgress({ title: '退出', message: '正在关闭', progress: '备份' }); const window = windows().at(-1);
  progress.update('停止任务'); expect(window.webContents.send).toHaveBeenCalledWith('graycode:dialog-progress', '停止任务');
  const event = { preventDefault: jest.fn() }; window.emit('close', event); expect(event.preventDefault).toHaveBeenCalled();
  progress.close(); progress.close(); progress.update('晚到的状态'); expect(window.destroyed).toBe(true); expect(window.webContents.send).toHaveBeenCalledTimes(1);
});
test('后台状态突发事件合并查询，旧空闲快照不能提前退出', async () => {
  let resolve!: (value: boolean) => void;
  const first = new Promise<boolean>(done => { resolve = done; });
  const active = jest.fn().mockReturnValueOnce(first).mockResolvedValue(true), close = jest.fn().mockResolvedValue(undefined), report = jest.fn();
  const check = createIdleCloseCheck({ pending: () => true, active, close, report });
  check(); for (let i = 0; i < 100; i++) check(); expect(active).toHaveBeenCalledTimes(1);
  resolve(false); await tick(); expect(active).toHaveBeenCalledTimes(2); expect(close).not.toHaveBeenCalled(); expect(report).not.toHaveBeenCalled();
});
test('重新打开窗口使待退出检查失效', async () => {
  let pending = true, resolve!: (value: boolean) => void; const close = jest.fn();
  const check = createIdleCloseCheck({ pending: () => pending, active: () => new Promise(done => { resolve = done; }), close, report: jest.fn() });
  check(); pending = false; resolve(false); await tick(); expect(close).not.toHaveBeenCalled();
});
