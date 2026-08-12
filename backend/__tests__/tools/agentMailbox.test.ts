/**
 * Agent 消息信箱（A-COMM）单元测试
 *
 * 覆盖：投递与消费（drain 一次性语义）；权限（同一对话已知 runId、跨会话隔离、
 *      发送方校验、目标缺失）；按 agent 名称寻址（含主会话 "main"）；
 *      threadId + hopDepth 防循环（深度上限拒绝投递）；run 注销与对话清理。
 */

import {
    agentMailbox,
    AgentMailbox,
    MAIN_SESSION_RUN_ID,
    MAIN_AGENT_NAME,
    MAX_HOP_DEPTH,
    AGENT_MESSAGE_MAX_LENGTH,
    AGENT_INBOX_MAX_MESSAGES,
    MAIN_SESSION_CLAIM_MAX_MESSAGES,
    MAIN_SESSION_CLAIM_MAX_CHARACTERS,
    formatAgentMessagesForModel,
    type AgentMessage
} from '../../core/services/agentMailbox';

describe('AgentMailbox - 投递与消费', () => {
    let mailbox: AgentMailbox;

    beforeEach(() => {
        mailbox = new AgentMailbox();
    });

    test('同一对话下已知 run 之间可投递，drain 一次性取出并清空', () => {
        mailbox.registerRun('conv_1', 'run_a', 'Agent A');
        mailbox.registerRun('conv_1', 'run_b', 'Agent B');

        const sent = mailbox.sendMessage({
            conversationId: 'conv_1',
            fromRunId: 'run_a',
            fromAgentName: 'Agent A',
            targetRunId: 'run_b',
            text: 'hello from A'
        });

        expect(sent.success).toBe(true);
        if (!sent.success) return;
        expect(sent.data.toRunId).toBe('run_b');
        expect(sent.data.hopDepth).toBe(1);
        expect(sent.data.threadId).toBeTruthy();

        // 投递前 peek 能看到
        expect(mailbox.peekMessages('conv_1', 'run_b')).toHaveLength(1);

        // drain 一次取出
        const drained = mailbox.drainMessages('conv_1', 'run_b');
        expect(drained).toHaveLength(1);
        const msg = drained[0];
        expect(msg.fromRunId).toBe('run_a');
        expect(msg.fromAgentName).toBe('Agent A');
        expect(msg.toRunId).toBe('run_b');
        expect(msg.text).toBe('hello from A');
        expect(msg.hopDepth).toBe(1);
        expect(msg.id).toBeTruthy();
        expect(typeof msg.createdAt).toBe('number');

        // 再次 drain 为空（一次性语义）
        expect(mailbox.drainMessages('conv_1', 'run_b')).toHaveLength(0);
    });

    test('未投递消息不会丢：drain 前 peek 为空，发送后才出现', () => {
        mailbox.registerRun('conv_1', 'run_b');
        expect(mailbox.peekMessages('conv_1', 'run_b')).toHaveLength(0);
        expect(mailbox.drainMessages('conv_1', 'run_b')).toHaveLength(0);
    });

    test('多条消息按发送顺序投递', () => {
        mailbox.registerRun('conv_1', 'run_a', 'Agent A');
        mailbox.registerRun('conv_1', 'run_b', 'Agent B');
        mailbox.sendMessage({ conversationId: 'conv_1', fromRunId: 'run_a', targetRunId: 'run_b', text: 'first' });
        mailbox.sendMessage({ conversationId: 'conv_1', fromRunId: 'run_a', targetRunId: 'run_b', text: 'second' });

        const drained = mailbox.drainMessages('conv_1', 'run_b');
        expect(drained.map(m => m.text)).toEqual(['first', 'second']);
    });
});

