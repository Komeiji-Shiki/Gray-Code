import type { PlatformApplication } from '../../../apps/server/src/application';
import { DesktopPetWindow } from '../../../apps/desktop/src/petWindow';
const mockWindows: any[] = [];
jest.mock('electron', () => ({
  BrowserWindow: class {
    destroyed = false;
    handlers = new Map<string, Array<() => void>>();
    finish!: () => void; fail!: (error: Error) => void;
    loading = new Promise<void>((resolve, reject) => { this.finish = resolve; this.fail = reject; });
    bounds = { x: 0, y: 0, width: 280, height: 320 };
    setTitle = jest.fn(); showInactive = jest.fn();
    loadURL = jest.fn(() => this.loading);
    setBounds = jest.fn(value => { this.bounds = value; });
    constructor() { mockWindows.push(this); }
    on(name: string, handler: () => void) { this.handlers.set(name, [...this.handlers.get(name) ?? [], handler]); return this; }
    isDestroyed() { return this.destroyed; }
    getBounds() { return this.bounds; }
    destroy() { this.destroyed = true; for (const handler of this.handlers.get('closed') ?? []) handler(); }
  },
  screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1280, height: 720 } }) },
}));
const settle = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture() {
  const configuration = { visible: true, surface: 'floating', resourceId: 'fixture', scale: 1 };
  let change!: () => void;
  const publish = jest.fn();
  const app = { publish, pets: { attachHost: (host: { changed: () => void }) => { change = host.changed; },
    snapshot: async () => ({ configuration }), call: jest.fn() } } as unknown as PlatformApplication;
  const window = new DesktopPetWindow(app, { actorId: 'owner', clientId: 'fixture' }, 'preload.cjs', jest.fn());
  return { configuration, change: () => change(), publish, window };
}
beforeEach(() => { mockWindows.length = 0; });

test('关闭并重新打开后，旧窗口迟到的加载失败不误报或关闭新窗口', async () => {
  const f = fixture();
  try {
    f.change(); await settle(); const old = mockWindows[0];
    f.configuration.visible = false; f.change(); await settle(); expect(old.destroyed).toBe(true);
    f.configuration.visible = true; f.change(); await settle(); const current = mockWindows[1];
    old.fail(new Error('ERR_ABORTED')); await settle();
    expect(f.publish).not.toHaveBeenCalled(); expect(current.destroyed).toBe(false);
    current.finish(); await settle(); expect(current.showInactive).toHaveBeenCalledTimes(1);
    expect(old.showInactive).not.toHaveBeenCalled();
  } finally { f.window.dispose(); }
});

test('真实加载失败释放旧对象，下一次配置同步可以重新加载', async () => {
  const f = fixture();
  try {
    f.change(); await settle(); const old = mockWindows[0]; old.fail(new Error('resource unavailable')); await settle();
    expect(old.destroyed).toBe(true);
    expect(f.publish).toHaveBeenCalledWith(expect.objectContaining({ severity: 'warning', message: expect.stringContaining('resource unavailable') }));
    f.change(); await settle(); expect(mockWindows).toHaveLength(2);
    mockWindows[1].finish(); await settle(); expect(mockWindows[1].showInactive).toHaveBeenCalledTimes(1);
  } finally { f.window.dispose(); }
});
