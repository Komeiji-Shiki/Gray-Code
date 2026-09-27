import type { ChildProcess } from 'node:child_process';
import { PlatformApplication } from '../../../apps/server/src/application';
import { stopOwnedProcess } from '../../../apps/server/src/workspace/processLifecycle';
import { fixture } from './fixtures';

let f: Awaited<ReturnType<typeof fixture>>;
let app: PlatformApplication | undefined;
const model = { generate: async () => { throw new Error('关闭测试不得调用模型。'); } };
beforeEach(async () => { f = await fixture(); await f.store.close(); });
afterEach(async () => { jest.restoreAllMocks(); await app?.close(); app = undefined; await f.cleanup(); });

test('关闭失败仍清理其他组件，保留存储并只重试失败项', async () => {
  app = await PlatformApplication.open({ dataDirectory: f.data, models: model });
  const nodes = jest.spyOn(app.nodes, 'close').mockRejectedValueOnce(new Error('fixture node close failure'));
  const mcp = jest.spyOn(app.mcp, 'close').mockRejectedValueOnce(new Error('fixture MCP close failure'));
  const processes = jest.spyOn(app.processes, 'close');
  const storage = jest.spyOn(app.storage, 'close');
  await expect(app.close()).rejects.toThrow('fixture node close failure');
  expect(app.isClosing).toBe(true);
  expect(mcp).toHaveBeenCalledTimes(1);
  expect(processes).toHaveBeenCalledTimes(1);
  expect(storage).not.toHaveBeenCalled();
  await app.storage.putRecord({ namespace: 'shutdown-test', id: 'retry', value: { available: true } });
  expect(await app.storage.getRecord('shutdown-test', 'retry')).toEqual({ available: true });
  await app.close(); await app.close();
  expect(nodes).toHaveBeenCalledTimes(2);
  expect(mcp).toHaveBeenCalledTimes(2);
  expect(processes).toHaveBeenCalledTimes(1);
  expect(storage).toHaveBeenCalledTimes(1);
});

test('并发及关闭通知中的重入调用共用同一次清理', async () => {
  app = await PlatformApplication.open({ dataDirectory: f.data, models: model });
  const original = app.screenSense.close.bind(app.screenSense);
  let reentrant: Promise<void> | undefined;
  const screen = jest.spyOn(app.screenSense, 'close').mockImplementation(() => {
    reentrant = app!.close(); original();
  });
  const first = app.close();
  const second = app.close();
  await Promise.all([first, second]);
  expect(reentrant).toBe(first);
  expect(screen).toHaveBeenCalledTimes(1);
});

test('启动失败会关闭已创建的真实子进程和存储，并保留启动错误', async () => {
  const failure = new Error('fixture startup failure');
  let child: ChildProcess | undefined;
  let captured: PlatformApplication | undefined;
  const persistence = { save: async () => {}, close: jest.fn(async () => {}), initialize: async (current: PlatformApplication) => {
    captured = current;
    const result = await current.processes.start({ id: 'boot', name: 'fixture', deviceId: 'local', directory: f.source },
      'boot-fixture', process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
    child = (current.processes as any).entries.get(result.id).child;
    throw failure;
  } };
  try {
    await expect(PlatformApplication.open({ dataDirectory: f.data, models: model, configurationPersistence: persistence })).rejects.toBe(failure);
    expect(child).toBeDefined();
    expect(child!.exitCode !== null || child!.signalCode !== null).toBe(true);
    expect(captured!.processes.activeCount).toBe(0);
    expect(persistence.close).toHaveBeenCalledTimes(1);
    await expect(captured!.storage.getRecord('shutdown-test', 'closed')).rejects.toThrow();
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) await stopOwnedProcess(child);
  }
});

test('启动与清理同时失败时报告两项原因，并释放不再可用的实例存储', async () => {
  let captured: PlatformApplication | undefined;
  const starting = new Error('fixture startup failure');
  const cleanup = new Error('fixture cleanup failure');
  const opened = PlatformApplication.open({ dataDirectory: f.data, models: model, configurationPersistence: {
    save: async () => {}, close: async () => { throw cleanup; }, initialize: async current => { captured = current; throw starting; }
  } });
  await expect(opened).rejects.toMatchObject({ errors: [starting, expect.objectContaining({ errors: [cleanup] })] });
  await expect(captured!.storage.getRecord('shutdown-test', 'closed')).rejects.toThrow();
});

test('宿主工厂在构造中失败，也会关闭此前取得的服务和配置资源', async () => {
  let captured: PlatformApplication | undefined;
  let processes: jest.SpyInstance | undefined;
  const failure = new Error('fixture host factory failure');
  const close = jest.fn(async () => {});
  await expect(PlatformApplication.open({ dataDirectory: f.data, models: model,
    configurationPersistence: { initialize: async () => {}, save: async () => {}, close },
    browser: current => { captured = current; processes = jest.spyOn(current.processes, 'close'); throw failure; }
  })).rejects.toBe(failure);
  expect(processes).toHaveBeenCalledTimes(1);
  expect(close).toHaveBeenCalledTimes(1);
  await expect(captured!.storage.getRecord('shutdown-test', 'closed')).rejects.toThrow();
});