describe('AgentMailbox - 权限（防冒充/注入）', () => {
    let mailbox: AgentMailbox;

    beforeEach(() => {
        mailbox = new AgentMailbox();
    });

    test('未知 targetRunId 被拒绝，并给出明确错误', () => {
        mailbox.registerRun('conv_1', 'run_a');
        const result = mailbox.sendMessage({
            conversationId: 'conv_1',
            fromRunId: 'run_a',
            targetRunId: 'not_a_known_run',
            text: 'hi'
        });
        expect(result.success).toBe(false);
        if (result.success) return;
        expect(result.error).toContain('Unknown targetRunId');
        expect(result.error).toContain('same conversation');
    });

    test('跨对话隔离：另一对话的 run 不可作为目标，也不可作为发送方', () => {
        mailbox.registerRun('conv_1', 'run_a');
        mailbox.registerRun('conv_2', 'run_b');

        // 目标在另一对话 → 拒绝
        const crossTarget = mailbox.sendMessage({
            conversationId: 'conv_1',
            fromRunId: 'run_a',
            targetRunId: 'run_b',
            text: 'hi'
        });
        expect(crossTarget.success).toBe(false);
        if (crossTarget.success) return;
        expect(crossTarget.error).toContain('Unknown targetRunId');

        // 发送方未在本对话注册 → 拒绝
        const fakeSender = mailbox.sendMessage({
            conversationId: 'conv_1',
            fromRunId: 'run_b',
            targetRunId: 'run_a',
            text: 'hi'
        });
        expect(fakeSender.success).toBe(false);
        if (fakeSender.success) return;
        expect(fakeSender.error).toContain('not a known run');
    });

    test('缺少 conversationId / message / 目标 时拒绝', () => {
        mailbox.registerRun('conv_1', 'run_a');
        mailbox.registerRun('conv_1', 'run_b');

        const noConv = mailbox.sendMessage({
            conversationId: '',
            fromRunId: 'run_a',
            targetRunId: 'run_b',
            text: 'hi'
        });
        expect(noConv.success).toBe(false);
        if (noConv.success) return;
        expect(noConv.error).toContain('conversationId');

        const noText = mailbox.sendMessage({
            conversationId: 'conv_1',
            fromRunId: 'run_a',
            targetRunId: 'run_b',
            text: '   '
        });
        expect(noText.success).toBe(false);
        if (noText.success) return;
        expect(noText.error).toContain('message');

        const noTarget = mailbox.sendMessage({
            conversationId: 'conv_1',
            fromRunId: 'run_a',
            text: 'hi'
        });
        expect(noTarget.success).toBe(false);
        if (noTarget.success) return;
        expect(noTarget.error).toContain('targetRunId or targetAgentName');
    });

    test('主会话（MAIN_SESSION_RUN_ID）隐式已知，可作目标与发送方', () => {
        mailbox.registerRun('conv_1', 'run_a');

        const toMain = mailbox.sendMessage({
            conversationId: 'conv_1',
            fromRunId: 'run_a',
            targetRunId: MAIN_SESSION_RUN_ID,
            text: 'report to main'
        });
        expect(toMain.success).toBe(true);
        if (!toMain.success) return;
        expect(toMain.data.toRunId).toBe(MAIN_SESSION_RUN_ID);
        expect(mailbox.drainMessages('conv_1', MAIN_SESSION_RUN_ID)).toHaveLength(1);

        // 主会话作为发送方
        const fromMain = mailbox.sendMessage({
            conversationId: 'conv_1',
            fromRunId: MAIN_SESSION_RUN_ID,
            fromAgentName: MAIN_AGENT_NAME,
            targetRunId: 'run_a',
            text: 'directive from main'
        });
        expect(fromMain.success).toBe(true);
        const drained = mailbox.drainMessages('conv_1', 'run_a');
        expect(drained[0].fromRunId).toBe(MAIN_SESSION_RUN_ID);
        expect(drained[0].fromAgentName).toBe(MAIN_AGENT_NAME);
    });
});

describe('AgentMailbox - 按 agent 名称寻址', () => {
    let mailbox: AgentMailbox;

    beforeEach(() => {
        mailbox = new AgentMailbox();
    });

    test('targetAgentName 解析到本对话下已注册的同名 run', () => {
        mailbox.registerRun('conv_1', 'run_a', 'Agent A');
        mailbox.registerRun('conv_1', 'run_coder', 'coder');
        mailbox.registerRun('conv_2', 'run_other_coder', 'coder');

        const sent = mailbox.sendMessage({
            conversationId: 'conv_1',
            fromRunId: 'run_a',
            targetAgentName: 'coder',
            text: 'hi coder'
        });
        expect(sent.success).toBe(true);
        if (!sent.success) return;
        expect(sent.data.toRunId).toBe('run_coder');
    });

    test('同名多 run 并行时投给最近注册的 run', () => {
        mailbox.registerRun('conv_1', 'run_a', 'Agent A');
        mailbox.registerRun('conv_1', 'run_coder_1', 'coder');
        mailbox.registerRun('conv_1', 'run_coder_2', 'coder');

        const sent = mailbox.sendMessage({
            conversationId: 'conv_1',
            fromRunId: 'run_a',
            targetAgentName: 'coder',
            text: 'hi'
        });
        expect(sent.success).toBe(true);
        if (!sent.success) return;
        expect(sent.data.toRunId).toBe('run_coder_2');
    });

    test('未知 agent 名称被拒绝，且提示可用寻址方式', () => {
        mailbox.registerRun('conv_1', 'run_a', 'Agent A');
        const result = mailbox.sendMessage({
            conversationId: 'conv_1',
            fromRunId: 'run_a',
            targetAgentName: 'ghost',
            text: 'hi'
        });
        expect(result.success).toBe(false);
        if (result.success) return;
        expect(result.error).toContain('No active run of agent "ghost"');
        expect(result.error).toContain('"main"');
    });

    test('targetAgentName = main 解析到主会话', () => {
        mailbox.registerRun('conv_1', 'run_a', 'Agent A');
        const sent = mailbox.sendMessage({
            conversationId: 'conv_1',
            fromRunId: 'run_a',
            targetAgentName: MAIN_AGENT_NAME,
            text: 'hi main'
        });
        expect(sent.success).toBe(true);
        if (!sent.success) return;
        expect(sent.data.toRunId).toBe(MAIN_SESSION_RUN_ID);
    });
});

