import type { PlatformApplication } from '../../../apps/server/src/application';
import { DesktopBrowser } from '../../../apps/desktop/src/browser';

const mockViews: any[] = []; const mockHosts: any[] = [];
const mockConnect = jest.fn(async () => {});
jest.mock('@graycode/core', () => ({ authorizeEffects: () => undefined }));
jest.mock('../../../apps/desktop/src/browser/page', () => ({ BrowserPage: class {
  connect = mockConnect; invalidate = jest.fn();
} }));
jest.mock('../../../apps/desktop/src/browser/transfers', () => ({ BrowserTransfers: class {} }));
jest.mock('electron', () => ({
  session: { fromPartition: () => ({ setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, on() {}, protocol: { isProtocolHandled: async () => true } }) },
  WebContentsView: class {
    bounds = { x: 0, y: 0, width: 1100, height: 800 };
    destroyed = false; finish!: () => void; fail!: (error: Error) => void;
    loading = new Promise<void>((resolve, reject) => { this.finish = resolve; this.fail = reject; });
    webContents = { isDestroyed: () => this.destroyed, close: jest.fn(() => { this.destroyed = true; }),
      loadURL: () => this.loading, on() {}, setWindowOpenHandler() {} };
    constructor() { mockViews.push(this); }
    getBounds() { return this.bounds; } setBounds(value: any) { this.bounds = value; } setVisible() {}
  },
  BaseWindow: class {
    visible = false; destroyed = false;
    contentView = { children: [] as any[], addChildView: (view: any) => { this.contentView.children.push(view); },
      removeChildView: (view: any) => { this.contentView.children = this.contentView.children.filter(item => item !== view); } };
    constructor() { mockHosts.push(this); }
    isDestroyed() { return this.destroyed; } isVisible() { return this.visible; }
    getContentSize() { return [1100, 800]; } setIgnoreMouseEvents() {} setContentSize() {}
    showInactive() { this.visible = true; } hide() { this.visible = false; } close() { this.destroyed = true; }
  },
}));
const settle = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture(listRecords = jest.fn(async () => [] as string[])) {
  const unsubscribe = jest.fn();
  const app = { actor: () => ({ id: 'owner' }), requireOwner() {}, subscribe: () => unsubscribe,
    storage: { listRecords, getRecord: jest.fn() } } as unknown as PlatformApplication;
  const browser = new DesktopBrowser(app, () => undefined, jest.fn());
  return { browser, unsubscribe };
}
beforeEach(() => { mockViews.length = 0; mockHosts.length = 0; mockConnect.mockClear(); });

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
