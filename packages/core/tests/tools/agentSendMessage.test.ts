import type { RecordMutation, RunRecord } from '@graycode/contracts';
import type { ToolContext } from '@graycode/core';
import { createAgentMessageDeclaration } from '../../../../backend/tools/subagents/createAgentMessageDeclaration';
import { MAIN_SESSION_RUN_ID } from '../../../../backend/core/services/agentMessages';
import { cleanFunctionResponseForAPI } from '../../../../backend/modules/conversation/helpers';
import { PlatformAgentMessages } from '../../../../apps/server/src/subagents/messages';
import { subagentTools } from '../../../../apps/server/src/subagents/tools';
import type { PlatformApplication } from '../../../../apps/server/src/application';
import type { SubagentExecutionService } from '../../../../apps/server/src/subagents/service';
import type { PendingFeedback } from '../../../../apps/server/src/subagents/feedback';

/** 只替换存储与调度端口；身份校验、寻址、消息内容和回执均经过真实平台发送入口。 */
function fixture() {
    const rootId = 'conv_1';
    const peers = [
        { id: 'run_a', agentName: 'Agent A', conversationId: 'conv_1:run_a' },
        { id: 'run_b', agentName: 'Agent B', conversationId: 'conv_1:run_b' },
        { id: 'run_coder', agentName: 'coder', conversationId: 'conv_1:run_coder' },
    ];
    const runs = new Map<string, RunRecord>(
        [{ id: 'main-run', conversationId: rootId }, ...peers.map((peer) => ({ id: peer.id, conversationId: peer.conversationId }))].map((run) => [
            run.id,
            {
                ...run,
                actorId: 'owner',
                agentId: 'fixture',
                requestKey: run.id,
                status: 'running',
                iteration: 0,
                catalogVersion: 'fixture',
                createdAt: 0,
                updatedAt: 0,
            },
        ]),
    );
    const records = new Map<string, unknown>();
    const pending: PendingFeedback[] = [];
    const feedback = {
        pendingIds: jest.fn(async (conversationId: string) =>
            pending.filter((item) => item.conversationId === conversationId && !item.displayOnly).map((item) => item.id),
        ),
        enqueueMessages: jest.fn(async (messages: PendingFeedback[], mutations: RecordMutation[]) => {
            for (const mutation of mutations) {
                const key = `${mutation.namespace}:${mutation.id}`;
                if ('delete' in mutation) records.delete(key);
                else records.set(key, structuredClone(mutation.value));
            }
            pending.push(...structuredClone(messages));
        }),
        flush: jest.fn(async () => true),
    };
    const app = {
        storage: {
            getRun: jest.fn(async (id: string) => runs.get(id) ?? null),
            getRecord: jest.fn(async (namespace: string, id: string) => records.get(`${namespace}:${id}`) ?? null),
            getVersionedRecord: jest.fn(async (namespace: string, id: string) => ({
                revision: 0,
                value: records.get(`${namespace}:${id}`) ?? null,
            })),
        },
        conversation: jest.fn(async () => {}),
        publish: jest.fn(),
    };
    const agents = {
        feedback,
        rootConversationId: () => rootId,
        recordForRun: (run: RunRecord) => peers.find((peer) => peer.id === run.id),
        isChildConversation: (conversationId: string) => conversationId !== rootId,
        acceptsMessages: () => true,
        messageParticipants: () => peers,
        rootParentRunId: () => 'main-run',
        rootParentConfiguration: () => undefined,
        detachToMain: jest.fn(async () => {}),
    };
    const messages = new PlatformAgentMessages(app as unknown as PlatformApplication, agents as unknown as SubagentExecutionService);
    let call = 0;
    const context = (runId = 'run_a'): ToolContext => ({
        actorId: 'owner',
        runId,
        conversationId: runs.get(runId)!.conversationId,
        toolCallId: `call-${++call}`,
        signal: new AbortController().signal,
        progress: jest.fn(),
        askUser: jest.fn(),
    });
    return { app, agents, messages, pending, feedback, context, peers, rootId };
}

describe('agent_send_message - 平台工具声明', () => {
    test('声明名称与参数结构正确，message 必填', () => {
        const declaration = createAgentMessageDeclaration(true);
        expect(declaration.name).toBe('agent_send_message');
        expect(declaration.aliases).toContain('agent.sendMessage');
        expect(declaration.category).toBe('agents');
        expect(declaration.parameters.type).toBe('object');
        expect(declaration.parameters.properties.targetRunId.type).toBe('string');
        expect(declaration.parameters.properties.targetAgentName.type).toBe('string');
        expect(declaration.parameters.properties.threadId.type).toBe('string');
        expect(declaration.parameters.required).toContain('message');
    });

    test('消息工具与派发工具均由平台 subagentTools 注册', () => {
        const f = fixture();
        const names = subagentTools(f.app as unknown as PlatformApplication).map((tool) => tool.declaration.name);
        expect(names).toContain('agent_send_message');
        expect(names).toContain('subagents');
    });
});

