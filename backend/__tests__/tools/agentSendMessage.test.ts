/**
 * agent_send_message 工具 + 注入点（A-COMM）测试
 *
 * 覆盖：
 * - 工具声明形状（参数、必填、注册到 SubAgents 工具注册函数）；
 * - handler 成功/失败路径（会话缺失、未知目标、发送方身份自动识别）；
 * - 注入点：ToolExecutionService 每次工具调用完成后，把 inbox 消息追加到
 *   最近一次工具结果之后（functionResponse.response.agentInbox + toolResult.result.agentInbox），
 *   与工具结果一起返回给模型；drain 一次性语义；主会话信箱同样接入；
 *   未传 mailbox 身份时不注入（既有行为不回归）。
 */

import { ToolExecutionService } from '../../modules/api/chat/services/ToolExecutionService';
import { cleanFunctionResponseForAPI } from '../../modules/conversation/helpers';
import {
    agentSendMessageHandler,
    getAgentSendMessageTool,
    getAgentSendMessageToolDeclaration,
    resolveAgentCardInsertPosition
} from '../../tools/subagents';
import { getSubAgentsToolRegistrations } from '../../tools/subagents';
import { agentMailbox, MAIN_SESSION_RUN_ID } from '../../core/services/agentMailbox';
import { TaskManager, type TaskEvent } from '../../tools/taskManager';
import { subAgentRunController } from '../../tools/subagents/runController';

function makeStubTool(handler?: (args: Record<string, unknown>, context?: Record<string, unknown>) => Record<string, unknown> | Promise<Record<string, unknown>>, readOnly = false, name = 'stub_tool') {
    return {
        declaration: {
            name,
            description: 'stub',
            parameters: {
                type: 'object',
                properties: { query: { type: 'string' } },
                required: []
            },
            ...(readOnly ? { readOnly: true } : {})
        },
        handler: async (args: Record<string, unknown>, context?: Record<string, unknown>) =>
            handler ? handler(args, context) : { success: true, data: { applied: true } }
    };
}

function makeCall(id: string, name = 'stub_tool') {
    return { id, name, args: { query: 'x' } };
}

describe('agent_send_message - 工具声明', () => {
    test('声明名称与参数结构正确，message 必填', () => {
        const decl = getAgentSendMessageToolDeclaration();
        expect(decl.name).toBe('agent_send_message');
        // 兼容旧对话历史：agent.sendMessage 注册为别名（API 工具名不允许点号）
        expect(decl.aliases).toContain('agent.sendMessage');
        expect(decl.category).toBe('agents');
        expect(decl.parameters.type).toBe('object');
        expect(decl.parameters.properties.targetRunId.type).toBe('string');
        expect(decl.parameters.properties.targetAgentName.type).toBe('string');
        expect(decl.parameters.properties.threadId.type).toBe('string');
        expect(decl.parameters.required).toContain('message');
    });

    test('已注册进 SubAgents 工具注册函数（随 getAllTools 进入 ToolRegistry）', () => {
        const registrations = getSubAgentsToolRegistrations();
        const names = registrations.map(reg => reg().declaration.name);
        expect(names).toContain('agent_send_message');
        expect(names).toContain('subagents');
    });

    test('getAgentSendMessageTool 返回单例工具对象', () => {
        const tool = getAgentSendMessageTool();
        expect(tool.declaration.name).toBe('agent_send_message');
        expect(getAgentSendMessageTool()).toBe(tool);
    });
});

