import { PlatformApplication } from '../../../apps/server/src/application';
import { ApplicationRouter, type ClientSession } from '../../../apps/server/src/transport/router';
import { fixture } from './fixtures';

let f: Awaited<ReturnType<typeof fixture>>;
let app: PlatformApplication;
let router: ApplicationRouter;
let events: Record<string, unknown>[];
const first: ClientSession = { actorId: 'owner', clientId: 'main-one', uiStateKey: 'desktop' };
const second: ClientSession = { actorId: 'owner', clientId: 'main-two', uiStateKey: 'desktop' };
const ui = (client: ClientSession, type: string, data: Record<string, unknown> = {}) => router.call(client, 'ui.request', { type, data });

async function prepare(client: ClientSession, resumeViewId?: string): Promise<string> {
  const result = await router.call(client, 'ui.view.prepare', resumeViewId ? { resumeViewId } : {});
  if (!result || typeof result !== 'object' || !('viewId' in result) || typeof result.viewId !== 'string') {
    throw new Error('主聊天准备没有返回视图身份');
  }
  return result.viewId;
}

beforeEach(async () => {
  f = await fixture(); await f.store.close();
  app = await PlatformApplication.open({ dataDirectory: f.data });
  router = new ApplicationRouter(app);
  events = [];
  app.subscribe(event => { if (event.type === 'ui.message' || event.type === 'ui.ready') events.push(event); });
});
afterEach(async () => { await app.close(); await f.cleanup(); });

test('主聊天握手前保留显式命令，按客户端和受理顺序交付', async () => {
  await ui(first, 'ui.command', { command: 'newChat' });
  await ui(second, 'ui.command', { command: 'showHistory' });
  await ui(first, 'ui.command', { command: 'showSettings', data: { section: 'channels' } });
  expect(events).toEqual([]);

  const firstView = await prepare(first), secondView = await prepare(second);
  await ui(first, 'webviewReady', { viewId: firstView });
  expect(events).toEqual([
    { type: 'ui.message', clientId: first.clientId, viewId: firstView, message: { type: 'command', command: 'newChat', data: undefined } },
    { type: 'ui.message', clientId: first.clientId, viewId: firstView,
      message: { type: 'command', command: 'showSettings', data: { section: 'channels' } } },
    { type: 'ui.ready', clientId: first.clientId, viewId: firstView },
  ]);
  events.length = 0;
  await ui(first, 'webviewReady', { viewId: firstView });
  await ui(first, 'ui.startup');
  expect(events).toEqual([]);
  await ui(first, 'ui.command', { command: 'showUsage' });
  expect(events[0]).toMatchObject({ clientId: first.clientId, viewId: firstView, message: { command: 'showUsage' } });
  await ui(second, 'webviewReady', { viewId: secondView });
  expect(events.slice(1)).toEqual([
    { type: 'ui.message', clientId: second.clientId, viewId: secondView, message: { type: 'command', command: 'showHistory', data: undefined } },
    { type: 'ui.ready', clientId: second.clientId, viewId: secondView },
  ]);
});

test('缺失或被替换的主视图不能用迟到 ready 放行命令', async () => {
  await ui(first, 'webviewReady', { viewId: 'unprepared-view' });
  expect(events).toEqual([]);
  const oldView = await prepare(first);
  await ui(first, 'webviewReady', { viewId: oldView });
  const currentView = await prepare(first);
  events.length = 0;
  await ui(first, 'ui.command', { command: 'newChat' });
  await ui(first, 'webviewReady', { viewId: oldView });
  await expect(router.call(first, 'ui.view.prepare', { resumeViewId: oldView }))
    .resolves.toEqual({ accepted: false, viewId: currentView });
  expect(events).toEqual([]);
  await ui(first, 'webviewReady', { viewId: currentView });
  expect(events).toHaveLength(2);
  expect(events[0]).toMatchObject({ viewId: currentView, message: { command: 'newChat' } });
});

test('服务重启后只恢复缺失的主视图身份，桌面窗口失效后仍须重新准备', async () => {
  const browser = { actorId: 'owner', clientId: 'restored-browser' };
  await expect(ui(browser, 'webviewReady', { viewId: 'retained-document' })).resolves.toEqual({ success: false, reason: 'missing' });
  await ui(browser, 'ui.command', { command: 'showSettings' });
  await expect(router.call(browser, 'ui.view.prepare', { resumeViewId: 'retained-document' }))
    .resolves.toEqual({ accepted: true, viewId: 'retained-document' });
  app.productUi.commands.connected(browser.clientId);
  await ui(browser, 'webviewReady', { viewId: 'retained-document' });
  expect(events[0]).toMatchObject({ clientId: browser.clientId, viewId: 'retained-document', message: { command: 'showSettings' } });

  const viewId = await prepare(first);
  await ui(first, 'webviewReady', { viewId });
  app.productUi.commands.invalidate(first.clientId);
  events.length = 0;
  await ui(first, 'ui.command', { command: 'newChat' });
  await expect(ui(first, 'webviewReady', { viewId })).resolves.toEqual({ success: false, reason: 'missing' });
  expect(events).toEqual([]);
  const replacement = await prepare(first);
  await ui(first, 'webviewReady', { viewId: replacement });
  expect(events[0]).toMatchObject({ viewId: replacement, message: { command: 'newChat' } });
});

test('客户端释放后清除视图登记与未投递命令，重连不会收到旧命令', async () => {
  const viewId = await prepare(first);
  await ui(first, 'ui.command', { command: 'newChat' });
  expect(events).toEqual([]);
  await app.productUi.clientClosed(first.clientId);
  events.length = 0;
  await expect(ui(first, 'webviewReady', { viewId })).resolves.toEqual({ success: false, reason: 'missing' });
  await expect(router.call(first, 'ui.view.prepare', { resumeViewId: viewId })).resolves.toEqual({ accepted: true, viewId });
  await ui(first, 'webviewReady', { viewId });
  expect(events).toEqual([{ type: 'ui.ready', clientId: first.clientId, viewId }]);
});
