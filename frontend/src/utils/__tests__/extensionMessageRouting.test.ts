/**
 * 扩展消息分类规则测试。
 *
 * 这条规则决定「一条消息是某个请求的响应，还是需要广播的主动推送」。
 * 它过去被复制在每个 window 监听器里，导致响应会漏进推送处理链路；
 * 现在是唯一分发器调用的纯函数，必须锁定其分类语义。
 */

import {
  routeExtensionMessage,
  type PendingRequestHandler
} from '../extensionMessageRouting';

function createPending() {
  const resolved: unknown[] = [];
  const rejected: Error[] = [];
  const handler: PendingRequestHandler = {
    resolve: value => resolved.push(value),
    reject: error => rejected.push(error)
  };
  return { handler, resolved, rejected };
}

describe('routeExtensionMessage', () => {
  it('成功响应兑现对应请求，且不广播给推送订阅者', () => {
    const { handler, resolved } = createPending();
    const pending = new Map([['req_1', handler]]);
    const broadcasts: unknown[] = [];

    const result = routeExtensionMessage(
      { requestId: 'req_1', success: true, data: { ok: 1 }, type: 'response' },
      pending,
      message => broadcasts.push(message)
    );

    expect(result).toBe('resolved');
    expect(resolved).toEqual([{ ok: 1 }]);
    expect(broadcasts).toHaveLength(0);
    // 请求兑现后必须摘除，避免同一 requestId 被二次处理
    expect(pending.has('req_1')).toBe(false);
  });

  it('失败响应以错误消息 reject', () => {
    const { handler, rejected } = createPending();
    const pending = new Map([['req_2', handler]]);

    const result = routeExtensionMessage(
      { requestId: 'req_2', success: false, error: { message: '磁盘写入失败' } },
      pending,
      () => undefined
    );

    expect(result).toBe('rejected');
    expect(rejected[0]!.message).toBe('磁盘写入失败');
  });

  it('失败响应缺少错误消息时给出兜底文案，不会 reject 一个空 Error', () => {
    const { handler, rejected } = createPending();
    const pending = new Map([['req_3', handler]]);

    routeExtensionMessage({ requestId: 'req_3', success: false }, pending, () => undefined);
    expect(rejected[0]!.message).toBe('Unknown error');
  });

  it('主动推送消息广播给订阅者', () => {
    const broadcasts: unknown[] = [];
    const result = routeExtensionMessage(
      { type: 'subagentMonitor.event', data: { runId: 'run_1' } },
      new Map(),
      message => broadcasts.push(message)
    );

    expect(result).toBe('broadcast');
    const first = broadcasts[0] as { type?: unknown };
    expect(first.type).toBe('subagentMonitor.event');
  });

  it('无人等待的 requestId 响应不会被当作推送消息广播出去', () => {
    // 这正是旧实现的缺陷：第一个监听器兑现并删除 requestId 后，
    // 其余监听器查不到它，就把这条响应交给了业务 handler。
    const broadcasts: unknown[] = [];
    const result = routeExtensionMessage(
      { requestId: 'req_gone', success: true, data: { ok: 1 } },
      new Map(),
      message => broadcasts.push(message)
    );

    expect(result).toBe('ignored');
    expect(broadcasts).toHaveLength(0);
  });

  it('非对象消息与无 type 的消息一律忽略', () => {
    const broadcasts: unknown[] = [];
    const sink = (message: unknown) => broadcasts.push(message);

    expect(routeExtensionMessage(null, new Map(), sink)).toBe('ignored');
    expect(routeExtensionMessage('ping', new Map(), sink)).toBe('ignored');
    expect(routeExtensionMessage({ data: 1 }, new Map(), sink)).toBe('ignored');
    expect(broadcasts).toHaveLength(0);
  });

  it('broadcast whitelist includes conversationsChanged (remote list refresh)', () => {
    const broadcasts: unknown[] = [];
    const sink = (message: unknown) => broadcasts.push(message);

    // V2: remote-created/renamed/deleted conversations refresh desktop recent list live
    const result = routeExtensionMessage(
      { type: 'conversationsChanged', data: { changed: true } },
      new Map(),
      sink
    );
    expect(result).toBe('broadcast');
    expect((broadcasts[0] as { type?: unknown }).type).toBe('conversationsChanged');

    // unknown push types stay ignored
    const before = broadcasts.length;
    expect(routeExtensionMessage({ type: 'someUnknownPush', data: {} }, new Map(), sink)).toBe('ignored');
    expect(broadcasts.length).toBe(before);
  });
});