describe('agent_send_message - 平台发送入口', () => {
    test('子代理发送成功：身份来自可信运行上下文，返回 threadId', async () => {
        const f = fixture();
        const result = await f.messages.send({ targetRunId: 'run_b', message: 'hello' }, f.context());

        expect(result).toMatchObject({ success: true, data: { toRunId: 'run_b', hopDepth: 1 } });
        expect(typeof (result.data as { threadId: string }).threadId).toBe('string');
        const delivered = f.pending.filter((item) => item.conversationId === 'conv_1:run_b');
        expect(delivered).toHaveLength(1);
        expect(delivered[0].message.agentMessage).toMatchObject({ fromRunId: 'run_a', fromAgentName: 'Agent A', text: 'hello' });
    });

    test('子代理发给空闲主模型时先保存反馈，再请求立即交付', async () => {
        const f = fixture();
        const result = await f.messages.send({ targetAgentName: 'main', message: 'wake the main model' }, f.context());

        expect(result.success).toBe(true);
        expect(f.pending).toHaveLength(1);
        expect(f.pending[0]).toMatchObject({
            conversationId: f.rootId,
            message: {
                source: 'agent_message',
                agentMessage: { toRunId: MAIN_SESSION_RUN_ID, text: 'wake the main model' },
            },
        });
        expect(f.feedback.flush).toHaveBeenCalledWith(f.rootId);
        expect(f.feedback.enqueueMessages.mock.invocationCallOrder[0]).toBeLessThan(f.feedback.flush.mock.invocationCallOrder[0]);
    });

    test('前台子代理发给主模型时调用 detachToMain 解除父任务等待', async () => {
        const f = fixture();
        const result = await f.messages.send({ targetAgentName: 'main', message: 'deliver before I finish' }, f.context());

        expect(result.success).toBe(true);
        expect(f.agents.detachToMain).toHaveBeenCalledWith(f.peers[0]);
        expect(f.feedback.flush).toHaveBeenCalledWith(f.rootId);
    });

    test('主会话作为发送方时使用主会话保留 runId', async () => {
        const f = fixture();
        const result = await f.messages.send({ targetRunId: 'run_b', message: 'from main' }, f.context('main-run'));

        expect(result.success).toBe(true);
        const delivered = f.pending.find((item) => item.conversationId === 'conv_1:run_b')!;
        expect(delivered.message.agentMessage).toMatchObject({ fromRunId: MAIN_SESSION_RUN_ID, fromAgentName: 'main' });
    });

    test('缺少会话上下文时拒绝', async () => {
        const f = fixture();
        await expect(
            f.messages.send(
                { targetRunId: 'run_b', message: 'hi' },
                {
                    ...f.context(),
                    conversationId: undefined,
                },
            ),
        ).rejects.toThrow('经过认证的当前任务');
        expect(f.pending).toHaveLength(0);
    });

    test('未知目标 runId 时拒绝并返回明确错误', async () => {
        const f = fixture();
        expect(await f.messages.send({ targetRunId: 'ghost_run', message: 'hi' }, f.context())).toMatchObject({
            success: false,
            error: expect.stringContaining('Unknown targetRunId'),
        });
        expect(f.pending).toHaveLength(0);
    });

    test('消息为空时拒绝', async () => {
        const f = fixture();
        expect(await f.messages.send({ targetRunId: 'run_b', message: '   ' }, f.context())).toMatchObject({
            success: false,
            error: expect.stringContaining('message'),
        });
        expect(f.pending).toHaveLength(0);
    });

    test('按 agent 名称寻址（含 main）', async () => {
        const f = fixture();
        expect(await f.messages.send({ targetAgentName: 'coder', message: 'hi' }, f.context())).toMatchObject({
            success: true,
            data: { toRunId: 'run_coder' },
        });
        expect(await f.messages.send({ targetAgentName: 'main', message: 'hi main' }, f.context())).toMatchObject({
            success: true,
            data: { toRunId: MAIN_SESSION_RUN_ID },
        });
    });
});

describe('agent_send_message - 历史回执与卡片', () => {
    test('历史中的 functionResponse 保留 agentInbox，历史字节保持稳定', () => {
        const agentInbox = [{ fromRunId: 'run_a', fromAgentName: 'Agent A', text: 'do not replay' }];
        const injected = { success: true, agentInbox, data: { applied: true, agentInbox } };
        const cleaned = cleanFunctionResponseForAPI(injected);

        expect(cleaned?.agentInbox).toEqual(injected.agentInbox);
        expect((cleaned?.data as Record<string, unknown>)?.agentInbox).toEqual(injected.data.agentInbox);
        expect(cleaned?.success).toBe(true);
        expect((cleaned?.data as Record<string, unknown>)?.applied).toBe(true);
    });

    test('代理间消息保留完整卡片和收件身份，主模型只收到展示记录', async () => {
        const f = fixture();
        const result = await f.messages.send({ targetRunId: 'run_b', message: 'please check the file' }, f.context());
        expect(result.success).toBe(true);

        const delivered = f.pending.find((item) => item.conversationId === 'conv_1:run_b')!;
        const display = f.pending.find((item) => item.conversationId === f.rootId)!;
        expect(delivered.message.agentMessage).toMatchObject({
            messageId: (result.data as { messageId: string }).messageId,
            fromRunId: 'run_a',
            fromAgentName: 'Agent A',
            toRunId: 'run_b',
            toAgentName: 'Agent B',
            threadId: (result.data as { threadId: string }).threadId,
            hopDepth: 1,
            text: 'please check the file',
        });
        expect(display).toMatchObject({ displayOnly: true, message: { parts: [], source: 'agent_message' } });
        expect(display.message.agentMessage).toEqual(delivered.message.agentMessage);
        expect(f.pending.filter((item) => item.conversationId === f.rootId && !item.displayOnly)).toHaveLength(0);
    });
});