describe('agent_send_message - handler', () => {
    afterEach(() => {
        agentMailbox.clearAll();
    });

    test('子代理发送成功：身份来自 mailboxRunId/mailboxConversationId，返回 threadId', async () => {
        agentMailbox.registerRun('conv_1', 'run_a', 'Agent A');
        agentMailbox.registerRun('conv_1', 'run_b', 'Agent B');

        const result = await agentSendMessageHandler(
            { targetRunId: 'run_b', message: 'hello' },
            { mailboxConversationId: 'conv_1', mailboxRunId: 'run_a' }
        );

        expect(result.success).toBe(true);
        expect(result.data).toMatchObject({ toRunId: 'run_b', hopDepth: 1 });
        expect(typeof result.data.threadId).toBe('string');

        const drained = agentMailbox.drainMessages('conv_1', 'run_b');
        expect(drained).toHaveLength(1);
        expect(drained[0].fromRunId).toBe('run_a');
        expect(drained[0].fromAgentName).toBe('Agent A');
        expect(drained[0].text).toBe('hello');
    });

    test('子代理发给空闲主模型时发出轻量唤醒事件，正文仍只保存在 mailbox', async () => {
        agentMailbox.registerRun('conv_1', 'run_a', 'Agent A');
        const events: TaskEvent[] = [];
        const dispose = TaskManager.onTaskEvent(event => events.push(event));
        try {
            const result = await agentSendMessageHandler(
                { targetAgentName: 'main', message: 'wake the main model' },
                { mailboxConversationId: 'conv_1', mailboxRunId: 'run_a' }
            );

            expect(result.success).toBe(true);
            if (!result.success) return;
            expect(events).toContainEqual(expect.objectContaining({
                taskId: `agentmsg:${result.data.messageId}`,
                taskType: 'agent_message',
                type: 'progress',
                data: expect.objectContaining({
                    conversationId: 'conv_1',
                    messageId: result.data.messageId,
                    toRunId: MAIN_SESSION_RUN_ID,
                    interruptMainRound: false
                })
            }));
            // 事件不广播正文；正文仍由主模型 claim 接口从 mailbox 领取。
            // tsconfig.test.json lib 为 ES2020，不用 Array.prototype.at（ES2022）
            expect(events[events.length - 1]?.data).not.toHaveProperty('message');
            expect(agentMailbox.peekMessages('conv_1', MAIN_SESSION_RUN_ID)[0].text).toBe('wake the main model');
        } finally {
            dispose();
        }
    });

    test('仍挂父回合的前台子代理发给主模型时，唤醒事件要求打断硬等待', async () => {
        agentMailbox.registerRun('conv_foreground', 'run_foreground', 'Foreground Agent');
        subAgentRunController.register('run_foreground', 'Foreground Agent', 0, true);
        const events: TaskEvent[] = [];
        const dispose = TaskManager.onTaskEvent(event => events.push(event));
        try {
            const result = await agentSendMessageHandler(
                { targetAgentName: 'main', message: 'deliver before I finish' },
                { mailboxConversationId: 'conv_foreground', mailboxRunId: 'run_foreground' }
            );

            expect(result.success).toBe(true);
            if (!result.success) return;
            const event = events.find(candidate => candidate.taskId === `agentmsg:${result.data.messageId}`);
            expect(event?.data).toMatchObject({
                conversationId: 'conv_foreground',
                messageId: result.data.messageId,
                toRunId: MAIN_SESSION_RUN_ID,
                interruptMainRound: true
            });
        } finally {
            dispose();
            subAgentRunController.unregister('run_foreground');
        }
    });

    test('主会话作为发送方：无 mailboxRunId 时回退为主会话保留 runId', async () => {
        agentMailbox.registerRun('conv_1', 'run_b', 'Agent B');

        const result = await agentSendMessageHandler(
            { targetRunId: 'run_b', message: 'from main' },
            { conversationId: 'conv_1' }
        );

        expect(result.success).toBe(true);
        const drained = agentMailbox.drainMessages('conv_1', 'run_b');
        expect(drained[0].fromRunId).toBe(MAIN_SESSION_RUN_ID);
        expect(drained[0].fromAgentName).toBe('main');
    });

    test('缺少会话上下文时拒绝', async () => {
        const result = await agentSendMessageHandler({ targetRunId: 'run_b', message: 'hi' }, {});
        expect(result.success).toBe(false);
        if (result.success) return;
        expect(result.error).toContain('conversation');
    });

    test('未知目标 runId 时拒绝并返回明确错误', async () => {
        agentMailbox.registerRun('conv_1', 'run_a', 'Agent A');
        const result = await agentSendMessageHandler(
            { targetRunId: 'ghost_run', message: 'hi' },
            { mailboxConversationId: 'conv_1', mailboxRunId: 'run_a' }
        );
        expect(result.success).toBe(false);
        if (result.success) return;
        expect(result.error).toContain('Unknown targetRunId');
    });

    test('消息为空时拒绝', async () => {
        agentMailbox.registerRun('conv_1', 'run_a', 'Agent A');
        agentMailbox.registerRun('conv_1', 'run_b', 'Agent B');
        const result = await agentSendMessageHandler(
            { targetRunId: 'run_b', message: '   ' },
            { mailboxConversationId: 'conv_1', mailboxRunId: 'run_a' }
        );
        expect(result.success).toBe(false);
        if (result.success) return;
        expect(result.error).toContain('message');
    });

    test('按 agent 名称寻址（含 main）', async () => {
        agentMailbox.registerRun('conv_1', 'run_a', 'Agent A');
        agentMailbox.registerRun('conv_1', 'run_coder', 'coder');

        const byName = await agentSendMessageHandler(
            { targetAgentName: 'coder', message: 'hi' },
            { mailboxConversationId: 'conv_1', mailboxRunId: 'run_a' }
        );
        expect(byName.success).toBe(true);
        if (!byName.success) return;
        expect(byName.data.toRunId).toBe('run_coder');

        const toMain = await agentSendMessageHandler(
            { targetAgentName: 'main', message: 'hi main' },
            { mailboxConversationId: 'conv_1', mailboxRunId: 'run_a' }
        );
        expect(toMain.success).toBe(true);
        if (!toMain.success) return;
        expect(toMain.data.toRunId).toBe(MAIN_SESSION_RUN_ID);
    });
});

