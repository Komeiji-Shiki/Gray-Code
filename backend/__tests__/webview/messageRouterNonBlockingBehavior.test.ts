/**
 * MessageRouter 非阻塞行为单元测试
 *
 * 背景：串行 messageHandlingQueue 中，普通 handler 被 await 串行执行。
 * 慢 handler（模态对话框、网络请求、token 计数 API、目录统计）一旦占住队列，
 * 后续保存类消息（savePromptMode 等）全部排队，前端 180s 超时误报保存失败，
 * 而队列轮到时后端实际保存成功——「误报失败但数据已存」。
 *
 * 本测试锁定：NON_BLOCKING_MESSAGE_TYPES 中的类型即使 handler 挂起，
 * 也不阻塞后续普通消息的处理；对照组证明普通 handler 确实会阻塞。
 */

import { MessageRouter, NON_BLOCKING_MESSAGE_TYPES } from '../../../webview/MessageRouter';
import { WebviewClientRegistry } from '../../../webview/runtime/WebviewClientRegistry';
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

describe('MessageRouter 非阻塞行为', () => {
  afterEach(() => {
    subAgentRunController.unregister('router_nb_behavior');
    NON_BLOCKING_MESSAGE_TYPES.delete('test.slowOp');
    jest.restoreAllMocks();
  });

  it('non-blocking handler：route 不等 handler 完成立即返回，后续消息不被阻塞', async () => {
    const h = createHarness();
    NON_BLOCKING_MESSAGE_TYPES.add('test.slowOp');

    let releaseSlow!: () => void;
    const slowGate = new Promise<void>(resolve => { releaseSlow = resolve; });

    (h.router as any).registry.set('test.slowOp', async (_data, requestId, ctx) => {
      await slowGate; // 模拟模态对话框/网络请求挂起
      ctx.sendResponse(requestId, { success: true });
    });
    (h.router as any).registry.set('test.fastOp', async (_data, requestId, ctx) => {
      ctx.sendResponse(requestId, { success: true });
    });

    // 慢操作先进入：route 立即返回（fire-and-forget），ChatViewProvider 的串行队列
    // 得以继续处理下一条消息，不会排队等待慢 handler
    let slowRouted = false;
    const slowRoute = h.router.route('test.slowOp', {}, 'req_slow', h.ctx, 'subagent-monitor').then(() => {
      slowRouted = true;
      return true;
    });
    await flushAsync(30);
    expect(slowRouted).toBe(true);

    // 后续普通消息立即完成并收到响应
    const fastRoute = await h.router.route('test.fastOp', {}, 'req_fast', h.ctx, 'subagent-monitor');
    expect(fastRoute).toBe(true);
    const fastResp = h.monitorMessages.find((m: any) => m.requestId === 'req_fast');
    expect(fastResp).toBeDefined();
    expect(fastResp.success).toBe(true);

    // 释放慢操作，其响应也能正常路由回发起方
    releaseSlow();
    await slowRoute;
    await flushAsync(10);
    const slowResp = h.monitorMessages.find((m: any) => m.requestId === 'req_slow');
    expect(slowResp).toBeDefined();
    expect(slowResp.success).toBe(true);
  });

  it('对照组：普通 handler 会等待完成，route 挂起（证明修复必要性）', async () => {
    const h = createHarness();

    let releaseBlock!: () => void;
    const gate = new Promise<void>(resolve => { releaseBlock = resolve; });

    (h.router as any).registry.set('test.blockOp', async (_data, requestId, ctx) => {
      await gate;
      ctx.sendResponse(requestId, { ok: true });
    });

    // 普通 handler 挂起时 route 不会返回：ChatViewProvider 串行队列被占住，
    // 后续消息（如 savePromptMode）只能排队等待，直到前端超时误报失败
    let routed = false;
    const p = h.router.route('test.blockOp', {}, 'req_b1', h.ctx, 'subagent-monitor').then(() => {
      routed = true;
      return true;
    });
    await flushAsync(30);
    expect(routed).toBe(false);

    releaseBlock();
    await p;
    expect(routed).toBe(true);
    expect(h.monitorMessages.find((m: any) => m.requestId === 'req_b1')).toBeDefined();
  });
});
