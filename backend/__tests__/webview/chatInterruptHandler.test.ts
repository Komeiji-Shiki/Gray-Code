/**
 * chat.sendInterruptMessage 处理器（U1 用户消息插入）单元测试
 *
 * 覆盖：注册表注册；成功投递（inbox 可见）；入参校验（缺会话 / 空文本）；
 *      会话不存在拒绝；频率限制；超长文本；异常路径返回明确错误码。
 */

import { agentMailbox, MAIN_SESSION_RUN_ID } from '../../tools/subagents/agentMailbox';
import {
    awaitConversationIdle,
    claimAgentMessages,
    releaseAgentMessages,
    sendInterruptMessage,
    registerChatHandlers
} from '../../../webview/handlers/ChatHandlers';
import { createMessageHandlerRegistry } from '../../../webview/handlers';

function createCtx(overrides: Record<string, unknown> = {}) {
    const sendResponse = jest.fn();
    const sendError = jest.fn();
    return {
        conversationManager: {
            getMetadata: jest.fn().mockResolvedValue({ id: 'conv_1', title: 't' })
        },
        sendResponse,
        sendError,
        ...overrides
    } as any;
}

describe('chat.sendInterruptMessage 处理器', () => {
    beforeEach(() => {
        agentMailbox.clearAll();
    });

    afterEach(() => {
        agentMailbox.clearAll();
        jest.restoreAllMocks();
    });

    it('已注册进消息处理器注册表', () => {
        const registry = createMessageHandlerRegistry();
        expect(registry.has('chat.sendInterruptMessage')).toBe(true);
        expect(registry.has('chat.awaitConversationIdle')).toBe(true);
        expect(registry.has('chat.claimAgentMessages')).toBe(true);
        expect(registry.has('chat.releaseAgentMessages')).toBe(true);
    });

    it('awaitConversationIdle 等待后端运行控制器真正空闲后才响应', async () => {
        let release!: () => void;
        const waitForIdle = jest.fn(() => new Promise<void>(resolve => { release = resolve; }));
        const ctx = createCtx({ streamAbortControllers: { waitForIdle } });

        const pending = awaitConversationIdle({ conversationId: 'conv_1' }, 'req_idle', ctx);
        await Promise.resolve();
        expect(waitForIdle).toHaveBeenCalledWith('conv_1');
        expect(ctx.sendResponse).not.toHaveBeenCalled();

        release();
        await pending;
        expect(ctx.sendResponse).toHaveBeenCalledWith('req_idle', { idle: true });
    });

    it('成功：投递到主会话 inbox 并返回 { success: true }', async () => {
        const ctx = createCtx();
        await sendInterruptMessage({ conversationId: 'conv_1', text: '快点处理' }, 'req_1', ctx);

        expect(ctx.conversationManager.getMetadata).toHaveBeenCalledWith('conv_1');
        expect(ctx.sendResponse).toHaveBeenCalledWith('req_1', { success: true });
        expect(ctx.sendError).not.toHaveBeenCalled();

        const drained = agentMailbox.drainMessages('conv_1', MAIN_SESSION_RUN_ID);
        expect(drained).toHaveLength(1);
        expect(drained[0].fromAgentName).toBe('user');
        expect(drained[0].text).toBe('快点处理');
    });

    it('空闲主模型领取消息后可确认；发送失败可退回并再次领取', async () => {
        agentMailbox.registerRun('conv_1', 'sender', 'Sender');
        agentMailbox.sendMessage({
            conversationId: 'conv_1',
            fromRunId: 'sender',
            targetRunId: MAIN_SESSION_RUN_ID,
            text: 'background agent says hello'
        });
        const ctx = createCtx();

        await claimAgentMessages({ conversationId: 'conv_1' }, 'claim_1', ctx);
        const payload = ctx.sendResponse.mock.calls.at(-1)?.[1];
        expect(payload.claimId).toEqual(expect.any(String));
        expect(payload.message).toContain('[Agent message received]');
        expect(payload.message).toContain('background agent says hello');
        expect(agentMailbox.getPendingMessageCount()).toBe(1);

        await releaseAgentMessages({ conversationId: 'conv_1', claimId: payload.claimId }, 'release_1', ctx);
        expect(ctx.sendResponse).toHaveBeenCalledWith('release_1', { released: true });
        expect(agentMailbox.peekMessages('conv_1', MAIN_SESSION_RUN_ID)).toHaveLength(1);

        await claimAgentMessages({ conversationId: 'conv_1' }, 'claim_2', ctx);
        const retry = ctx.sendResponse.mock.calls.at(-1)?.[1];
        expect(agentMailbox.acknowledgeMessageClaim('conv_1', MAIN_SESSION_RUN_ID, retry.claimId)).toBe(true);
        expect(agentMailbox.getPendingMessageCount()).toBe(0);
    });

    it('缺会话 ID → INTERRUPT_MESSAGE_INVALID_CONVERSATION，不访问信箱', async () => {
        const ctx = createCtx();
        await sendInterruptMessage({ text: 'hello' }, 'req_1', ctx);

        expect(ctx.sendError).toHaveBeenCalledWith('req_1', 'INTERRUPT_MESSAGE_INVALID_CONVERSATION', expect.any(String));
        expect(ctx.sendResponse).not.toHaveBeenCalled();
        expect(agentMailbox.getPendingMessageCount()).toBe(0);
    });

    it('空文本 → INTERRUPT_MESSAGE_EMPTY_TEXT', async () => {
        const ctx = createCtx();
        await sendInterruptMessage({ conversationId: 'conv_1', text: '   ' }, 'req_1', ctx);

        expect(ctx.sendError).toHaveBeenCalledWith('req_1', 'INTERRUPT_MESSAGE_EMPTY_TEXT', expect.any(String));
        expect(agentMailbox.getPendingMessageCount()).toBe(0);
    });

    it('会话不存在（getMetadata 返回 null）→ INTERRUPT_MESSAGE_CONVERSATION_NOT_FOUND', async () => {
        const ctx = createCtx({
            conversationManager: { getMetadata: jest.fn().mockResolvedValue(null) }
        });
        await sendInterruptMessage({ conversationId: 'ghost_conv', text: 'hello' }, 'req_1', ctx);

        expect(ctx.sendError).toHaveBeenCalledWith('req_1', 'INTERRUPT_MESSAGE_CONVERSATION_NOT_FOUND', expect.any(String));
        expect(agentMailbox.getPendingMessageCount()).toBe(0);
    });

    it('频率限制：10 秒内第二条 → INTERRUPT_MESSAGE_RATE_LIMITED', async () => {
        const ctx = createCtx();
        await sendInterruptMessage({ conversationId: 'conv_1', text: 'first' }, 'req_1', ctx);
        await sendInterruptMessage({ conversationId: 'conv_1', text: 'second' }, 'req_2', ctx);

        expect(ctx.sendResponse).toHaveBeenCalledWith('req_1', { success: true });
        expect(ctx.sendError).toHaveBeenCalledWith('req_2', 'INTERRUPT_MESSAGE_RATE_LIMITED', expect.any(String));

        const drained = agentMailbox.drainMessages('conv_1', MAIN_SESSION_RUN_ID);
        expect(drained).toHaveLength(1); // 只有第一条
    });

    it('超长文本 → INTERRUPT_MESSAGE_TEXT_TOO_LONG', async () => {
        const ctx = createCtx();
        await sendInterruptMessage({ conversationId: 'conv_1', text: 'x'.repeat(4001) }, 'req_1', ctx);

        expect(ctx.sendError).toHaveBeenCalledWith('req_1', 'INTERRUPT_MESSAGE_TEXT_TOO_LONG', expect.any(String));
        expect(agentMailbox.getPendingMessageCount()).toBe(0);
    });

    it('getMetadata 抛异常 → INTERRUPT_MESSAGE_ERROR', async () => {
        const ctx = createCtx({
            conversationManager: { getMetadata: jest.fn().mockRejectedValue(new Error('storage boom')) }
        });
        await sendInterruptMessage({ conversationId: 'conv_1', text: 'hello' }, 'req_1', ctx);

        expect(ctx.sendError).toHaveBeenCalledWith('req_1', 'INTERRUPT_MESSAGE_ERROR', 'storage boom');
    });
});
