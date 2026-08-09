/**
 * R7b：ToolIterationLoopService 流式取消路径的高风险并发修复回归测试。
 *
 * 覆盖：
 * 1. 【fix 1 + fix 3】流式取消（processor.isCancelled）时，先等 pending 早启动工具落定，
 *    用真实结果结算（而非只结算"取消时刻已 settle"的工具），并补结算 stop state
 *    （resolveAndPersistPostToolStopState），避免 pendingApprovalGate 残留；
 * 2. 【fix 2】主工具循环 gen.next() 与 abort race：不响应 abortSignal 且永不结束的工具
 *    不再让整个请求（含停止按钮）永久挂起；
 * 3. 【fix 2 收尾语义】主循环 abort 后收尾窗口内响应 abort 的工具返回时，
 *    已完成部分的真实结果仍被结算（防回归：abort 分支的 settle 不能被 race 架空）。
 */

import { ToolIterationLoopService } from '../../modules/api/chat/services/ToolIterationLoopService';
import { ToolExecutionService } from '../../modules/api/chat/services/ToolExecutionService';
import { agentMailbox } from '../../tools/subagents/agentMailbox';
import type { Content } from '../../modules/conversation/types';

/** 挂起直到测试主动放行的工具（模拟流式期间启动、结果晚于 cancel 到达的早启动工具） */
function makeGatedDesignTool() {
    let releaseGate!: () => void;
    let handlerStarted!: () => void;
    const gate = new Promise<void>(resolve => { releaseGate = () => resolve(); });
    const started = new Promise<void>(resolve => { handlerStarted = () => resolve(); });
    const tool = {
        declaration: {
            name: 'create_design',
            description: 'gated design stub',
            parameters: { type: 'object', properties: {}, required: [] }
        },
        handler: async () => {
            handlerStarted();
            await gate;
            // requiresUserConfirmation 会触发 pendingApprovalGate 落库（fix 3 断言目标）
            return { success: true, requiresUserConfirmation: true, path: 'docs/cancel-test.md' };
        }
    };
    return { tool, releaseGate, handlerStarted: started };
}

/** 永不结束、不响应 abort 的工具（模拟主循环里拖死请求的工具） */
function makeHangingTool() {
    let handlerStarted!: () => void;
    const started = new Promise<void>(resolve => { handlerStarted = () => resolve(); });
    const tool = {
        declaration: {
            name: 'apply_diff',
            description: 'hanging stub',
            parameters: { type: 'object', properties: {}, required: [] }
        },
        handler: async () => {
            handlerStarted();
            return new Promise<never>(() => { });
        }
    };
    return { tool, handlerStarted: started };
}

/** 响应 abort 的工具：abort 后立即返回 cancelled 真实结果 */
function makeAbortResponsiveTool() {
    let handlerStarted!: () => void;
    const started = new Promise<void>(resolve => { handlerStarted = () => resolve(); });
    const tool = {
        declaration: {
            name: 'apply_diff',
            description: 'abort-responsive stub',
            parameters: { type: 'object', properties: {}, required: [] }
        },
        handler: async (_args: unknown, ctx: any) => {
            handlerStarted();
            await new Promise<void>((resolve) => {
                const signal = ctx?.abortSignal as AbortSignal | undefined;
                if (signal?.aborted) {
                    resolve();
                    return;
                }
                signal?.addEventListener('abort', () => resolve(), { once: true });
            });
            return { success: false, error: 'aborted', cancelled: true };
        }
    };
    return { tool, handlerStarted: started };
}

function createPromptManagerMock() {
    const emptyBundle = {
        beforeHistoryMessages: [],
        afterHistoryMessages: [],
        dynamicSnapshotBeforeHistoryMessages: [],
        dynamicSnapshotAfterHistoryMessages: [],
        messages: [],
        dynamicSnapshotMessages: [],
        text: '',
        dynamicSnapshotText: '',
        historyPlacement: 'legacy' as const
    };
    return {
        getPromptContextBundle: jest.fn().mockReturnValue(emptyBundle),
        refreshAndGetPrompt: jest.fn().mockReturnValue('sys'),
        getSystemPrompt: jest.fn().mockReturnValue('sys')
    };
}

