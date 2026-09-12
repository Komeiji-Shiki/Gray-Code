import { PlatformApplication } from '../../../apps/server/src/application';
import type { BotGateway } from '../../../apps/server/src/bots/gateway';
import { fixture } from './fixtures';

const deferred = <T = void>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };

describe('Bot 启动重试与停止', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  let app: PlatformApplication;
  let factory: jest.Mock<BotGateway, []>;
  beforeEach(async () => {
    f = await fixture(); await f.store.close();
    factory = jest.fn(() => ({ connect: jest.fn(async () => ({ id: '900', name: '隔离 Bot' })), disconnect: jest.fn(async () => {}), send: async () => {} }));
    app = await PlatformApplication.open({ dataDirectory: f.data, documentsDirectory: f.root, discordGateway: factory });
    const settings = app.settings.snapshot();
    settings.settings.discord = { enabled: true, credentialRef: 'env:GRAYCODE_CONNECTION_FIXTURE', allowedChannelIds: [], agentId: 'default', mentionOnly: true };
    await app.settings.save({ settings: settings.settings, expectedRevision: settings.revision });
    jest.spyOn(app.settings, 'credential').mockResolvedValue('fixture-only');
  });
  afterEach(async () => { jest.useRealTimers(); jest.restoreAllMocks(); await app.close(); await f.cleanup(); });

  test('首次失败释放网关，保留后台运行，退避后自动恢复并发布状态', async () => {
    const disconnected = jest.fn(async () => {});
    factory.mockImplementationOnce(() => ({ connect: async () => { throw new Error('暂时离线'); }, disconnect: disconnected, send: async () => {} }));
    const connected = deferred();
    let state: ((status: string) => void) | undefined;
    factory.mockImplementationOnce(() => ({ connect: async (_token, _all, _receive, callback) => { state = callback; return { id: '900', name: '隔离 Bot' }; }, disconnect: async () => {}, send: async () => {} }));
    const notices: any[] = [];
    const unsubscribe = app.subscribe(event => {
      if (event.type !== 'ui.message' || (event.message as any)?.command !== 'bot.connection.changed') return;
      const status = (event.message as any).data.status; notices.push(status);
      if (status.status === 'connected') connected.resolve();
    });
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask', 'performance', 'hrtime'] });
    try {
      await app.discord.autoConnect();
      expect(disconnected).toHaveBeenCalledTimes(1); expect(app.discord.keepsAlive).toBe(true);
      expect(app.discord.status()).toMatchObject({ status: 'failed', error: '暂时离线', retryAt: Date.now() + 5000 });
      await jest.advanceTimersByTimeAsync(5000); await connected.promise;
      expect(factory).toHaveBeenCalledTimes(2); expect(app.discord.status().retryAt).toBeUndefined();
      state!('reconnecting'); state!('connected');
      expect(notices.slice(-2).map(value => value.status)).toEqual(['reconnecting', 'connected']);
      await app.discord.stop(); expect(app.discord.keepsAlive).toBe(false);
      await jest.advanceTimersByTimeAsync(120000); expect(factory).toHaveBeenCalledTimes(2);
    } finally { unsubscribe(); }
  });

  test('关闭自动连接取消等待中的重试，手动失败不会开始自动重试', async () => {
    factory.mockImplementation(() => ({ connect: async () => { throw new Error('暂时离线'); }, disconnect: async () => {}, send: async () => {} }));
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask', 'performance', 'hrtime'] });
    await app.discord.autoConnect();
    const settings = app.settings.snapshot(); settings.settings.discord.autoConnect = false;
    await app.settings.save({ settings: settings.settings, expectedRevision: settings.revision });
    expect(app.discord.status().retryAt).toBeUndefined(); expect(app.discord.keepsAlive).toBe(false);
    await jest.advanceTimersByTimeAsync(120000); expect(factory).toHaveBeenCalledTimes(1);
    await expect(app.discord.start()).rejects.toThrow('暂时离线');
    expect(app.discord.status().status).toBe('failed'); expect(app.discord.keepsAlive).toBe(false);
    await jest.advanceTimersByTimeAsync(120000); expect(factory).toHaveBeenCalledTimes(2);
  });

  test('读取凭据时点击停止，迟到的凭据不能再建立连接', async () => {
    const entered = deferred(); const credential = deferred<string>();
    jest.mocked(app.settings.credential).mockImplementation(async () => { entered.resolve(); return credential.promise; });
    const starting = app.discord.start(); await entered.promise;
    await app.discord.stop(); credential.resolve('fixture-only'); await starting;
    expect(factory).not.toHaveBeenCalled(); expect(app.discord.status().status).toBe('stopped'); expect(app.discord.keepsAlive).toBe(false);
  });
});
