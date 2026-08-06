/**
 * MessageRouter 流式请求路由生命周期单元测试
 *
 * 覆盖两个回归点：
 * 1. cancelStream 缺少 data / conversationId 时不抛 TypeError，错误路由回发起方，
 *    requestClients 已登记的条目被清理（不再永久残留）；
 * 2. 流式请求的 started:true 响应不再删除 requestId → clientId 映射，流中途出错时
 *    错误仍能路由回发起方（Monitor），而非错投主聊天导致 Monitor 侧 await 永久挂起；
 *    映射由流的 finally/finalizeRequest 统一清理。
 */

// 注意：本仓库 ts-jest 不保证 hoist jest.mock，mock 声明必须放在依赖它的 import 之前
// （与 backend/__tests__/tools/diffManager.test.ts 同约定）。
// 屏蔽真实 DiffManager（cancelStream 清理路径会触碰 vscode 依赖），聚焦路由行为。
const cancelAllPendingMock = jest.fn().mockResolvedValue({ cancelled: [] });
jest.mock('../../../backend/tools/file/diffManager', () => ({
  getDiffManager: () => ({
    cancelAllPending: cancelAllPendingMock
  })
}));

import { MessageRouter } from '../../../webview/MessageRouter';
import { WebviewClientRegistry } from '../../../webview/runtime/WebviewClientRegistry';
import { subAgentRunEventBus } from '../../../backend/tools/subagents/runEventBus';
import { subAgentRunController } from '../../../backend/tools/subagents/runController';

function flushAsync(ms = 20): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function createHarness() {
  const clientRegistry = new WebviewClientRegistry();
  const monitorMessages: any[] = [];
  clientRegistry.register({
    clientId: 'subagent-monitor',
    postMessage: (message: Record<string, unknown>) => {
      monitorMessages.push(message);
      return true;
    }
  });

  const chatHandler = {
    handleChatStream: jest.fn(),
    handleRetryStream: jest.fn(),
    handleEditAndRetryStream: jest.fn(),
    handleToolConfirmation: jest.fn()
  };
  const conversationManager = {
    rejectAllPendingToolCalls: jest.fn().mockResolvedValue(undefined)
  };
  const rawSendResponse = jest.fn();
  const rawSendError = jest.fn();

  const router = new MessageRouter(
    chatHandler as any,
    conversationManager as any,
    {} as any,
    () => undefined,
    rawSendResponse,
    rawSendError,
    clientRegistry
  );

  const ctx = { clientId: 'subagent-monitor' } as any;

  return {
    router,
    ctx,
    monitorMessages,
    chatHandler,
    conversationManager,
    rawSendResponse,
    rawSendError
  };
}

