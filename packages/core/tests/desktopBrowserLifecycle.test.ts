import type { Input, MouseInputEvent, MouseWheelInputEvent } from 'electron';
import type { BrowserTab } from '@graycode/contracts';
import type { ToolContext } from '@graycode/core';
import type { PlatformApplication } from '../../../apps/server/src/application';
import { DesktopBrowser } from '../../../apps/desktop/src/browser';

const mockViews: any[] = []; const mockHosts: any[] = []; const mockPages: any[] = [];
const mockConnect = jest.fn(async () => {});
jest.mock('@graycode/core', () => ({ authorizeEffects: () => undefined }));
jest.mock('../../../apps/desktop/src/browser/page', () => ({ BrowserPage: class {
  automated = false; connect = mockConnect; invalidate = jest.fn();
  allowManualInput = jest.fn(() => { this.automated = false; });
  action = jest.fn(async () => {}); snapshot = jest.fn(async () => ({ nodes: [] }));
  screenshot = jest.fn(async (signal: AbortSignal) => {
    signal.throwIfAborted();
    return { observation: { id: 'fixture-observation', url: 'about:blank' }, attachment: { mimeType: 'image/png', data: 'fixture' } };
  });
  constructor() { mockPages.push(this); }
} }));
jest.mock('../../../apps/desktop/src/browser/transfers', () => ({ BrowserTransfers: class {} }));
jest.mock('electron', () => {
  const { EventEmitter } = jest.requireActual('node:events');
  return {
    session: { fromPartition: () => ({ setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, on() {}, protocol: { isProtocolHandled: async () => true } }) },
    WebContentsView: class {
      bounds = { x: 0, y: 0, width: 1100, height: 800 };
      destroyed = false; finish!: () => void; fail!: (error: Error) => void;
      loading = new Promise<void>((resolve, reject) => { this.finish = resolve; this.fail = reject; });
      webContents = Object.assign(new EventEmitter(), { isDestroyed: () => this.destroyed, close: jest.fn(() => { this.destroyed = true; }),
        loadURL: () => this.loading, setWindowOpenHandler() {}, getURL: () => 'about:blank', getTitle: () => '',
        navigationHistory: { canGoBack: () => false, canGoForward: () => false } });
      constructor() { mockViews.push(this); }
      getBounds() { return this.bounds; } setBounds(value: any) { this.bounds = value; } setVisible() {}
    },
    BaseWindow: class {
      visible = false; minimized = false; destroyed = false;
      // Electron 会自动从原宿主移除 view；模拟这一边界才能测试最小化后的后台重挂载。
      contentView = { children: [] as any[], addChildView: (view: any) => {
        for (const host of mockHosts) host.contentView.children = host.contentView.children.filter((item: any) => item !== view);
        this.contentView.children.push(view);
      },
        removeChildView: (view: any) => { this.contentView.children = this.contentView.children.filter(item => item !== view); } };
      webContents = { getZoomFactor: () => 1 }; on() {} off() {}
      constructor() { mockHosts.push(this); }
      isDestroyed() { return this.destroyed; } isVisible() { return this.visible; } isMinimized() { return this.minimized; }
      getContentSize() { return [1100, 800]; } setIgnoreMouseEvents() {} setContentSize() {}
      showInactive() { this.visible = true; } hide() { this.visible = false; } close() { this.destroyed = true; }
    },
  };
});
const settle = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture(listRecords = jest.fn(async () => [] as string[])) {
  const unsubscribe = jest.fn();
  const app = { actor: () => ({ id: 'owner' }), requireOwner() {}, subscribe: () => unsubscribe,
    storage: { listRecords, getRecord: jest.fn(), commitRecords: jest.fn(), putRecord: jest.fn() } } as unknown as PlatformApplication;
  const browser = new DesktopBrowser(app, () => undefined, jest.fn());
  return { browser, unsubscribe };
}
beforeEach(() => { mockViews.length = 0; mockHosts.length = 0; mockPages.length = 0; mockConnect.mockClear(); });