describe('AgentMailbox - threadId + hopDepth 防循环', () => {
    let mailbox: AgentMailbox;

    beforeEach(() => {
        mailbox = new AgentMailbox();
    });

    test('同一线程回复 hopDepth 递增，新线程从 1 开始', () => {
        mailbox.registerRun('conv_1', 'run_a', 'Agent A');
        mailbox.registerRun('conv_1', 'run_b', 'Agent B');

        const first = mailbox.sendMessage({ conversationId: 'conv_1', fromRunId: 'run_a', targetRunId: 'run_b', text: '1' });
        expect(first.success).toBe(true);
        if (!first.success) return;
        const threadId = first.data.threadId;
        expect(first.data.hopDepth).toBe(1);

        const second = mailbox.sendMessage({ conversationId: 'conv_1', fromRunId: 'run_b', targetRunId: 'run_a', text: '2', threadId });
        expect(second.success).toBe(true);
        if (!second.success) return;
        expect(second.data.hopDepth).toBe(2);

        // 不带 threadId → 新线程
        const third = mailbox.sendMessage({ conversationId: 'conv_1', fromRunId: 'run_a', targetRunId: 'run_b', text: 'new' });
        expect(third.success).toBe(true);
        if (!third.success) return;
        expect(third.data.threadId).not.toBe(threadId);
        expect(third.data.hopDepth).toBe(1);
    });

    test(`超过 MAX_HOP_DEPTH(${MAX_HOP_DEPTH}) 时拒绝投递并返回明确错误`, () => {
        mailbox.registerRun('conv_1', 'run_a', 'Agent A');
        mailbox.registerRun('conv_1', 'run_b', 'Agent B');

        let threadId = '';
        for (let i = 1; i <= MAX_HOP_DEPTH; i++) {
            const sender = i % 2 === 1 ? 'run_a' : 'run_b';
            const target = i % 2 === 1 ? 'run_b' : 'run_a';
            const sent = mailbox.sendMessage({
                conversationId: 'conv_1',
                fromRunId: sender,
                targetRunId: target,
                text: `hop ${i}`,
                ...(threadId ? { threadId } : {})
            });
            expect(sent.success).toBe(true);
            if (!sent.success) return;
            threadId = sent.data.threadId;
            expect(sent.data.hopDepth).toBe(i);
        }

        // 第 6 跳被拒绝
        const rejected = mailbox.sendMessage({
            conversationId: 'conv_1',
            fromRunId: 'run_a',
            targetRunId: 'run_b',
            text: 'hop 6',
            threadId
        });
        expect(rejected.success).toBe(false);
        if (rejected.success) return;
        expect(rejected.error).toContain('maximum hop depth');
        expect(rejected.error).toContain(String(MAX_HOP_DEPTH));
        expect(rejected.error).toContain('Start a new thread');

        // 拒绝不消费也不推进：该线程消息数不变
        expect(mailbox.getPendingMessageCount()).toBe(MAX_HOP_DEPTH);
    });

    test('深度按线程独立：另一线程不受影响', () => {
        mailbox.registerRun('conv_1', 'run_a');
        mailbox.registerRun('conv_1', 'run_b');

        const t1 = mailbox.sendMessage({ conversationId: 'conv_1', fromRunId: 'run_a', targetRunId: 'run_b', text: 'a' });
        const t2 = mailbox.sendMessage({ conversationId: 'conv_1', fromRunId: 'run_a', targetRunId: 'run_b', text: 'b' });
        expect(t1.success && t2.success).toBe(true);
        if (!t1.success || !t2.success) return;

        const t1reply = mailbox.sendMessage({
            conversationId: 'conv_1', fromRunId: 'run_b', targetRunId: 'run_a', text: 'a2', threadId: t1.data.threadId
        });
        expect(t1reply.success).toBe(true);
        if (!t1reply.success) return;
        expect(t1reply.data.hopDepth).toBe(2);

        const t2reply = mailbox.sendMessage({
            conversationId: 'conv_1', fromRunId: 'run_b', targetRunId: 'run_a', text: 'b2', threadId: t2.data.threadId
        });
        expect(t2reply.success).toBe(true);
        if (!t2reply.success) return;
        expect(t2reply.data.hopDepth).toBe(2);
    });
});