function createHarness(channelManager: unknown, toolRegistry: unknown) {
    const conversationManager = {
        getHistoryRef: jest.fn().mockResolvedValue([]),
        getCustomMetadata: jest.fn().mockResolvedValue(undefined),
        setCustomMetadata: jest.fn().mockResolvedValue(undefined),
        addContent: jest.fn().mockResolvedValue(undefined),
        settleFunctionResponses: jest.fn().mockResolvedValue(undefined),
        updateMessage: jest.fn().mockResolvedValue(undefined),
        updateMessagesBatch: jest.fn().mockResolvedValue(undefined),
        getMessageNodeIdAt: jest.fn().mockResolvedValue(undefined)
    };
    const toolExecutionService = new ToolExecutionService(toolRegistry as never);
    const checkpointService = {
        createModelMessageCheckpoint: jest.fn().mockResolvedValue(null),
        createToolExecutionCheckpoint: jest.fn().mockResolvedValue(null)
    };
    const messageBuilderService = { buildHistoryOptions: jest.fn().mockReturnValue({}) };
    const contextTrimService = {
        getHistoryWithContextTrimInfo: jest.fn().mockResolvedValue({
            history: [],
            trimStartIndex: 0,
            needsAutoSummarize: false
        })
    };
    const toolCallParserService = {
        convertPromptModeToolCallsToFunctionCalls: jest.fn(),
        ensureFunctionCallIds: jest.fn(),
        extractFunctionCalls: jest.fn().mockImplementation((content: Content) =>
            content.parts
                .filter(p => !!p.functionCall)
                .map(p => ({
                    id: p.functionCall!.id,
                    name: p.functionCall!.name,
                    args: p.functionCall!.args
                }))
        )
    };
    const service = new ToolIterationLoopService(
        channelManager as never,
        conversationManager as never,
        toolCallParserService as never,
        messageBuilderService as never,
        {} as never,
        contextTrimService as never,
        toolExecutionService as never,
        checkpointService as never
    );
    const promptManager = createPromptManagerMock();
    service.setPromptManager(promptManager as never);
    return { service, conversationManager, toolExecutionService, checkpointService, promptManager };
}

const config = { type: 'custom', toolMode: 'function_call', model: 'test-model' } as never;

