import type { Input, MouseInputEvent, MouseWheelInputEvent } from 'electron';
import type { BrowserTab } from '@graycode/contracts';
import type { ToolContext } from '@graycode/core';
import type { PlatformApplication } from '../../../apps/server/src/application';
import { DesktopBrowser } from '../../../apps/desktop/src/browser';

const mockViews: any[] = []; const mockHosts: any[] = []; const mockPages: any[] = [];
const mockConnect = jest.fn(async () => {});
jest.mock('@graycode/core', () => ({ authorizeEffects: () => undefined }));
jest.mock('../../../apps/desktop/src/browser/page', () => ({ BrowserPage: class {
  automated = false; revision = 0; connect = mockConnect; invalidate = jest.fn(() => { this.revision++; });
  allowManualInput = jest.fn(() => { this.automated = false; });
  action = jest.fn(async () => {}); snapshot = jest.fn(async (..._args: unknown[]) => ({ nodes: [] }));
  snapshotAfterAction = jest.fn((...args: unknown[]) => this.snapshot(...args));
  log = jest.fn();
  waitForSnapshot = jest.fn(async () => ({ conditionMet: false, timedOut: true, nodes: [] }));
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
        loadURL: jest.fn(() => this.loading), stop: jest.fn(), setBackgroundThrottling: jest.fn(),
        setWindowOpenHandler: (handler: unknown) => { this.webContents.openHandler = handler; }, openHandler: undefined as any,
        getURL: () => 'about:blank', getTitle: () => '',
        navigationHistory: { canGoBack: () => false, canGoForward: () => false } });
      constructor() { mockViews.push(this); }
      visible = true;
      getBounds() { return this.bounds; } setBounds(value: any) { this.bounds = value; } setVisible(value: boolean) { this.visible = value; }
    },
    BaseWindow: class {
      visible = false; minimized = false; destroyed = false;
      // Electron 会自动从原宿主移除 view；模拟这一边界才能测试最小化后的后台重挂载。
      contentView = { children: [] as any[], addChildView: (view: any) => {
        for (const host of mockHosts) host.contentView.children = host.contentView.children.filter((item: any) => item !== view);
        this.contentView.children.push(view);
      },
        removeChildView: (view: any) => { this.contentView.children = this.contentView.children.filter(item => item !== view); } };
      webContents = { getZoomFactor: () => 1 }; listeners = new Map<string, Set<() => void>>();
      on(name: string, listener: () => void) { this.listeners.set(name, (this.listeners.get(name) ?? new Set()).add(listener)); }
      off(name: string, listener: () => void) { this.listeners.get(name)?.delete(listener); }
      emit(name: string) { for (const listener of this.listeners.get(name) ?? []) listener(); }
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
  return { browser, unsubscribe, app };
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
  const { browser, app } = fixture();
  const context: ToolContext = { actorId: 'owner', runId: 'browser-run', toolCallId: 'browser-call',
    signal: new AbortController().signal, askUser: jest.fn(), progress: jest.fn() };
  try {
    const opening = browser.tool('browser_tabs', { action: 'create', profileId }, context);
    await settle(); mockViews[0].finish();
    const tab = (await opening).data as BrowserTab;
    await browser.tool('browser_read', { action: 'screenshot', tabId: tab.id }, context);
    const page = mockPages[0], contents = mockViews[0].webContents;
    const signal: AbortSignal = page.screenshot.mock.calls[0][0];
    return { browser, context, tab, page, contents, signal, app };
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

test('读取及等待页面时实际键鼠输入立即接管，等待超时保留条件结果', async () => {
  const f = await automatedTab();
  try {
    const timeout = await f.browser.tool('browser_read', { action: 'wait', tabId: f.tab.id, query: '结果' }, f.context);
    expect(timeout).toMatchObject({ success: false, code: 'BROWSER_WAIT_TIMEOUT', data: { conditionMet: false, timedOut: true } });
    f.page.waitForSnapshot.mockImplementationOnce((signal: AbortSignal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      f.contents.emit('before-input-event', {}, keyboardInput('keyDown'));
    }));
    await expect(f.browser.tool('browser_read', { action: 'wait', tabId: f.tab.id, query: '结果' }, f.context)).rejects.toThrow('用户已接管');
    expect((await f.browser.state('owner')).tabs[0].userControlled).toBe(true);
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

test.each(['click', 'back'])('%s 后导航发生在观察期间，外层 URL/title 与新观察一致，重放仅补读', async action => {
  const f = await automatedTab();
  try {
    let url = 'about:blank', title = '';
    f.contents.getURL = () => url; f.contents.getTitle = () => title;
    f.contents.navigationHistory = { canGoBack: () => true, canGoForward: () => false, goBack: jest.fn() };
    f.page.screenshot.mockImplementation(async () => {
      url = 'https://example.test/next'; title = 'Next page';
      return { observation: { id: 'new-shot', url }, attachment: { mimeType: 'image/png', data: 'fixture' } };
    });
    const args = { action, tabId: f.tab.id, url: 'about:blank', ref: 'before' };
    const result = await f.browser.tool('browser_action', args, f.context);
    expect(result).toMatchObject({ success: true, data: { status: 'completed', url, title, observation: { url } } });
    const stored = (f.app.storage.putRecord as jest.Mock).mock.calls[0][0].value;
    (f.app.storage.getRecord as jest.Mock).mockResolvedValueOnce(stored);
    const replay = await f.browser.tool('browser_action', args, f.context);
    expect(replay).toMatchObject({ success: true, data: { repeated: true, url, title } });
    expect(action === 'click' ? f.page.action : f.contents.navigationHistory.goBack).toHaveBeenCalledTimes(1);
  } finally { f.browser.close(); }
});

test.each(['snapshot', 'both'] as const)('after=%s 返回新 ref 和筛选结果，不沿用动作 ref', async after => {
  const f = await automatedTab();
  try {
    f.page.screenshot.mockClear();
    f.page.snapshot.mockResolvedValueOnce({ url: 'about:blank', nodes: [{ ref: 'after-ref', role: 'button' }], nextOffset: 1 });
    const snapshotOptions = { compact: false, query: 'Next', role: 'button', maxNodes: 1, interactiveOnly: true };
    const result = await f.browser.tool('browser_action', { action: 'click', tabId: f.tab.id, url: 'about:blank', ref: 'before-ref', after, snapshotOptions }, f.context);
    expect(result).toMatchObject({ success: true, data: { status: 'completed', snapshot: { nodes: [{ ref: 'after-ref' }], nextOffset: 1 } } });
    expect(f.page.snapshot).toHaveBeenCalledWith(expect.any(AbortSignal), snapshotOptions);
    expect(f.page.screenshot).toHaveBeenCalledTimes(after === 'both' ? 1 : 0);
    expect(result.attachments?.length ?? 0).toBe(after === 'both' ? 1 : 0);
  } finally { f.browser.close(); }
});

test.each(['screenshot', 'snapshot'])('both 的 %s 失败保留另一种观察及动作回执', async failed => {
  const f = await automatedTab();
  try {
    f.page[failed].mockRejectedValueOnce(new Error('fixture observation failure'));
    const result = await f.browser.tool('browser_action', { action: 'click', tabId: f.tab.id, url: 'about:blank', ref: 'before', after: 'both' }, f.context);
    expect(result).toMatchObject({ success: true, data: { status: 'completed', [failed === 'screenshot' ? 'observationError' : 'snapshotError']: { message: expect.stringContaining('不要重复刚才的动作') } } });
    expect(result.data).toHaveProperty(failed === 'screenshot' ? 'snapshot' : 'observation');
    expect(result.retryable).toBeUndefined(); expect(f.page.action).toHaveBeenCalledTimes(1);
  } finally { f.browser.close(); }
});

test('both 两次观察之间同址导航，丢弃过期图片但保留新快照', async () => {
  const f = await automatedTab();
  try {
    f.page.snapshot.mockImplementationOnce(async () => { f.page.invalidate(); return { url: 'about:blank', nodes: ['new document'] }; });
    const result = await f.browser.tool('browser_action', { action: 'click', tabId: f.tab.id, url: 'about:blank', ref: 'before', after: 'both' }, f.context);
    expect(result).toMatchObject({ success: true, data: { status: 'completed', snapshot: { nodes: ['new document'] }, observationError: { code: 'BROWSER_PAGE_CHANGED' } } });
    expect(result.data).not.toHaveProperty('observation'); expect(result.attachments).toBeUndefined();
  } finally { f.browser.close(); }
});

test.each([{ after: 'none' }, { after: 'snapshot', snapshotOptions: { ref: 'old' } }, { after: 'both', snapshotOptions: { maxNodes: 0 } }, { snapshotOptions: {} }, { maxImageDimension: -1 }])('无效观察参数 %j 在派发前拒绝', async options => {
  const f = await automatedTab();
  try {
    await expect(f.browser.tool('browser_action', { action: 'click', tabId: f.tab.id, url: 'about:blank', ref: 'before', ...options }, f.context)).rejects.toThrow();
    expect(f.page.action).not.toHaveBeenCalled(); expect(f.app.storage.commitRecords).not.toHaveBeenCalled();
  } finally { f.browser.close(); }
});

function finishPopup(view: any) {
  view.webContents.loadURL.mockImplementation(async (target: string) => {
    view.webContents.getURL = () => target; view.webContents.getTitle = () => 'Library';
  });
  view.finish();
}

test.each([false, true])('新标签回执保留原页面，动作失败=%s 时同样保留打开事实及幂等回放', async fails => {
  const f = await automatedTab();
  try {
    f.page.action.mockImplementationOnce(async () => {
      f.contents.openHandler({ url: 'https://example.test/library' });
      if (fails) throw new Error('input acknowledgement lost');
    });
    const args = { action: 'click', tabId: f.tab.id, url: 'about:blank', ref: 'link', after: 'both' };
    const pending = f.browser.tool('browser_action', args, f.context);
    await settle(); expect(mockViews).toHaveLength(2); finishPopup(mockViews[1]);
    const result = await pending;
    expect(result).toMatchObject({ success: !fails, data: {
      status: fails ? 'unknown' : 'completed', openedTabs: [{ id: expect.any(String), status: 'opened', requestedUrl: 'https://example.test/library', url: 'https://example.test/library', controlledBy: { runId: f.context.runId } }],
    } });
    if (!fails) expect(result.data).toMatchObject({ id: f.tab.id, url: 'about:blank', observation: { url: 'about:blank' } });
    const stored = structuredClone((f.app.storage.putRecord as jest.Mock).mock.calls.at(-1)[0].value);
    (f.app.storage.getRecord as jest.Mock).mockResolvedValueOnce(stored);
    expect(await f.browser.tool('browser_action', args, f.context)).toMatchObject({ data: { repeated: true, openedTabs: (result.data as any).openedTabs } });
    expect(f.page.action).toHaveBeenCalledTimes(1); expect(mockViews).toHaveLength(2);
  } finally { f.browser.close(); }
});

test('并行来源的新标签不会混入当前动作回执', async () => {
  const f = await automatedTab();
  try {
    const other = f.browser.tool('browser_tabs', { action: 'create' }, { ...f.context, runId: 'other-run' });
    await settle(); mockViews[1].finish(); await other;
    f.page.action.mockImplementationOnce(async () => {
      f.contents.openHandler({ url: 'https://example.test/own' });
      mockViews[1].webContents.openHandler({ url: 'https://example.test/other' });
    });
    const pending = f.browser.tool('browser_action', { action: 'click', tabId: f.tab.id, url: 'about:blank', ref: 'link' }, f.context);
    await settle(); finishPopup(mockViews[2]); finishPopup(mockViews[3]);
    const result = await pending;
    expect((result.data as any).openedTabs).toHaveLength(1);
    expect((result.data as any).openedTabs[0].requestedUrl).toBe('https://example.test/own');
  } finally { f.browser.close(); }
});

test('新标签初始化失败作为新页错误返回，原动作仍已完成', async () => {
  const f = await automatedTab();
  try {
    f.page.action.mockImplementationOnce(async () => { f.contents.openHandler({ url: 'https://example.test/library' }); });
    const pending = f.browser.tool('browser_action', { action: 'click', tabId: f.tab.id, url: 'about:blank', ref: 'link' }, f.context);
    await settle(); mockViews[1].fail(new Error('popup failed'));
    expect(await pending).toMatchObject({ success: true, data: { status: 'completed', openedTabs: [{ status: 'failed', error: 'popup failed' }] } });
    expect(mockViews[1].destroyed).toBe(true);
  } finally { f.browser.close(); }
});

test('慢新页有界返回 opening，后续工具排在新页导航之后', async () => {
  const f = await automatedTab();
  jest.useFakeTimers({ doNotFake: ['setImmediate'] });
  let finish!: () => void;
  try {
    f.page.action.mockImplementationOnce(async () => { f.contents.openHandler({ url: 'https://example.test/slow' }); });
    const pending = f.browser.tool('browser_action', { action: 'click', tabId: f.tab.id, url: 'about:blank', ref: 'link' }, f.context);
    await settle();
    mockViews[1].webContents.loadURL.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    mockViews[1].finish(); await settle();
    await jest.advanceTimersByTimeAsync(1000);
    const result = await pending, opened = (result.data as any).openedTabs[0];
    expect(opened).toMatchObject({ id: expect.any(String), status: 'opening', requestedUrl: 'https://example.test/slow' });
    const reading = f.browser.tool('browser_read', { action: 'snapshot', tabId: opened.id }, f.context);
    await settle(); expect(mockPages[1].snapshot).not.toHaveBeenCalled();
    finish(); await reading; expect(mockPages[1].snapshot).toHaveBeenCalledTimes(1);
  } finally { finish?.(); jest.useRealTimers(); f.browser.close(); }
});

test('接管发生在新页初始化期间时中止新页，不继续导航', async () => {
  const f = await automatedTab();
  try {
    f.page.action.mockImplementationOnce(async () => { f.contents.openHandler({ url: 'https://example.test/library' }); });
    const pending = f.browser.tool('browser_action', { action: 'click', tabId: f.tab.id, url: 'about:blank', ref: 'link' }, f.context);
    await settle();
    f.contents.emit('before-mouse-event', {}, activeMouseInputs[0]);
    expect(f.signal.aborted).toBe(true); expect(mockViews[1].destroyed).toBe(true);
    mockViews[1].finish(); await pending; await settle();
    expect(mockViews[1].webContents.loadURL).toHaveBeenCalledTimes(1);
  } finally { f.browser.close(); }
});

test('已取消动作的迟到自动弹窗不再创建标签', async () => {
  const f = await automatedTab(), controller = new AbortController();
  try {
    f.page.action.mockImplementationOnce(async () => {
      controller.abort(new Error('任务取消'));
      expect(f.contents.openHandler({ url: 'https://example.test/late' })).toEqual({ action: 'deny' });
    });
    const result = await f.browser.tool('browser_action', { action: 'click', tabId: f.tab.id, url: 'about:blank', ref: 'link' }, { ...f.context, signal: controller.signal });
    expect(result).toMatchObject({ success: false, data: { status: 'unknown' } });
    expect(mockViews).toHaveLength(1); expect(result.data).not.toHaveProperty('openedTabs');
  } finally { f.browser.close(); }
});

test('动作后的观察期间真实键盘输入立即接管', async () => {
  const f = await automatedTab();
  try {
    f.page.screenshot.mockImplementationOnce(async (signal: AbortSignal) => {
      f.contents.emit('before-input-event', {}, keyboardInput('keyDown'));
      signal.throwIfAborted();
    });
    expect(await f.browser.tool('browser_action', { action: 'click', tabId: f.tab.id, url: 'about:blank', ref: 'link' }, f.context)).toMatchObject({
      success: true, data: { status: 'completed', observationError: { message: expect.stringContaining('用户已接管') } },
    });
    expect(f.signal.aborted).toBe(true); expect(f.page.action).toHaveBeenCalledTimes(1);
  } finally { f.browser.close(); }
});

// 后台节流跟随标签状态：只记录实际切换，创建时的 webPreferences 是关闭节流（false）。
const throttled = (contents: any) => contents.setBackgroundThrottling.mock.calls.at(-1)?.[0] ?? false;

test('租约和截图期间关闭后台节流，任务与截图都结束后才隐藏并恢复', async () => {
  const f = await automatedTab();
  try {
    // 自动化标签创建时不可见，申领租约后立即关闭节流，截图时不重复切换。
    expect(f.contents.setBackgroundThrottling.mock.calls).toEqual([[true], [false]]);
    let release!: () => void;
    f.page.screenshot.mockImplementationOnce(async () => {
      await new Promise<void>(resolve => { release = resolve; });
      return { observation: { id: 'late', url: 'about:blank' }, attachment: { mimeType: 'image/png', data: 'fixture' } };
    });
    const capturing = f.browser.tool('browser_read', { action: 'screenshot', tabId: f.tab.id }, f.context);
    await settle(); expect(f.page.screenshot).toHaveBeenCalledTimes(2);
    // 等帧期间任务结束：租约已释放，但采集完成前不能恢复节流或隐藏视图。
    f.browser.finishRun(f.context.runId);
    expect(throttled(f.contents)).toBe(false); expect(mockViews[0].visible).toBe(true);
    release(); await capturing;
    expect(throttled(f.contents)).toBe(true); expect(mockViews[0].visible).toBe(false); expect(mockHosts[0].visible).toBe(false);
    await f.browser.tool('browser_read', { action: 'snapshot', tabId: f.tab.id }, { ...f.context, runId: 'next-run' });
    expect(throttled(f.contents)).toBe(false);
    expect(f.contents.setBackgroundThrottling).toHaveBeenCalledTimes(4);
  } finally { f.browser.close(); }
});

test('切换标签、隐藏或最小化工作台时空闲标签恢复节流，可见标签保持关闭', async () => {
  const { browser } = fixture();
  const { BaseWindow } = jest.requireMock('electron');
  const parent = new BaseWindow(); parent.visible = true; parent.webContents.isOffscreen = () => false;
  (browser as any).getWindow = () => parent;
  try {
    browser.layout({ x: 0, y: 0, width: 700, height: 500, visible: true });
    const open = async (index: number) => {
      const opening = browser.call('owner', 'browser.newTab', {});
      await settle(); mockViews[index].finish(); return (await opening) as BrowserTab;
    };
    const first = await open(0);
    const [one] = mockViews.map(view => view.webContents);
    expect(throttled(one)).toBe(false); expect(one.setBackgroundThrottling).not.toHaveBeenCalled();
    await open(1);
    const two = mockViews[1].webContents;
    expect(throttled(one)).toBe(true); expect(throttled(two)).toBe(false); expect(mockViews[0].visible).toBe(false);
    for (const [hide, show] of [['minimize', 'restore'], ['hide', 'show']] as const) {
      parent.minimized = hide === 'minimize'; parent.visible = hide !== 'hide'; parent.emit(hide);
      expect(throttled(two)).toBe(true); expect(throttled(one)).toBe(true);
      parent.minimized = false; parent.visible = true; parent.emit(show);
      expect(throttled(two)).toBe(false); expect(throttled(one)).toBe(true);
    }
    await browser.call('owner', 'browser.select', { tabId: first.id });
    expect(throttled(one)).toBe(false); expect(throttled(two)).toBe(true);
    browser.layout({ x: 0, y: 0, width: 700, height: 500, visible: false });
    expect(throttled(one)).toBe(true);
  } finally { browser.close(); }
  expect(parent.listeners.get('minimize')?.size).toBe(0);
});