describe('AgentMailbox - 消息长度与 inbox 条数上限', () => {
    let mailbox: AgentMailbox;

    beforeEach(() => {
        mailbox = new AgentMailbox();
    });

    test(`text 超过 AGENT_MESSAGE_MAX_LENGTH(${AGENT_MESSAGE_MAX_LENGTH}) 时拒绝投递，错误信息含上限说明`, () => {
        mailbox.registerRun('conv_1', 'run_a', 'Agent A');
        mailbox.registerRun('conv_1', 'run_b', 'Agent B');

        const oversized = 'x'.repeat(AGENT_MESSAGE_MAX_LENGTH + 1);
        const result = mailbox.sendMessage({
            conversationId: 'conv_1',
            fromRunId: 'run_a',
            targetRunId: 'run_b',
            text: oversized
        });
        expect(result.success).toBe(false);
        if (result.success) return;
        expect(result.error).toContain(String(AGENT_MESSAGE_MAX_LENGTH));
        // 未投递：inbox 保持为空
        expect(mailbox.peekMessages('conv_1', 'run_b')).toHaveLength(0);
        expect(mailbox.getPendingMessageCount()).toBe(0);
    });

    test(`text 恰好等于 AGENT_MESSAGE_MAX_LENGTH 时正常投递`, () => {
        mailbox.registerRun('conv_1', 'run_a', 'Agent A');
        mailbox.registerRun('conv_1', 'run_b', 'Agent B');
        const exact = 'x'.repeat(AGENT_MESSAGE_MAX_LENGTH);
        const result = mailbox.sendMessage({
            conversationId: 'conv_1',
            fromRunId: 'run_a',
            targetRunId: 'run_b',
            text: exact
        });
        expect(result.success).toBe(true);
        expect(mailbox.drainMessages('conv_1', 'run_b')[0].text.length).toBe(AGENT_MESSAGE_MAX_LENGTH);
    });

    test(`目标 inbox 达 AGENT_INBOX_MAX_MESSAGES(${AGENT_INBOX_MAX_MESSAGES}) 条时拒绝后续投递，drain 后可继续`, () => {
        mailbox.registerRun('conv_1', 'run_a', 'Agent A');
        mailbox.registerRun('conv_1', 'run_b', 'Agent B');

        for (let i = 0; i < AGENT_INBOX_MAX_MESSAGES; i++) {
            const sent = mailbox.sendMessage({
                conversationId: 'conv_1',
                fromRunId: 'run_a',
                targetRunId: 'run_b',
                text: `msg ${i}`
            });
            expect(sent.success).toBe(true);
            if (!sent.success) return;
        }
        expect(mailbox.getPendingMessageCount()).toBe(AGENT_INBOX_MAX_MESSAGES);

        const rejected = mailbox.sendMessage({
            conversationId: 'conv_1',
            fromRunId: 'run_a',
            targetRunId: 'run_b',
            text: 'one more'
        });
        expect(rejected.success).toBe(false);
        if (rejected.success) return;
        expect(rejected.error).toContain(String(AGENT_INBOX_MAX_MESSAGES));
        // 拒绝不改变积压条数
        expect(mailbox.getPendingMessageCount()).toBe(AGENT_INBOX_MAX_MESSAGES);

        // drain 后恢复可投递
        mailbox.drainMessages('conv_1', 'run_b');
        const after = mailbox.sendMessage({
            conversationId: 'conv_1',
            fromRunId: 'run_a',
            targetRunId: 'run_b',
            text: 'after drain'
        });
        expect(after.success).toBe(true);
    });

    test('inbox 上限按收件方独立统计，不影响其它收件方', () => {
        mailbox.registerRun('conv_1', 'run_a', 'Agent A');
        mailbox.registerRun('conv_1', 'run_b', 'Agent B');
        mailbox.registerRun('conv_1', 'run_c', 'Agent C');

        for (let i = 0; i < AGENT_INBOX_MAX_MESSAGES; i++) {
            mailbox.sendMessage({ conversationId: 'conv_1', fromRunId: 'run_a', targetRunId: 'run_b', text: `b ${i}` });
        }
        // run_b 的 inbox 已满，run_c 的 inbox 不受影响
        const toB = mailbox.sendMessage({ conversationId: 'conv_1', fromRunId: 'run_a', targetRunId: 'run_b', text: 'to b' });
        expect(toB.success).toBe(false);
        const toC = mailbox.sendMessage({ conversationId: 'conv_1', fromRunId: 'run_a', targetRunId: 'run_c', text: 'to c' });
        expect(toC.success).toBe(true);
    });
});

