import type { PlatformApplication } from '../../../apps/server/src/application';
import { PlatformTerminals } from '../../../apps/server/src/terminal/service';
import { InteractiveTerminals } from '../../../apps/server/src/workspace/interactiveTerminals';
import { ExternalAgents } from '../../../apps/server/src/externalAgents/service';
import { stopOwnedProcess } from '../../../apps/server/src/workspace/processLifecycle';

jest.mock('../../../apps/server/src/workspace/processLifecycle', () => ({ stopOwnedProcess: jest.fn() }));
const app = { subscribe: () => () => {}, publish: jest.fn() } as unknown as PlatformApplication;
afterEach(() => { jest.clearAllMocks(); jest.useRealTimers(); });

test('后台终端的结构化停止失败会传给关闭调用方，并可按原任务重试', async () => {
  const service = new PlatformTerminals(app);
  const active = (service as any).active as Map<string, any>;
  const failed = jest.fn().mockResolvedValueOnce({ success: false, error: 'fixture terminal failure' }).mockImplementation(async () => {
    active.delete('failed'); return { success: true };
  });
  active.set('failed', { record: { id: 'failed' }, runner: { killTerminalProcess: failed } });
  const finished = jest.fn(async () => { active.delete('finished'); return { success: false, error: 'already finished' }; });
  active.set('finished', { record: { id: 'finished' }, runner: { killTerminalProcess: finished } });
  await expect(service.close()).rejects.toThrow('fixture terminal failure');
  expect(finished).toHaveBeenCalledTimes(1);
  await service.close();
  expect(failed).toHaveBeenCalledTimes(2);
  expect(active.size).toBe(0);
});

test('交互终端的停止失败不会永久缓存，也不会跳过其他终端的清理', async () => {
  jest.useFakeTimers();
  const service = new InteractiveTerminals(app);
  const failedHost = { connected: false }, otherHost = { connected: false };
  const sessions = (service as any).sessions as Map<string, any>;
  const entry = (host: unknown) => ({ host, closed: new Promise(() => {}), info: { status: 'running' } });
  sessions.set('failed', entry(failedHost)); sessions.set('other', entry(otherHost));
  (stopOwnedProcess as jest.Mock).mockImplementation(async host => { if (host === failedHost) throw new Error('fixture PTY failure'); });
  const first = expect(service.close()).rejects.toThrow('fixture PTY failure');
  await jest.advanceTimersByTimeAsync(3000); await first;
  expect(stopOwnedProcess).toHaveBeenCalledWith(otherHost);
  (stopOwnedProcess as jest.Mock).mockResolvedValue(undefined);
  const retry = service.close(); await jest.advanceTimersByTimeAsync(3000); await retry;
  expect((stopOwnedProcess as jest.Mock).mock.calls.filter(([host]) => host === failedHost)).toHaveLength(2);
  expect((stopOwnedProcess as jest.Mock).mock.calls.filter(([host]) => host === otherHost)).toHaveLength(1);
  expect(sessions.size).toBe(0);
});

test('外部代理关闭失败保留同一客户端供下一次关闭重试', async () => {
  const service = new ExternalAgents(app);
  const stop = jest.fn().mockRejectedValueOnce(new Error('fixture ACP failure')).mockResolvedValue(undefined);
  const client = { stop };
  const live = { client };
  (service as any).sessions.set('fixture', live);
  await expect(service.close()).rejects.toThrow('fixture ACP failure');
  expect(live.client).toBe(client);
  await service.close();
  expect(stop).toHaveBeenCalledTimes(2);
  expect(live.client).toBeUndefined();
});
