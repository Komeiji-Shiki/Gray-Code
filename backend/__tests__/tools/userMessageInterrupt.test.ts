/**
 * 用户消息插入主会话（U1）单元测试
 *
 * 覆盖：投递成功（写入主会话 inbox、fromAgentName='user'、自动新线程 hopDepth=1）；
 *      入参校验（缺会话 / 空文本 / 超长 / 恰好上限）；每会话频率限制（间隔不足拒绝、超过放行）；
 *      跨会话隔离；clearConversation 重置频率限制并清理 inbox。
 */

import {
    AgentMailbox,
    MAIN_SESSION_RUN_ID,
    USER_INTERRUPT_MAX_LENGTH,
    USER_INTERRUPT_MIN_INTERVAL_MS
} from '../../core/services/agentMailbox';

describe('AgentMailbox.sendUserMessageToMain（U1 用户消息插入）', () => {
    let mailbox: AgentMailbox;
    let nowSpy: jest.SpyInstance;

    beforeEach(() => {
        mailbox = new AgentMailbox();
        nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    });

    afterEach(() => {
        nowSpy.mockRestore();
    });

    test('投递成功：写入主会话 inbox，fromAgentName 为 user，自动新线程 hopDepth=1', () => {
        const result = mailbox.sendUserMessageToMain('conv_1', '  快点处理这个  ');

        expect(result.success).toBe(true);
        if (!result.success) return;
        expect(result.data.toRunId).toBe(MAIN_SESSION_RUN_ID);
        expect(result.data.hopDepth).toBe(1);
        expect(result.data.threadId).toBeTruthy();

        const drained = mailbox.drainMessages('conv_1', MAIN_SESSION_RUN_ID);
        expect(drained).toHaveLength(1);
        const msg = drained[0];
        expect(msg.fromRunId).toBe(MAIN_SESSION_RUN_ID);
        expect(msg.fromAgentName).toBe('user');
        expect(msg.toRunId).toBe(MAIN_SESSION_RUN_ID);
        expect(msg.text).toBe('快点处理这个'); // 已 trim
        expect(msg.id).toBeTruthy();
    });

    test('缺会话 ID → INVALID_CONVERSATION，不产生消息', () => {
        const result = mailbox.sendUserMessageToMain('', 'hello');
        expect(result.success).toBe(false);
        if (result.success) return;
        expect(result.code).toBe('INVALID_CONVERSATION');
        expect(result.error).toBeTruthy();
        expect(mailbox.getPendingMessageCount()).toBe(0);
    });

    test('空文本 → EMPTY_TEXT', () => {
        const result = mailbox.sendUserMessageToMain('conv_1', '   ');
        expect(result.success).toBe(false);
        if (result.success) return;
        expect(result.code).toBe('EMPTY_TEXT');
        expect(mailbox.getPendingMessageCount()).toBe(0);
    });

    test('超过长度上限 → TEXT_TOO_LONG，不产生消息', () => {
        const long = 'x'.repeat(USER_INTERRUPT_MAX_LENGTH + 1);
        const result = mailbox.sendUserMessageToMain('conv_1', long);
        expect(result.success).toBe(false);
        if (result.success) return;
        expect(result.code).toBe('TEXT_TOO_LONG');
        expect(mailbox.getPendingMessageCount()).toBe(0);
    });

    test('恰好等于长度上限可投递', () => {
        const text = 'x'.repeat(USER_INTERRUPT_MAX_LENGTH);
        const result = mailbox.sendUserMessageToMain('conv_1', text);
        expect(result.success).toBe(true);
    });

    test('同一会话频率限制：间隔不足 USER_INTERRUPT_MIN_INTERVAL_MS 拒绝，超过后放行', () => {
        expect(mailbox.sendUserMessageToMain('conv_1', 'first').success).toBe(true);

        // 5 秒后再次发送 → 拒绝（防刷屏）
        nowSpy.mockReturnValue(1_000_000 + 5_000);
        const blocked = mailbox.sendUserMessageToMain('conv_1', 'second');
        expect(blocked.success).toBe(false);
        if (blocked.success) return;
        expect(blocked.code).toBe('RATE_LIMITED');
        expect(blocked.error).toContain('10s');

        // 达到间隔后再次发送 → 放行
        nowSpy.mockReturnValue(1_000_000 + USER_INTERRUPT_MIN_INTERVAL_MS);
        expect(mailbox.sendUserMessageToMain('conv_1', 'third').success).toBe(true);

        const drained = mailbox.drainMessages('conv_1', MAIN_SESSION_RUN_ID);
        expect(drained.map(m => m.text)).toEqual(['first', 'third']);
    });

    test('频率限制按会话隔离：不同会话可同时投递', () => {
        expect(mailbox.sendUserMessageToMain('conv_1', 'a').success).toBe(true);
        expect(mailbox.sendUserMessageToMain('conv_2', 'b').success).toBe(true);
    });

    test('clearConversation 重置频率限制并清理 inbox', () => {
        expect(mailbox.sendUserMessageToMain('conv_1', 'a').success).toBe(true);

        mailbox.clearConversation('conv_1');

        // 清理后立即重发放行
        expect(mailbox.sendUserMessageToMain('conv_1', 'b').success).toBe(true);
        expect(mailbox.peekMessages('conv_1', MAIN_SESSION_RUN_ID)).toHaveLength(1);
    });
});