describe('AgentMailbox - 清理', () => {
    let mailbox: AgentMailbox;

    beforeEach(() => {
        mailbox = new AgentMailbox();
    });

    test('unregisterRun 注销已知记录并清空该 run 的 inbox', () => {
        mailbox.registerRun('conv_1', 'run_a', 'Agent A');
        mailbox.registerRun('conv_1', 'run_b', 'Agent B');
        mailbox.sendMessage({ conversationId: 'conv_1', fromRunId: 'run_a', targetRunId: 'run_b', text: 'hi' });

        mailbox.unregisterRun('conv_1', 'run_b');

        // 注销后不再是已知目标
        expect(mailbox.isKnownRun('conv_1', 'run_b')).toBe(false);
        const sent = mailbox.sendMessage({ conversationId: 'conv_1', fromRunId: 'run_a', targetRunId: 'run_b', text: 'hi again' });
        expect(sent.success).toBe(false);

        // inbox 被清空
        expect(mailbox.peekMessages('conv_1', 'run_b')).toHaveLength(0);
        expect(mailbox.getPendingMessageCount()).toBe(0);
    });

    test('clearConversation 清理该对话的全部信箱状态', () => {
        mailbox.registerRun('conv_1', 'run_a', 'Agent A');
        mailbox.registerRun('conv_1', 'run_b', 'Agent B');
        mailbox.registerRun('conv_2', 'run_c', 'Agent C');
        mailbox.sendMessage({ conversationId: 'conv_1', fromRunId: 'run_a', targetRunId: 'run_b', text: 'hi' });
        mailbox.sendMessage({ conversationId: 'conv_2', fromRunId: 'run_c', targetRunId: 'run_c', text: 'self' });

        mailbox.clearConversation('conv_1');

        expect(mailbox.getPendingMessageCount()).toBe(1);
        expect(mailbox.isKnownRun('conv_1', 'run_b')).toBe(false);
        // 其他对话不受影响
        expect(mailbox.isKnownRun('conv_2', 'run_c')).toBe(true);
    });

    test('clearMainSessionInbox 只重置回合频率状态，不删除未读主会话/子代理消息', () => {
        mailbox.registerRun('conv_1', 'run_a', 'Agent A');
        mailbox.sendMessage({ conversationId: 'conv_1', fromRunId: 'run_a', targetRunId: MAIN_SESSION_RUN_ID, text: 'to main' });
        mailbox.sendMessage({ conversationId: 'conv_1', fromRunId: 'run_a', targetRunId: 'run_a', text: 'self' });
        expect(mailbox.peekMessages('conv_1', MAIN_SESSION_RUN_ID)).toHaveLength(1);
        expect(mailbox.peekMessages('conv_1', 'run_a')).toHaveLength(1);

        mailbox.clearMainSessionInbox('conv_1');

        // 新用户回合不能删除尚未投递的消息；它们会由工具边界或空闲 claim 消费。
        expect(mailbox.peekMessages('conv_1', MAIN_SESSION_RUN_ID)).toHaveLength(1);
        // 子代理 inbox 与已知记录不受影响（由 unregisterRun 管理）
        expect(mailbox.peekMessages('conv_1', 'run_a')).toHaveLength(1);
        expect(mailbox.isKnownRun('conv_1', 'run_a')).toBe(true);
        // 其他会话不受影响
        mailbox.registerRun('conv_2', 'run_b');
        mailbox.sendMessage({ conversationId: 'conv_2', fromRunId: 'run_b', targetRunId: MAIN_SESSION_RUN_ID, text: 'other main' });
        mailbox.clearMainSessionInbox('conv_1');
        expect(mailbox.peekMessages('conv_2', MAIN_SESSION_RUN_ID)).toHaveLength(1);
    });

    test('主会话 claim 采用确认/退回语义，空闲投递失败不会丢消息', () => {
        mailbox.registerRun('conv_1', 'run_a', 'Agent A');
        mailbox.sendMessage({
            conversationId: 'conv_1',
            fromRunId: 'run_a',
            targetRunId: MAIN_SESSION_RUN_ID,
            text: 'idle delivery'
        });

        const firstClaim = mailbox.claimMainSessionAgentMessages('conv_1');
        expect(firstClaim?.messages.map(message => message.text)).toEqual(['idle delivery']);
        expect(mailbox.peekMessages('conv_1', MAIN_SESSION_RUN_ID)).toHaveLength(0);
        expect(mailbox.getPendingMessageCount()).toBe(1); // claim 中仍计为待确认

        // 重复领取返回同一 claim，不会复制正文。
        expect(mailbox.claimMainSessionAgentMessages('conv_1')?.claimId).toBe(firstClaim?.claimId);
        expect(mailbox.releaseMessageClaim('conv_1', MAIN_SESSION_RUN_ID, firstClaim!.claimId)).toBe(true);
        expect(mailbox.peekMessages('conv_1', MAIN_SESSION_RUN_ID)).toHaveLength(1);

        const retryClaim = mailbox.claimMainSessionAgentMessages('conv_1')!;
        expect(mailbox.acknowledgeMessageClaim('conv_1', MAIN_SESSION_RUN_ID, retryClaim.claimId)).toBe(true);
        expect(mailbox.getPendingMessageCount()).toBe(0);
    });

    test('正常完成边界原子关闭：有消息时保持 run，可消费完后再关闭', () => {
        mailbox.registerRun('conv_1', 'run_target', 'Target');
        mailbox.sendMessage({
            conversationId: 'conv_1',
            fromRunId: MAIN_SESSION_RUN_ID,
            targetRunId: 'run_target',
            text: 'last moment'
        });

        const withMail = mailbox.closeRunIfInboxEmpty('conv_1', 'run_target');
        expect(withMail.closed).toBe(false);
        if (withMail.closed) return;
        expect(withMail.messages[0].text).toBe('last moment');
        expect(mailbox.isKnownRun('conv_1', 'run_target')).toBe(true);

        const empty = mailbox.closeRunIfInboxEmpty('conv_1', 'run_target');
        expect(empty.closed).toBe(true);
        expect(mailbox.isKnownRun('conv_1', 'run_target')).toBe(false);
    });

    test('clearMainSessionInbox 缺 conversationId 为 no-op 不抛错', () => {
        mailbox.clearMainSessionInbox('');
        mailbox.clearMainSessionInbox(undefined as any);
        expect(mailbox.getPendingMessageCount()).toBe(0);
    });

    test('注册主会话 runId 为 no-op（主会话隐式已知）', () => {
        mailbox.registerRun('conv_1', MAIN_SESSION_RUN_ID, 'whatever');
        expect(mailbox.isKnownRun('conv_1', MAIN_SESSION_RUN_ID)).toBe(true);
        expect(mailbox.getAgentName('conv_1', MAIN_SESSION_RUN_ID)).toBe(MAIN_AGENT_NAME);
    });

    test('缺少 conversationId/runId 的注册与注销为 no-op 不抛错', () => {
        mailbox.registerRun(undefined, 'run_x');
        mailbox.registerRun('conv_1', undefined);
        mailbox.unregisterRun(undefined, 'run_x');
        mailbox.unregisterRun('conv_1', undefined);
        expect(mailbox.getPendingMessageCount()).toBe(0);
    });
});