test('关闭发生在登录配置读取期间时不创建原生网页', async () => {
  let finish!: (value: string[]) => void;
  const { browser, unsubscribe } = fixture(jest.fn(() => new Promise<string[]>(resolve => { finish = resolve; })));
  const opening = browser.call('owner', 'browser.newTab', {}); const rejected = expect(opening).rejects.toThrow('浏览器正在关闭');
  await settle(); browser.close(); finish([]); await rejected;
  expect(mockViews).toHaveLength(0); expect(unsubscribe).toHaveBeenCalledTimes(1);
});

test('初始网页加载期间关闭宿主后不连接已销毁的页面', async () => {
  const { browser } = fixture();
  const opening = browser.call('owner', 'browser.newTab', {}); const rejected = expect(opening).rejects.toThrow('网页标签已关闭');
  await settle(); expect(mockViews).toHaveLength(1);
  browser.close(); mockViews[0].finish(); await rejected;
  expect(mockViews[0].destroyed).toBe(true); expect(mockConnect).not.toHaveBeenCalled();
  expect(mockHosts[0].destroyed).toBe(true);
});

test('初始网页加载失败释放页面并从标签列表移除', async () => {
  const { browser } = fixture();
  try {
    const opening = browser.call('owner', 'browser.newTab', {}); const rejected = expect(opening).rejects.toThrow('load failed');
    await settle(); mockViews[0].fail(new Error('load failed')); await rejected;
    expect(mockViews[0].destroyed).toBe(true); expect(mockHosts[0].contentView.children).toHaveLength(0);
    expect((await browser.state('owner')).tabs).toHaveLength(0); expect(mockHosts[0].visible).toBe(false);
  } finally { browser.close(); }
});

async function automatedTab(profileId?: string) {
  const { browser } = fixture();
  const context: ToolContext = { actorId: 'owner', runId: 'browser-run', toolCallId: 'browser-call',
    signal: new AbortController().signal, askUser: jest.fn(), progress: jest.fn() };
  try {
    const opening = browser.tool('browser_tabs', { action: 'create', profileId }, context);
    await settle(); mockViews[0].finish();
    const tab = (await opening).data as BrowserTab;
    await browser.tool('browser_read', { action: 'screenshot', tabId: tab.id }, context);
    const page = mockPages[0], contents = mockViews[0].webContents;
    const signal: AbortSignal = page.screenshot.mock.calls[0][0];
    return { browser, context, tab, page, contents, signal };
  } catch (error) { browser.close(); throw error; }
}

const keyboardInput = (type: 'keyDown' | 'keyUp', isAutoRepeat = false): Input => ({
  type, key: 'Enter', code: 'Enter', isAutoRepeat, isComposing: false,
  shift: false, control: false, alt: false, meta: false, location: 0, modifiers: [],
});
const activeMouseInputs: (MouseInputEvent | MouseWheelInputEvent)[] = [
  { type: 'mouseDown', x: 20, y: 30, button: 'left', modifiers: ['leftbuttondown'], clickCount: 1 },
  { type: 'mouseUp', x: 20, y: 30, button: 'left', modifiers: [], clickCount: 1 },
  { type: 'contextMenu', x: 20, y: 30, button: 'right', modifiers: [] },
  { type: 'mouseWheel', x: 20, y: 30, deltaY: 120, modifiers: [] } satisfies MouseWheelInputEvent,
  ...(['mouseMove', 'mouseEnter', 'mouseLeave'] as const).flatMap(type =>
    (['leftbuttondown', 'middlebuttondown', 'rightbuttondown'] as const).map(modifier => ({ type, x: 20, y: 30, modifiers: [modifier] }))),
];

test.each([undefined, '', ' \t\r\n '])('browser_tabs.create 可选 profileId %j 使用默认配置', async profileId => {
  const f = await automatedTab(profileId);
  try { expect(f.tab.profileId).toBe('default:owner'); } finally { f.browser.close(); }
});