describe('MessageRouter 流式请求路由生命周期', () => {
  afterEach(() => {
    subAgentRunController.unregister('router_detach_fg');
    cancelAllPendingMock.mockClear();
    jest.restoreAllMocks();
  });

  it('cancelStream 缺少 data：不抛 TypeError，错误路由到发起方，requestClients 无残留', async () => {
    const h = createHarness();
    const handled = await h.router.route('cancelStream', undefined, 'req_cancel_1', h.ctx, 'subagent-monitor');
    expect(handled).toBe(true);

    const errorMsg = h.monitorMessages.find((m: any) => m.type === 'error' && m.requestId === 'req_cancel_1');
    expect(errorMsg).toBeDefined();
    expect(errorMsg.error.code).toBe('INVALID_DATA');
    expect(h.rawSendError).not.toHaveBeenCalled();
    // 映射已被清理，无永久残留
    expect((h.router as any).requestClients.size).toBe(0);
  });

  it('cancelStream data 缺少 conversationId：错误路由到发起方，requestClients 无残留', async () => {
    const h = createHarness();
    const handled = await h.router.route('cancelStream', { foo: 'bar' }, 'req_cancel_2', h.ctx, 'subagent-monitor');
    expect(handled).toBe(true);

    const errorMsg = h.monitorMessages.find((m: any) => m.type === 'error' && m.requestId === 'req_cancel_2');
    expect(errorMsg).toBeDefined();
    expect(errorMsg.error.code).toBe('INVALID_DATA');
    expect(h.rawSendError).not.toHaveBeenCalled();
    expect((h.router as any).requestClients.size).toBe(0);
  });

  it('cancelStream 正常路径：cancelled 响应路由到发起方，映射由流结束清理', async () => {
    const h = createHarness();
    const handled = await h.router.route('cancelStream', { conversationId: 'conv_cancel_1' }, 'req_cancel_3', h.ctx, 'subagent-monitor');
    expect(handled).toBe(true);

    // cancelStream 是 fire-and-forget，等待内部 promise 完成
    await flushAsync();

    const resp = h.monitorMessages.find((m: any) => m.type === 'response' && m.requestId === 'req_cancel_3');
    expect(resp).toBeDefined();
    expect(resp.data).toEqual({ cancelled: true });
    expect(cancelAllPendingMock).toHaveBeenCalledWith('conv_cancel_1');
    expect(cancelAllPendingMock).not.toHaveBeenCalledWith();
    expect(h.conversationManager.rejectAllPendingToolCalls).toHaveBeenCalledWith('conv_cancel_1');
    expect(h.rawSendResponse).not.toHaveBeenCalled();
    expect(h.rawSendError).not.toHaveBeenCalled();
    expect((h.router as any).requestClients.size).toBe(0);
  });

  it('cancelAllStreams 使用全局 diff 清理，同时逐会话拒绝待确认工具', async () => {
    const h = createHarness();
    const abortManager = h.router.getAbortManager();
    abortManager.create('conv_all_1');
    abortManager.create('conv_all_2');

    h.router.cancelAllStreams();
    await flushAsync();

    expect(cancelAllPendingMock).toHaveBeenCalledTimes(1);
    expect(cancelAllPendingMock).toHaveBeenCalledWith();
    expect(h.conversationManager.rejectAllPendingToolCalls).toHaveBeenCalledWith('conv_all_1');
    expect(h.conversationManager.rejectAllPendingToolCalls).toHaveBeenCalledWith('conv_all_2');
  });

  it('cancelStream 保留子 Agent 时先转后台再取消旧流', async () => {
    const h = createHarness();
    const abortManager = h.router.getAbortManager();
    const oldStream = abortManager.create('conv_replace');
    subAgentRunEventBus.createRun('router_detach_fg', 'Agent', undefined, { conversationId: 'conv_replace' });
    subAgentRunController.register('router_detach_fg', 'Agent', 0, true);

    let oldStreamWasAbortedWhenDetached: boolean | undefined;
    subAgentRunController.registerDetachListener('router_detach_fg', () => {
      oldStreamWasAbortedWhenDetached = oldStream.signal.aborted;
    });

    const handled = await h.router.route(
      'cancelStream',
      { conversationId: 'conv_replace', preserveSubAgents: true },
      'req_cancel_preserve',
      h.ctx,
      'subagent-monitor'
    );
    expect(handled).toBe(true);
    await flushAsync();

    expect(oldStreamWasAbortedWhenDetached).toBe(false);
    expect(oldStream.signal.aborted).toBe(true);
    expect(subAgentRunController.isDetached('router_detach_fg')).toBe(true);
    expect(subAgentRunController.isActive('router_detach_fg')).toBe(true);
  });

  it('chatStream started:true 后出错：错误仍路由到发起方而非主聊天（回归）', async () => {
    const h = createHarness();
    h.chatHandler.handleChatStream.mockReturnValue((async function* () {
      yield { content: 'partial' };
      throw new Error('stream boom');
    })());

    await h.router.route('chatStream', { conversationId: 'conv_s1', message: 'hi' }, 'req_s1', h.ctx, 'subagent-monitor');
    await flushAsync();

    // started:true 响应到达 Monitor
    const started = h.monitorMessages.find((m: any) => m.type === 'response' && m.requestId === 'req_s1');
    expect(started).toBeDefined();
    expect(started.data).toEqual({ started: true });

    // 错误也路由到 Monitor（修复前 started 响应已删除映射，错误会回退主聊天）
    const errorMsg = h.monitorMessages.find((m: any) => m.type === 'error' && m.requestId === 'req_s1');
    expect(errorMsg).toBeDefined();
    expect(errorMsg.error.code).toBe('STREAM_ERROR');
    expect(errorMsg.error.message).toBe('stream boom');
    expect(h.rawSendError).not.toHaveBeenCalled();
    expect(h.rawSendResponse).not.toHaveBeenCalled();

    // finally → finalizeRequest 清理映射
    expect((h.router as any).requestClients.size).toBe(0);
  });

  it('retryStream started:true 后出错：错误仍路由到发起方而非主聊天（回归）', async () => {
    const h = createHarness();
    h.chatHandler.handleRetryStream.mockReturnValue((async function* () {
      yield { content: 'partial' };
      throw new Error('retry boom');
    })());

    await h.router.route('retryStream', { conversationId: 'conv_r1' }, 'req_r1', h.ctx, 'subagent-monitor');
    await flushAsync();

    const started = h.monitorMessages.find((m: any) => m.type === 'response' && m.requestId === 'req_r1');
    expect(started).toBeDefined();
    expect(started.data).toEqual({ started: true });

    const errorMsg = h.monitorMessages.find((m: any) => m.type === 'error' && m.requestId === 'req_r1');
    expect(errorMsg).toBeDefined();
    expect(errorMsg.error.code).toBe('STREAM_ERROR');
    expect(h.rawSendError).not.toHaveBeenCalled();
    expect((h.router as any).requestClients.size).toBe(0);
  });

  it('chatStream 正常结束：started 响应路由到发起方，映射由 finally 清理', async () => {
    const h = createHarness();
    h.chatHandler.handleChatStream.mockReturnValue((async function* () {
      yield { content: 'done' };
    })());

    await h.router.route('chatStream', { conversationId: 'conv_s2', message: 'hi' }, 'req_s2', h.ctx, 'subagent-monitor');
    await flushAsync();

    const started = h.monitorMessages.find((m: any) => m.type === 'response' && m.requestId === 'req_s2');
    expect(started).toBeDefined();
    expect(h.rawSendResponse).not.toHaveBeenCalled();
    expect(h.rawSendError).not.toHaveBeenCalled();
    expect((h.router as any).requestClients.size).toBe(0);
  });
});