describe('AgentMailbox - 主会话结果可靠领取', () => {
    let mailbox: AgentMailbox;

    beforeEach(() => {
        mailbox = new AgentMailbox();
    });

    test('消息使用明确 kind，名为 user 的普通子 agent 结果仍可领取', () => {
        mailbox.registerRun('conv_1', 'run_user', 'user');
        const sent = mailbox.sendMessage({
            conversationId: 'conv_1',
            fromRunId: 'run_user',
            fromAgentName: 'user',
            targetRunId: MAIN_SESSION_RUN_ID,
            text: 'result from agent named user'
        });
        expect(sent.success).toBe(true);

        const claim = mailbox.claimMainSessionAgentMessages('conv_1');
        expect(claim?.messages).toHaveLength(1);
        expect(claim?.messages[0]).toMatchObject({
            fromAgentName: 'user',
            kind: 'agent',
            text: 'result from agent named user'
        });
        expect(formatAgentMessagesForModel(claim!.messages)).toContain('[Agent message received]');
        expect(formatAgentMessagesForModel(claim!.messages)).toContain('From: user (run_user)');
    });

    test('用户插话与可信系统结果分别标记，且兼容缺少 kind 的旧用户插话', () => {
        expect(mailbox.sendUserMessageToMain('conv_1', 'new interrupt').success).toBe(true);
        const interrupt = mailbox.peekMessages('conv_1', MAIN_SESSION_RUN_ID)[0];
        expect(interrupt).toMatchObject({ fromAgentName: 'user', kind: 'user_interrupt' });
        expect(formatAgentMessagesForModel([interrupt])).toContain('[User message received]');

        // 模拟升级前已经驻留在内存中的消息：没有 kind 时保留旧版 user 哨兵兼容。
        delete interrupt.kind;
        expect(mailbox.claimMainSessionAgentMessages('conv_1')).toBeUndefined();

        const system = mailbox.enqueueMainSessionSystemMessage({
            conversationId: 'conv_1',
            messageId: 'background-task:system-1',
            fromRunId: 'finished-run',
            fromAgentName: 'user',
            text: 'trusted completion'
        });
        expect(system.success).toBe(true);
        const claim = mailbox.claimMainSessionAgentMessages('conv_1');
        expect(claim?.messages).toHaveLength(1);
        expect(claim?.messages[0]).toMatchObject({ fromAgentName: 'user', kind: 'system' });
    });

    test('主模型工具边界不会提前消费可信系统结果，必须等写入会话记录后确认', () => {
        mailbox.enqueueMainSessionSystemMessage({
            conversationId: 'conv_reliable',
            messageId: 'background-task:reliable-1',
            fromRunId: 'finished-run',
            text: 'must survive a cancelled tool round'
        });

        expect(mailbox.drainMessages('conv_reliable', MAIN_SESSION_RUN_ID)).toEqual([]);
        expect(mailbox.peekMessages('conv_reliable', MAIN_SESSION_RUN_ID)).toHaveLength(1);

        const claim = mailbox.claimMainSessionAgentMessages('conv_reliable')!;
        expect(claim.messages[0].text).toBe('must survive a cancelled tool round');
        expect(mailbox.acknowledgeMessageClaim(
            'conv_reliable',
            MAIN_SESSION_RUN_ID,
            claim.claimId
        )).toBe(true);
        expect(mailbox.getPendingMessageCount()).toBe(0);
    });

    test('正在写入时不能 release；结束写入后可退回，确认或清理会移除写入状态', () => {
        mailbox.enqueueMainSessionSystemMessage({
            conversationId: 'conv_1',
            messageId: 'background-task:delivery-1',
            fromRunId: 'finished-run',
            text: 'completion'
        });
        const claim = mailbox.claimMainSessionAgentMessages('conv_1')!;

        expect(mailbox.beginMessageClaimDelivery('conv_1', MAIN_SESSION_RUN_ID, claim.claimId)).toBe(true);
        expect(mailbox.beginMessageClaimDelivery('conv_1', MAIN_SESSION_RUN_ID, claim.claimId)).toBe(false);
        expect(mailbox.releaseMessageClaim('conv_1', MAIN_SESSION_RUN_ID, claim.claimId)).toBe(false);
        expect(mailbox.hasMessageClaim('conv_1', MAIN_SESSION_RUN_ID, claim.claimId)).toBe(true);

        expect(mailbox.endMessageClaimDelivery('conv_1', MAIN_SESSION_RUN_ID, claim.claimId)).toBe(true);
        expect(mailbox.releaseMessageClaim('conv_1', MAIN_SESSION_RUN_ID, claim.claimId)).toBe(true);
        const retry = mailbox.claimMainSessionAgentMessages('conv_1')!;
        expect(mailbox.beginMessageClaimDelivery('conv_1', MAIN_SESSION_RUN_ID, retry.claimId)).toBe(true);
        expect(mailbox.acknowledgeMessageClaim('conv_1', MAIN_SESSION_RUN_ID, retry.claimId)).toBe(true);
        expect(mailbox.endMessageClaimDelivery('conv_1', MAIN_SESSION_RUN_ID, retry.claimId)).toBe(false);

        mailbox.enqueueMainSessionSystemMessage({
            conversationId: 'conv_2',
            messageId: 'background-task:delivery-2',
            fromRunId: 'finished-run',
            text: 'completion'
        });
        const clearing = mailbox.claimMainSessionAgentMessages('conv_2')!;
        expect(mailbox.beginMessageClaimDelivery('conv_2', MAIN_SESSION_RUN_ID, clearing.claimId)).toBe(true);
        mailbox.clearConversation('conv_2');
        expect(mailbox.endMessageClaimDelivery('conv_2', MAIN_SESSION_RUN_ID, clearing.claimId)).toBe(false);
    });

    test('删除会话后拒绝迟到的系统结果，注册新 run 可重新激活同一会话 ID', () => {
        mailbox.clearConversation('conv_deleted');
        const late = mailbox.enqueueMainSessionSystemMessage({
            conversationId: 'conv_deleted',
            messageId: 'background-task:late',
            fromRunId: 'old-run',
            text: 'late completion'
        });
        expect(late.success).toBe(false);
        expect(mailbox.getPendingMessageCount()).toBe(0);

        mailbox.registerRun('conv_deleted', 'new-run', 'worker');
        const afterRecreate = mailbox.enqueueMainSessionSystemMessage({
            conversationId: 'conv_deleted',
            messageId: 'background-task:new',
            fromRunId: 'new-run',
            text: 'new completion'
        });
        expect(afterRecreate.success).toBe(true);
        expect(mailbox.claimMainSessionAgentMessages('conv_deleted')?.messages[0].text).toBe('new completion');
    });

    test('领取按条数和总字符分批，并保证单条超长结果仍可领取', () => {
        for (let index = 0; index < MAIN_SESSION_CLAIM_MAX_MESSAGES + 2; index += 1) {
            mailbox.enqueueMainSessionSystemMessage({
                conversationId: 'conv_count',
                messageId: `background-task:count-${index}`,
                fromRunId: `run-${index}`,
                text: `result-${index}`
            });
        }
        const first = mailbox.claimMainSessionAgentMessages('conv_count')!;
        expect(first.messages).toHaveLength(MAIN_SESSION_CLAIM_MAX_MESSAGES);
        mailbox.acknowledgeMessageClaim('conv_count', MAIN_SESSION_RUN_ID, first.claimId);
        expect(mailbox.claimMainSessionAgentMessages('conv_count')?.messages).toHaveLength(2);

        for (let index = 0; index < 2; index += 1) {
            mailbox.enqueueMainSessionSystemMessage({
                conversationId: 'conv_chars',
                messageId: `background-task:chars-${index}`,
                fromRunId: `run-${index}`,
                text: 'x'.repeat(Math.floor(MAIN_SESSION_CLAIM_MAX_CHARACTERS * 0.6))
            });
        }
        const characterLimited = mailbox.claimMainSessionAgentMessages('conv_chars')!;
        expect(characterLimited.messages).toHaveLength(1);
        mailbox.acknowledgeMessageClaim('conv_chars', MAIN_SESSION_RUN_ID, characterLimited.claimId);
        expect(mailbox.claimMainSessionAgentMessages('conv_chars')?.messages).toHaveLength(1);

        mailbox.enqueueMainSessionSystemMessage({
            conversationId: 'conv_oversized',
            messageId: 'background-task:oversized',
            fromRunId: 'run-oversized',
            text: 'x'.repeat(MAIN_SESSION_CLAIM_MAX_CHARACTERS + 1)
        });
        expect(mailbox.claimMainSessionAgentMessages('conv_oversized')?.messages[0].text)
            .toHaveLength(MAIN_SESSION_CLAIM_MAX_CHARACTERS + 1);
    });
});