describe('agent_send_message - 注入点（ToolExecutionService 工具循环）', () => {
    afterEach(() => {
        agentMailbox.clearAll();
    });

    test('工具调用完成后 inbox 消息与工具结果一起返回（responseParts + toolResults 均携带）', async () => {
        agentMailbox.registerRun('conv_1', 'run_a', 'Agent A');
        agentMailbox.registerRun('conv_1', 'run_b', 'Agent B');
        agentMailbox.sendMessage({
            conversationId: 'conv_1',
            fromRunId: 'run_a',
            fromAgentName: 'Agent A',
            targetRunId: 'run_b',
            text: 'please check the file'
        });

        const service = new ToolExecutionService({ getTool: () => makeStubTool() } as any, undefined, undefined);
        const result = await service.executeFunctionCallsWithResults(
            [makeCall('call_1')],
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            // A-COMM：子代理信箱身份（会话 + runId）
            'conv_1',
            'run_b'
        );

        // 模型可见：追加到最近一次工具结果的 functionResponse.response
        expect(result.responseParts.length).toBeGreaterThan(0);
        const part = result.responseParts[0] as any;
        expect(part.functionResponse.response.agentInbox).toHaveLength(1);
        expect(part.functionResponse.response.agentInbox[0]).toMatchObject({
            fromRunId: 'run_a',
            fromAgentName: 'Agent A',
            text: 'please check the file',
            hopDepth: 1
        });

        // 前端可见：toolResult.result 同步携带
        const toolResult = result.toolResults[0].result as any;
        expect(toolResult.agentInbox).toHaveLength(1);
        expect(toolResult.agentInbox[0].text).toBe('please check the file');
    });

    test('drain 一次性语义：下一条工具调用不再携带已投递消息', async () => {
        agentMailbox.registerRun('conv_1', 'run_a', 'Agent A');
        agentMailbox.registerRun('conv_1', 'run_b', 'Agent B');
        agentMailbox.sendMessage({ conversationId: 'conv_1', fromRunId: 'run_a', targetRunId: 'run_b', text: 'one-shot' });

        const service = new ToolExecutionService({ getTool: () => makeStubTool() } as any, undefined, undefined);
        const first = await service.executeFunctionCallsWithResults(
            [makeCall('call_1')], undefined, undefined, undefined, undefined, undefined,
            undefined, undefined, undefined, 'conv_1', 'run_b'
        );
        expect((first.responseParts[0] as any).functionResponse.response.agentInbox).toHaveLength(1);

        const second = await service.executeFunctionCallsWithResults(
            [makeCall('call_2')], undefined, undefined, undefined, undefined, undefined,
            undefined, undefined, undefined, 'conv_1', 'run_b'
        );
        expect((second.responseParts[0] as any).functionResponse.response.agentInbox).toBeUndefined();
    });

    test('主会话信箱接入：子代理发给主模型的信在主流工具循环中被带出', async () => {
        agentMailbox.registerRun('conv_1', 'run_a', 'Agent A');
        agentMailbox.sendMessage({
            conversationId: 'conv_1',
            fromRunId: 'run_a',
            fromAgentName: 'Agent A',
            targetRunId: MAIN_SESSION_RUN_ID,
            text: 'task finished, summary: ok'
        });

        const service = new ToolExecutionService({ getTool: () => makeStubTool() } as any, undefined, undefined);
        const result = await service.executeFunctionCallsWithResults(
            [makeCall('call_main')], undefined, undefined, undefined, undefined, undefined,
            undefined, undefined, undefined,
            // 主会话信箱：conversationId + MAIN_SESSION_RUN_ID
            'conv_1', MAIN_SESSION_RUN_ID
        );

        const inbox = (result.responseParts[0] as any).functionResponse.response.agentInbox;
        expect(inbox).toHaveLength(1);
        expect(inbox[0]).toMatchObject({ fromRunId: 'run_a', text: 'task finished, summary: ok' });
    });

    test('并行工具批：消息挂在“最近一次完成”的工具结果之后（仅一次）', async () => {
        agentMailbox.registerRun('conv_1', 'run_a', 'Agent A');
        agentMailbox.registerRun('conv_1', 'run_b', 'Agent B');
        agentMailbox.sendMessage({ conversationId: 'conv_1', fromRunId: 'run_a', targetRunId: 'run_b', text: 'mid-batch' });

        const service = new ToolExecutionService({ getTool: () => makeStubTool(undefined, true) } as any, undefined, undefined);
        const result = await service.executeFunctionCallsWithResults(
            [makeCall('call_p1'), makeCall('call_p2')], undefined, undefined, undefined, undefined, undefined,
            undefined, undefined, undefined, 'conv_1', 'run_b'
        );

        const withInbox = result.responseParts.filter((p: any) => p.functionResponse?.response?.agentInbox);
        expect(withInbox).toHaveLength(1);
        expect((withInbox[0] as any).functionResponse.response.agentInbox[0].text).toBe('mid-batch');
    });

    test('未传 mailbox 身份时不注入（既有行为不回归）', async () => {
        agentMailbox.registerRun('conv_1', 'run_a', 'Agent A');
        agentMailbox.registerRun('conv_1', 'run_b', 'Agent B');
        agentMailbox.sendMessage({ conversationId: 'conv_1', fromRunId: 'run_a', targetRunId: 'run_b', text: 'undelivered' });

        const service = new ToolExecutionService({ getTool: () => makeStubTool() } as any, undefined, undefined);
        const result = await service.executeFunctionCallsWithResults([makeCall('call_1')]);

        expect((result.responseParts[0] as any).functionResponse.response.agentInbox).toBeUndefined();
        // 消息仍留在 inbox（未被错误消费）
        expect(agentMailbox.peekMessages('conv_1', 'run_b')).toHaveLength(1);
    });

    test('工具上下文注入 mailbox 身份（agent_send_message 借此识别发送方）', async () => {
        let capturedContext: Record<string, unknown> | undefined;
        const service = new ToolExecutionService({
            getTool: () => makeStubTool((_args, ctx) => {
                capturedContext = ctx;
                return { success: true, data: {} };
            })
        } as any, undefined, undefined);

        await service.executeFunctionCallsWithResults(
            [makeCall('call_1')], undefined, undefined, undefined, undefined, undefined,
            undefined, undefined, undefined, 'conv_1', 'run_b'
        );

        expect(capturedContext?.mailboxConversationId).toBe('conv_1');
        expect(capturedContext?.mailboxRunId).toBe('run_b');
    });
});