test('仅选择显示标签或被动鼠标经过不会取消租约，随后仍能截图', async () => {
  const f = await automatedTab();
  try {
    await f.browser.call('owner', 'browser.select', { tabId: f.tab.id });
    await f.browser.tool('browser_tabs', { action: 'show', tabId: f.tab.id }, f.context);
    for (const type of ['mouseMove', 'mouseEnter', 'mouseLeave'] as const) {
      // Native Electron emits button: 'none' on hover (not a pressed button).
      f.contents.emit('before-mouse-event', {}, { type, x: 20, y: 30, button: 'none', modifiers: [] });
      f.contents.emit('before-mouse-event', {}, { type, x: 20, y: 30, modifiers: ['shift', 'control'] } satisfies MouseInputEvent);
      f.contents.emit('before-mouse-event', {}, { type, x: 20, y: 30 } satisfies MouseInputEvent);
    }
    expect(f.signal.aborted).toBe(false);
    expect(f.page.invalidate).not.toHaveBeenCalled(); expect(f.page.allowManualInput).not.toHaveBeenCalled();
    expect((await f.browser.state('owner')).tabs[0]).toMatchObject({ userControlled: false, controlledBy: { runId: f.context.runId } });
    await expect(f.browser.tool('browser_read', { action: 'screenshot', tabId: f.tab.id }, f.context)).resolves.toMatchObject({ success: true });
  } finally { f.browser.close(); }
});

test.each(activeMouseInputs)('主动鼠标 $type $modifiers 立即中止租约并保留事件原因', async mouse => {
  const f = await automatedTab();
  try {
    f.contents.emit('before-mouse-event', {}, mouse);
    expect(f.signal.aborted).toBe(true);
    expect(f.signal.reason.message).toContain(`before-mouse-event: ${mouse.type}`);
    expect(f.page.invalidate).toHaveBeenCalledTimes(1); expect(f.page.allowManualInput).toHaveBeenCalledTimes(1);
    const current = (await f.browser.state('owner')).tabs[0];
    expect(current.userControlled).toBe(true); expect(current.controlledBy).toBeUndefined();
    await expect(f.browser.tool('browser_read', { action: 'screenshot', tabId: f.tab.id }, f.context)).rejects.toThrow(`before-mouse-event: ${mouse.type}`);
  } finally { f.browser.close(); }
});

test.each([keyboardInput('keyDown'), keyboardInput('keyUp'), keyboardInput('keyDown', true)])('键盘 $type（repeat=$isAutoRepeat）仍立即接管', async input => {
  const f = await automatedTab();
  try {
    f.contents.emit('before-input-event', {}, input);
    expect(f.signal.aborted).toBe(true);
    expect(f.signal.reason.message).toContain(`before-input-event: ${input.type}`);
    expect(f.signal.reason.message).not.toContain(input.key);
    await expect(f.browser.tool('browser_read', { action: 'screenshot', tabId: f.tab.id }, f.context)).rejects.toThrow('用户已接管');
  } finally { f.browser.close(); }
});

test.each([false, true])('模型动作自身的鼠标键盘事件不触发接管，结束后恢复检测（动作失败=%s）', async fails => {
  const f = await automatedTab();
  try {
    f.page.action.mockImplementationOnce(async () => {
      for (const mouse of activeMouseInputs) f.contents.emit('before-mouse-event', {}, mouse);
      f.contents.emit('before-input-event', {}, keyboardInput('keyDown'));
      f.contents.emit('before-input-event', {}, keyboardInput('keyUp'));
      if (fails) throw new Error('fixture action failed');
    });
    const result = await f.browser.tool('browser_action', { action: 'click', tabId: f.tab.id, url: 'about:blank', observationId: 'fixture-observation', x: 20, y: 30 }, f.context);
    expect(result).toMatchObject({ success: !fails, data: { status: fails ? 'unknown' : 'completed' } });
    expect(f.signal.aborted).toBe(false); expect(f.page.allowManualInput).not.toHaveBeenCalled();
    f.contents.emit('before-mouse-event', {}, activeMouseInputs[0]);
    expect(f.signal.aborted).toBe(true); expect(f.page.allowManualInput).toHaveBeenCalledTimes(1);
  } finally { f.browser.close(); }
});