describe('AgentMailbox - 全局单例', () => {
    afterEach(() => {
        agentMailbox.clearAll();
    });

    test('全局单例可注册、投递并消费', () => {
        agentMailbox.registerRun('conv_1', 'run_a', 'Agent A');
        agentMailbox.registerRun('conv_1', 'run_b', 'Agent B');
        const sent = agentMailbox.sendMessage({
            conversationId: 'conv_1',
            fromRunId: 'run_a',
            targetRunId: 'run_b',
            text: 'through singleton'
        });
        expect(sent.success).toBe(true);
        const drained = agentMailbox.drainMessages('conv_1', 'run_b');
        expect(drained).toHaveLength(1);
        expect((drained[0] as AgentMessage).text).toBe('through singleton');
    });

    test('可信后台结果允许完整超长正文，并以稳定 messageId 跨 inbox/claim 幂等', () => {
        const fullResult = `full-result:${'x'.repeat(AGENT_MESSAGE_MAX_LENGTH + 4096)}`;
        const input = {
            conversationId: 'conv_background',
            messageId: 'background-task:bgagent_1',
            threadId: 'background-task:bgagent_1',
            fromRunId: 'run_finished',
            fromAgentName: 'researcher',
            text: fullResult
        };

        expect(agentMailbox.enqueueMainSessionSystemMessage(input).success).toBe(true);
        expect(agentMailbox.enqueueMainSessionSystemMessage(input).success).toBe(true);
        expect(agentMailbox.getPendingMessageCount()).toBe(1);

        const claim = agentMailbox.claimMainSessionAgentMessages('conv_background');
        expect(claim?.messages).toHaveLength(1);
        expect(claim?.messages[0]).toMatchObject({
            id: input.messageId,
            text: fullResult,
            fromRunId: input.fromRunId,
            fromAgentName: input.fromAgentName
        });

        // 已领取但尚未 ack 时重复终态仍命中 claim 内的同一稳定 ID，不复制消息。
        expect(agentMailbox.enqueueMainSessionSystemMessage(input).success).toBe(true);
        expect(agentMailbox.claimMainSessionAgentMessages('conv_background')?.messages).toHaveLength(1);
        expect(agentMailbox.acknowledgeMessageClaim(
            'conv_background',
            MAIN_SESSION_RUN_ID,
            claim!.claimId
        )).toBe(true);
        expect(agentMailbox.getPendingMessageCount()).toBe(0);
    });
});