describe('agent_send_message - 历史重放防护（FIX-B）', () => {
    afterEach(() => {
        agentMailbox.clearAll();
    });

    test('当轮注入仍可见：functionResponse.response 顶层与 data 子对象均携带 agentInbox', async () => {
        agentMailbox.registerRun('conv_1', 'run_a', 'Agent A');
        agentMailbox.registerRun('conv_1', 'run_b', 'Agent B');
        agentMailbox.sendMessage({
            conversationId: 'conv_1',
            fromRunId: 'run_a',
            fromAgentName: 'Agent A',
            targetRunId: 'run_b',
            text: 'visible this round'
        });

        const service = new ToolExecutionService({ getTool: () => makeStubTool() } as any, undefined, undefined);
        const result = await service.executeFunctionCallsWithResults(
            [makeCall('call_1')], undefined, undefined, undefined, undefined, undefined,
            undefined, undefined, undefined, 'conv_1', 'run_b'
        );

        const response = (result.responseParts[0] as any).functionResponse.response;
        // 顶层可见
        expect(response.agentInbox).toHaveLength(1);
        expect(response.agentInbox[0].text).toBe('visible this round');
        // data 子对象同样可见（覆盖 formatter 的 JSON/文本两条序列化路径）
        expect(response.data.agentInbox).toHaveLength(1);
        expect(response.data.agentInbox[0].text).toBe('visible this round');
        // 原工具结果字段保留
        expect(response.success).toBe(true);
        expect(response.data.applied).toBe(true);
    });

    test('历史中的 functionResponse 保留 agentInbox：mailbox 保证一次消费，历史稳定保证缓存命中', async () => {
        agentMailbox.registerRun('conv_1', 'run_a', 'Agent A');
        agentMailbox.registerRun('conv_1', 'run_b', 'Agent B');
        agentMailbox.sendMessage({
            conversationId: 'conv_1',
            fromRunId: 'run_a',
            fromAgentName: 'Agent A',
            targetRunId: 'run_b',
            text: 'do not replay'
        });

        const service = new ToolExecutionService({ getTool: () => makeStubTool() } as any, undefined, undefined);
        const result = await service.executeFunctionCallsWithResults(
            [makeCall('call_1')], undefined, undefined, undefined, undefined, undefined,
            undefined, undefined, undefined, 'conv_1', 'run_b'
        );

        // 模拟「历史中的 functionResponse 经 cleanFunctionResponseForAPI 后再发给模型」
        const injected = (result.responseParts[0] as any).functionResponse.response;
        // 当轮确实可见（顶层 + data）
        expect(injected.agentInbox).toBeDefined();
        expect(injected.data.agentInbox).toBeDefined();

        const cleaned = cleanFunctionResponseForAPI(injected);
        expect(cleaned?.agentInbox).toEqual(injected.agentInbox);
        expect((cleaned?.data as Record<string, unknown>)?.agentInbox).toEqual(injected.data.agentInbox);
        // 非信箱字段保留（不破坏既有清理逻辑）
        expect(cleaned?.success).toBe(true);
        expect((cleaned?.data as Record<string, unknown>)?.applied).toBe(true);
    });

    test('无注入目标（最近一次 part 非 functionResponse）时不 drain inbox，消息保留（FIX-B 5.2）', async () => {
        agentMailbox.registerRun('conv_1', 'run_a', 'Agent A');
        agentMailbox.registerRun('conv_1', 'run_b', 'Agent B');
        agentMailbox.sendMessage({ conversationId: 'conv_1', fromRunId: 'run_a', targetRunId: 'run_b', text: 'keep me' });

        const service = new ToolExecutionService({ getTool: () => makeStubTool() } as any, undefined, undefined) as any;
        // 防御路径：responseParts 末尾没有 functionResponse part
        service.injectInboxMessages('conv_1', 'run_b', [], []);

        // 消息未被消费，保留在 inbox（下一次工具调用仍可投递）
        expect(agentMailbox.peekMessages('conv_1', 'run_b')).toHaveLength(1);

        // 正向路径：存在 functionResponse part 时才 drain 并注入
        const part = {
            functionResponse: {
                name: 'stub_tool',
                response: { success: true, data: { applied: true } },
                id: 'call_1'
            }
        };
        const toolResult = {
            id: 'call_1',
            name: 'stub_tool',
            args: {},
            result: { success: true, data: { applied: true } }
        };
        service.injectInboxMessages('conv_1', 'run_b', [part], [toolResult]);

        expect(agentMailbox.peekMessages('conv_1', 'run_b')).toHaveLength(0);
        expect((part.functionResponse.response as any).agentInbox).toHaveLength(1);
        expect((part.functionResponse.response as any).data.agentInbox).toHaveLength(1);
        expect((toolResult.result as any).agentInbox).toHaveLength(1);
    });

    test('MED-1：共享 mailbox 身份的并发执行循环只允许最新启动者 drain（早启动只执行不 drain）', async () => {
        agentMailbox.registerRun('conv_1', 'run_a', 'Agent A');
        agentMailbox.registerRun('conv_1', 'run_b', 'Agent B');

        // 模拟流式早启动循环：早启动工具（gated_tool）执行挂起（等待 gate）
        let releaseEarly!: () => void;
        const earlyGate = new Promise<void>(resolve => { releaseEarly = () => resolve(); });
        let earlyHandlerStarted!: () => void;
        const earlyStarted = new Promise<void>(resolve => { earlyHandlerStarted = () => resolve(); });

        // 同一服务实例（与生产一致：ToolIterationLoopService 共用同一个 ToolExecutionService）：
        // 早启动循环用 gated_tool（挂起），主循环用普通 stub_tool（立即完成）
        const service = new ToolExecutionService({
            getTool: (name?: string) => name === 'gated_tool'
                ? makeStubTool(async () => {
                    earlyHandlerStarted();
                    await earlyGate;
                    return { success: true, data: { applied: true } };
                }, false, 'gated_tool')
                : makeStubTool()
        } as any, undefined, undefined);

        // 早启动循环先开始（领取 epoch 1），工具挂起
        const earlyPromise = service.executeFunctionCallsWithResults(
            [makeCall('call_early', 'gated_tool')], undefined, undefined, undefined, undefined, undefined,
            undefined, undefined, undefined, 'conv_1', 'run_b'
        );
        await earlyStarted;

        // 早启动循环执行期间，消息到达 inbox
        agentMailbox.sendMessage({
            conversationId: 'conv_1', fromRunId: 'run_a', targetRunId: 'run_b', text: 'for-latest-loop'
        });

        // 主循环后启动（领取 epoch 2 = 最新）→ 成为唯一 drain 持有者
        const mainResult = await service.executeFunctionCallsWithResults(
            [makeCall('call_main')], undefined, undefined, undefined, undefined, undefined,
            undefined, undefined, undefined, 'conv_1', 'run_b'
        );
        expect((mainResult.responseParts[0] as any).functionResponse.response.agentInbox).toHaveLength(1);
        expect((mainResult.responseParts[0] as any).functionResponse.response.agentInbox[0].text).toBe('for-latest-loop');

        // 早启动循环完成：已失去 drain 权，其结果不携带 agentInbox（消息未被二次消费）
        releaseEarly();
        const earlyResult = await earlyPromise;
        expect((earlyResult.responseParts[0] as any).functionResponse.response.agentInbox).toBeUndefined();

        // inbox 已清空（消息只挂在主循环结果上一次）
        expect(agentMailbox.peekMessages('conv_1', 'run_b')).toHaveLength(0);
    });

    test('E-1：drainInboxIntoResults 显式 drain 并注入（无主循环路径的最终投递点）', async () => {
        agentMailbox.registerRun('conv_1', 'run_a', 'Agent A');
        agentMailbox.registerRun('conv_1', 'run_b', 'Agent B');
        agentMailbox.sendMessage({
            conversationId: 'conv_1', fromRunId: 'run_a', targetRunId: 'run_b', text: 'explicit-drain'
        });

        const service = new ToolExecutionService({ getTool: () => makeStubTool() } as any, undefined, undefined) as any;
        const part = {
            functionResponse: {
                name: 'stub_tool',
                response: { success: true, data: { applied: true } },
                id: 'call_1'
            }
        };
        const toolResult = {
            id: 'call_1',
            name: 'stub_tool',
            args: {},
            result: { success: true, data: { applied: true } }
        };

        // 不参与 epoch 竞争：不传 epoch 时无条件 drain（调用方保证自己是最终落盘路径）
        service.drainInboxIntoResults('conv_1', 'run_b', [part], [toolResult]);

        expect(agentMailbox.peekMessages('conv_1', 'run_b')).toHaveLength(0);
        expect((part.functionResponse.response as any).agentInbox).toHaveLength(1);
        expect((part.functionResponse.response as any).agentInbox[0].text).toBe('explicit-drain');
        expect((part.functionResponse.response as any).data.agentInbox).toHaveLength(1);
        expect((toolResult.result as any).agentInbox).toHaveLength(1);
    });

    test('E-1：drainInboxIntoResults 无注入目标（非 functionResponse part）时不消费 inbox（消息保留）', () => {
        agentMailbox.registerRun('conv_1', 'run_a', 'Agent A');
        agentMailbox.registerRun('conv_1', 'run_b', 'Agent B');
        agentMailbox.sendMessage({
            conversationId: 'conv_1', fromRunId: 'run_a', targetRunId: 'run_b', text: 'keep me'
        });

        const service = new ToolExecutionService({ getTool: () => makeStubTool() } as any, undefined, undefined) as any;
        service.drainInboxIntoResults('conv_1', 'run_b', [{ text: 'not a function response' }], []);

        expect(agentMailbox.peekMessages('conv_1', 'run_b')).toHaveLength(1);
    });

    test('E-2：正常完成路径释放 drain epoch（mailboxDrainEpochs 不残留）', async () => {
        const service = new ToolExecutionService({ getTool: () => makeStubTool() } as any, undefined, undefined) as any;
        const gen = service.executeFunctionCallsWithProgress(
            [makeCall('call_1')], 'conv_1', 0, undefined, undefined, undefined,
            undefined, undefined, undefined, 'conv_1', 'run_b'
        );
        let next = await gen.next();
        while (!next.done) {
            next = await gen.next();
        }
        // 完成路径：epoch 已释放，Map 无残留条目
        expect((service as any).mailboxDrainEpochs.size).toBe(0);
    });

    test('E-2：生成器异常路径 finally 兜底释放 drain epoch（不残留 Map 条目）', async () => {
        const checkpointService = {
            createToolExecutionCheckpoint: jest.fn().mockRejectedValue(new Error('checkpoint boom'))
        };
        const service = new ToolExecutionService(undefined, undefined, undefined, checkpointService as any) as any;
        const gen = service.executeFunctionCallsWithProgress(
            [makeCall('call_1')], 'conv_1', 0, undefined, undefined, undefined,
            undefined, undefined, undefined, 'conv_1', 'run_b'
        );
        // 检查点创建抛错 → 生成器抛出 → 入口 finally 必须释放 epoch
        await expect(gen.next()).rejects.toThrow(/checkpoint boom/);
        expect((service as any).mailboxDrainEpochs.size).toBe(0);
    });

    test('E-2：clearMailboxDrainEpochsForConversation 只清理指定会话的 epoch 条目', () => {
        const service = new ToolExecutionService({ getTool: () => makeStubTool() } as any, undefined, undefined) as any;
        service.claimMailboxDrainEpoch('conv_a', 'run_1');
        service.claimMailboxDrainEpoch('conv_a', 'run_2');
        service.claimMailboxDrainEpoch('conv_b', 'run_1');
        expect((service as any).mailboxDrainEpochs.size).toBe(3);

        service.clearMailboxDrainEpochsForConversation('conv_a');

        expect((service as any).mailboxDrainEpochs.size).toBe(1);
        expect([...(service as any).mailboxDrainEpochs.keys()][0]).toBe('conv_b' + String.fromCharCode(0) + 'run_1');
        // 幂等：再次清理已无条目
        service.clearMailboxDrainEpochsForConversation('conv_a');
        expect((service as any).mailboxDrainEpochs.size).toBe(1);
    });

describe('agent_send_message - agent 间消息卡片（A-COMM 展示层）', () => {
    afterEach(() => {
        agentMailbox.clearAll();
    });

    test('agent 间消息事件携带完整卡片数据与收件方 runId；正文不进主会话 inbox', async () => {
        agentMailbox.registerRun('conv_1', 'run_a', 'Agent A');
        agentMailbox.registerRun('conv_1', 'run_b', 'Agent B');

        const events: TaskEvent[] = [];
        const dispose = TaskManager.onTaskEvent(event => events.push(event));
        try {
            const result = await agentSendMessageHandler(
                { targetRunId: 'run_b', message: 'please check the file' },
                { mailboxConversationId: 'conv_1', mailboxRunId: 'run_a' }
            );

            expect(result.success).toBe(true);
            if (!result.success) return;

            const event = events[events.length - 1];
            expect(event).toMatchObject({
                taskId: `agentmsg:${result.data.messageId}`,
                taskType: 'agent_message',
                type: 'progress'
            });
            expect(event.data).toMatchObject({
                conversationId: 'conv_1',
                messageId: result.data.messageId,
                toRunId: 'run_b'
            });
            expect(event.data?.card).toMatchObject({
                messageId: result.data.messageId,
                fromRunId: 'run_a',
                fromAgentName: 'Agent A',
                toRunId: 'run_b',
                toAgentName: 'Agent B',
                threadId: result.data.threadId,
                hopDepth: 1,
                text: 'please check the file'
            });
            // 卡片数据走事件，正文不进入主会话 inbox（主模型不消费 agent 间通信）
            expect(agentMailbox.peekMessages('conv_1', MAIN_SESSION_RUN_ID)).toHaveLength(0);
        } finally {
            dispose();
        }
    });

    test('注入 conversationStore 时把卡片插入会话历史：收件方 subagents 工具结果之后', async () => {
        agentMailbox.registerRun('conv_1', 'run_a', 'Agent A');
        agentMailbox.registerRun('conv_1', 'run_b', 'Agent B');

        const history = [
            { role: 'user', parts: [{ text: 'task' }], id: 'm1', parentId: null },
            {
                role: 'model',
                parts: [{ functionCall: { id: 'tool_1', name: 'subagents', args: { agentName: 'B', prompt: 'x' } } }],
                id: 'm2',
                parentId: 'm1'
            },
            {
                role: 'user',
                parts: [{
                    functionResponse: {
                        id: 'tool_1',
                        name: 'subagents',
                        response: { success: true, data: { runId: 'run_b', steps: 1 } }
                    }
                }],
                isFunctionResponse: true,
                id: 'm3',
                parentId: 'm2'
            }
        ];
        const inserted: Array<{ position: number; content: Record<string, unknown> }> = [];
        const store = {
            getCustomMetadata: async () => undefined,
            setCustomMetadata: async () => undefined,
            getHistory: async () => history,
            insertContent: async (_conversationId: string, position: number, content: Record<string, unknown>) => {
                inserted.push({ position, content });
            }
        };

        const result = await agentSendMessageHandler(
            { targetRunId: 'run_b', message: 'hello B' },
            {
                mailboxConversationId: 'conv_1',
                mailboxRunId: 'run_a',
                conversationStore: store
            }
        );

        expect(result.success).toBe(true);
        expect(inserted).toHaveLength(1);
        expect(inserted[0].position).toBe(3); // 工具结果（m3）之后
        expect(inserted[0].content).toMatchObject({
            role: 'user',
            parts: [],
            source: 'agent_message',
            agentMessage: {
                fromRunId: 'run_a',
                fromAgentName: 'Agent A',
                toRunId: 'run_b',
                toAgentName: 'Agent B',
                text: 'hello B',
                hopDepth: 1
            }
        });
    });

    test('找不到收件方锚点时卡片追加到历史末尾', async () => {
        agentMailbox.registerRun('conv_1', 'run_a', 'Agent A');
        agentMailbox.registerRun('conv_1', 'run_b', 'Agent B');

        const history = [
            { role: 'user', parts: [{ text: 'task' }], id: 'm1', parentId: null }
        ];
        const inserted: Array<{ position: number }> = [];
        const store = {
            getCustomMetadata: async () => undefined,
            setCustomMetadata: async () => undefined,
            getHistory: async () => history,
            insertContent: async (_conversationId: string, position: number) => {
                inserted.push({ position });
            }
        };

        const result = await agentSendMessageHandler(
            { targetRunId: 'run_b', message: 'hello' },
            {
                mailboxConversationId: 'conv_1',
                mailboxRunId: 'run_a',
                conversationStore: store
            }
        );

        expect(result.success).toBe(true);
        expect(inserted).toHaveLength(1);
        expect(inserted[0].position).toBe(1); // 历史长度
    });

    test('无 conversationStore 时投递成功且不插入（既有测试上下文兼容）', async () => {
        agentMailbox.registerRun('conv_1', 'run_a', 'Agent A');
        agentMailbox.registerRun('conv_1', 'run_b', 'Agent B');

        const result = await agentSendMessageHandler(
            { targetRunId: 'run_b', message: 'hello' },
            { mailboxConversationId: 'conv_1', mailboxRunId: 'run_a' }
        );

        expect(result.success).toBe(true);
    });

    test('resolveAgentCardInsertPosition：按 functionCall.id 推导 runId 定位；未命中兜底末尾', () => {
        const history = [
            { role: 'user', parts: [{ text: 'task' }] },
            { role: 'model', parts: [{ functionCall: { id: 'tool 1', name: 'subagents', args: {} } }] },
            {
                role: 'user',
                parts: [{
                    functionResponse: {
                        id: 'tool 1',
                        name: 'subagents',
                        response: { success: true, data: { runId: 'subagent_run_tool_1' } }
                    }
                }],
                isFunctionResponse: true
            }
        ];

        // 显式 runId 优先：插到工具结果之后
        expect(resolveAgentCardInsertPosition(history as any, 'subagent_run_tool_1')).toBe(3);
        // functionCall.id 归一化推导（'tool 1' → 'tool_1'）：run 尚未结束（无结果）时也能定位
        const noResultHistory = history.slice(0, 2);
        expect(resolveAgentCardInsertPosition(noResultHistory as any, 'subagent_run_tool_1')).toBe(2);
        // 未知 runId：兜底末尾
        expect(resolveAgentCardInsertPosition(history as any, 'subagent_run_other')).toBe(3);
        // 空历史
        expect(resolveAgentCardInsertPosition([], 'subagent_run_x')).toBe(0);
    });
});
});