describe('R7b：流式取消路径的工具结果结算与 abort-race', () => {
    afterEach(() => {
        agentMailbox.clearAll();
    });

    it('fix 1+3：流式取消时延迟落定的早启动工具用真实结果结算，并结算 stop state', async () => {
        const convId = 'conv-cancel-settle';
        const gated = makeGatedDesignTool();
        const controller = new AbortController();
        async function* stream() {
            yield { delta: [{ text: 'hello' }] };
            // 占位壳 + partialArgs 完成：只有参数完成后的 functionCall 才会被早启动
            yield { delta: [{ functionCall: { name: 'create_design', index: 0, args: {} } }] };
            yield { delta: [{ functionCall: { index: 0, partialArgs: '{"path":"docs/cancel-test.md"}' } }] };
            // 等早启动工具真正开始执行后再取消（工具结果晚于 cancel 到达）
            await gated.handlerStarted;
            controller.abort();
            // abort 后仍推一个 chunk，让 processStream 在下一轮循环观察到取消
            yield { delta: [{ text: 'tail' }] };
        }
        const channelManager = { generate: jest.fn().mockReturnValue(stream()) };
        const { service, conversationManager } = createHarness(channelManager, { getTool: () => gated.tool });

        const outputs: unknown[] = [];
        const loopPromise = (async () => {
            for await (const output of service.runToolLoop({
                conversationId: convId,
                configId: 'cfg-1',
                config,
                abortSignal: controller.signal,
                maxIterations: 1
            })) {
                outputs.push(output);
            }
        })();

        // 等 cancel 分支进入收尾窗口后放行工具（模拟"刚完成"的早启动工具）
        await gated.handlerStarted;
        await new Promise(resolve => setTimeout(resolve, 50));
        gated.releaseGate();
        await loopPromise;

        // 取消输出仍在
        expect(outputs.some(o => (o as { cancelled?: boolean })?.cancelled === true)).toBe(true);

        // fix 1：真实结果被结算——settleFunctionResponses 收到 success:true 的真实响应，
        // 而不是 cancelled 占位（{ success:false, error:..., cancelled:true }）。
        // 注意：早启动调用 id 由累加器生成，按工具名匹配；settleFunctionResponses 第二参是 parts 数组。
        const settleCalls = conversationManager.settleFunctionResponses.mock.calls as Array<
            [string, Array<{ functionResponse: { id: string; name: string; response: Record<string, unknown> } }>]
        >;
        const designSettles = settleCalls.filter(call =>
            call[0] === convId && (call[1] ?? []).some(p => p.functionResponse?.name === 'create_design')
        );
        expect(designSettles.length).toBeGreaterThan(0);
        const designPart = designSettles[0][1].find(p => p.functionResponse.name === 'create_design')!;
        expect(designPart.functionResponse.response.success).toBe(true);
        expect(designPart.functionResponse.response.requiresUserConfirmation).toBe(true);

        // fix 3：stop state 结算——create_design + requiresUserConfirmation → pendingApprovalGate 落库
        const gateCalls = conversationManager.setCustomMetadata.mock.calls as Array<[string, string, unknown]>;
        const gateCall = gateCalls.find(call => call[0] === convId && call[1] === 'pendingApprovalGate');
        expect(gateCall).toBeDefined();
        expect((gateCall![2] as { kind?: string })?.kind).toBe('generate_plan');
    });

    it('fix 2：主循环不响应 abort 且永不结束的工具不再让取消挂起', async () => {
        const convId = 'conv-main-hang';
        const hanging = makeHangingTool();
        const controller = new AbortController();
        async function* stream() {
            yield { delta: [{ text: 'hello' }] };
            // apply_diff 是 diff 审阅类工具：不会早启动，走主工具循环
            yield { delta: [{ functionCall: { id: 'call_apply', name: 'apply_diff', args: { oldString: 'a', newString: 'b' } } }] };
            yield { delta: [], done: true };
        }
        const channelManager = { generate: jest.fn().mockReturnValue(stream()) };
        const { service } = createHarness(channelManager, { getTool: () => hanging.tool });

        const outputs: unknown[] = [];
        const start = Date.now();
        const loopPromise = (async () => {
            for await (const output of service.runToolLoop({
                conversationId: convId,
                configId: 'cfg-1',
                config,
                abortSignal: controller.signal,
                maxIterations: 1
            })) {
                outputs.push(output);
            }
        })();

        // 等工具真正进入主循环执行后触发取消
        await hanging.handlerStarted;
        controller.abort();
        await loopPromise;

        const elapsed = Date.now() - start;
        // 收尾窗口 2s：请求必须返回（不永久挂起），且输出 cancelled
        expect(elapsed).toBeLessThan(6000);
        expect(outputs.some(o => (o as { cancelled?: boolean })?.cancelled === true)).toBe(true);
    });

    it('fix 2 收尾：abort 后响应 abort 的工具在收尾窗口内返回时，真实结果仍被结算', async () => {
        const convId = 'conv-main-drain';
        const responsive = makeAbortResponsiveTool();
        const controller = new AbortController();
        async function* stream() {
            yield { delta: [{ text: 'hello' }] };
            yield { delta: [{ functionCall: { id: 'call_apply2', name: 'apply_diff', args: { oldString: 'a', newString: 'b' } } }] };
            yield { delta: [], done: true };
        }
        const channelManager = { generate: jest.fn().mockReturnValue(stream()) };
        const { service, conversationManager } = createHarness(channelManager, { getTool: () => responsive.tool });

        const outputs: unknown[] = [];
        const loopPromise = (async () => {
            for await (const output of service.runToolLoop({
                conversationId: convId,
                configId: 'cfg-1',
                config,
                abortSignal: controller.signal,
                maxIterations: 1
            })) {
                outputs.push(output);
            }
        })();

        await responsive.handlerStarted;
        controller.abort();
        await loopPromise;

        expect(outputs.some(o => (o as { cancelled?: boolean })?.cancelled === true)).toBe(true);

        // 真实（cancelled:true）结果已结算，而不是被丢弃等 rejectAllPendingToolCalls 占位
        const settleCalls = conversationManager.settleFunctionResponses.mock.calls as Array<
            [string, Array<{ functionResponse?: { id?: string; response?: Record<string, unknown> } }>]
        >;
        const found = settleCalls.some(call => {
            const parts = call[1] ?? [];
            return parts.some(p =>
                p.functionResponse?.id === 'call_apply2'
                && (p.functionResponse.response as Record<string, unknown>)?.cancelled === true
            );
        });
        expect(found).toBe(true);
    });

    it('BR-08：drain 收尾超时（不响应 abort 且永不结束的工具）仍结算 cancelled 占位，不留孤儿调用', async () => {
        const convId = 'conv-main-drain-timeout';
        const hanging = makeHangingTool();
        const controller = new AbortController();
        async function* stream() {
            yield { delta: [{ text: 'hello' }] };
            yield { delta: [{ functionCall: { id: 'call_apply3', name: 'apply_diff', args: { oldString: 'a', newString: 'b' } } }] };
            yield { delta: [], done: true };
        }
        const channelManager = { generate: jest.fn().mockReturnValue(stream()) };
        const { service, conversationManager } = createHarness(channelManager, { getTool: () => hanging.tool });

        const outputs: unknown[] = [];
        const loopPromise = (async () => {
            for await (const output of service.runToolLoop({
                conversationId: convId,
                configId: 'cfg-1',
                config,
                abortSignal: controller.signal,
                maxIterations: 1
            })) {
                outputs.push(output);
            }
        })();

        await hanging.handlerStarted;
        controller.abort();
        await loopPromise;

        expect(outputs.some(o => (o as { cancelled?: boolean })?.cancelled === true)).toBe(true);

        // 修复点：drain 超时拿不到真实结果时，仍为调用结算 cancelled 占位
        // （此前整段跳过结算，历史残留无响应的孤儿 tool_calls → 下次请求 400）
        const settleCalls = conversationManager.settleFunctionResponses.mock.calls as Array<
            [string, Array<{ functionResponse?: { id?: string; response?: Record<string, unknown> } }>]
        >;
        const found = settleCalls.some(call => {
            const parts = call[1] ?? [];
            return parts.some(p =>
                p.functionResponse?.id === 'call_apply3'
                && (p.functionResponse.response as Record<string, unknown>)?.cancelled === true
            );
        });
        expect(found).toBe(true);
    });
});