test('明确接管在模型工具进行中立即中止，之后选择显示和被动输入不会自动放行', async () => {
  const f = await automatedTab();
  try {
    f.page.snapshot.mockImplementationOnce((signal: AbortSignal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const reading = f.browser.tool('browser_read', { action: 'snapshot', tabId: f.tab.id }, f.context);
    const rejected = expect(reading).rejects.toThrow('用户已接管');
    await settle();
    await f.browser.call('owner', 'browser.takeover', { tabId: f.tab.id });
    expect(f.signal.aborted).toBe(true); await rejected;
    await f.browser.call('owner', 'browser.select', { tabId: f.tab.id });
    f.contents.emit('before-mouse-event', {}, { type: 'mouseMove', x: 20, y: 30 } satisfies MouseInputEvent);
    expect((await f.browser.state('owner')).tabs[0].userControlled).toBe(true);
    await expect(f.browser.tool('browser_tabs', { action: 'show', tabId: f.tab.id }, f.context)).rejects.toThrow('用户已接管');
  } finally { f.browser.close(); }
});

test('普通手动标签输入不创建模型接管状态', async () => {
  const { browser } = fixture();
  try {
    const opening = browser.call('owner', 'browser.newTab', {});
    await settle(); mockViews[0].finish(); await opening;
    mockViews[0].webContents.emit('before-mouse-event', {}, activeMouseInputs[0]);
    mockViews[0].webContents.emit('before-input-event', {}, keyboardInput('keyDown'));
    expect(mockPages[0].allowManualInput).not.toHaveBeenCalled();
    expect((await browser.state('owner')).tabs[0].userControlled).toBe(false);
  } finally { browser.close(); }
});

// 超时可以安全补读截图，但必须保留已完成动作的回执，不能鼓励重新派发点击。
test('截图超时允许安全重读，动作后的观察错误明确禁止重复动作', async () => {
  const f = await automatedTab();
  const timeout = () => Object.assign(new Error('fixture capture timeout'), { code: 'BROWSER_CAPTURE_TIMEOUT' });
  try {
    f.page.screenshot.mockRejectedValueOnce(timeout());
    await expect(f.browser.tool('browser_read', { action: 'screenshot', tabId: f.tab.id }, f.context)).resolves.toMatchObject({
      success: false, code: 'BROWSER_CAPTURE_TIMEOUT', retryable: true, data: { id: f.tab.id },
    });
    await expect(f.browser.tool('browser_read', { action: 'screenshot', tabId: f.tab.id }, f.context)).resolves.toMatchObject({
      success: true, attachments: [{ mimeType: 'image/png', data: 'fixture' }],
    });
    f.page.screenshot.mockRejectedValueOnce(timeout());
    const action = await f.browser.tool('browser_action', { action: 'click', tabId: f.tab.id, url: 'about:blank', observationId: 'fixture-observation', x: 20, y: 30 }, f.context);
    expect(action).toMatchObject({ success: true, data: { status: 'completed', observationError: {
      code: 'BROWSER_CAPTURE_TIMEOUT', message: expect.stringContaining('不要重复刚才的动作'),
    } } });
    expect(action.retryable).toBeUndefined(); expect(f.page.action).toHaveBeenCalledTimes(1);
  } finally { f.browser.close(); }
});

// 主窗隐藏/最小化只改变绘制宿主；自动观察不应显示或恢复用户的工作台窗口。
test.each(['hidden', 'minimized'] as const)('后台截图在主窗 %s 时挂到透明宿主，恢复布局后回到工作台', async mode => {
  const f = await automatedTab();
  const { BaseWindow } = jest.requireMock('electron');
  const parent = new BaseWindow();
  parent.visible = true;
  (f.browser as any).getWindow = () => parent;
  const layout = { x: 20, y: 30, width: 700, height: 500, visible: true };
  try {
    f.browser.layout(layout);
    expect(parent.contentView.children).toContain(mockViews[0]);
    parent.visible = mode !== 'hidden'; parent.minimized = mode === 'minimized';
    await expect(f.browser.tool('browser_read', { action: 'screenshot', tabId: f.tab.id }, f.context)).resolves.toMatchObject({ success: true });
    expect(mockHosts[0].contentView.children).toContain(mockViews[0]);
    expect(parent.contentView.children).not.toContain(mockViews[0]);
    expect(parent.visible).toBe(mode !== 'hidden'); expect(parent.minimized).toBe(mode === 'minimized');
    expect(f.page.screenshot).toHaveBeenLastCalledWith(expect.any(AbortSignal), { x: 0, y: 0, width: 700, height: 500 }, 1280);
    parent.visible = true; parent.minimized = false; f.browser.layout(layout);
    expect(parent.contentView.children).toContain(mockViews[0]);
  } finally { f.browser.close(); }
});
