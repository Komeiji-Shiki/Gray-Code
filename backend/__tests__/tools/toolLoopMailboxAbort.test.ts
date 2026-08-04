/**
 * R7a E-1：主会话信箱 drain 的 abort 边角回归测试（ToolIterationLoopService.runToolLoop 集成）。
 *
 * 背景（E-1）：流式边执行早启动生成器若在持有 drain epoch 期间完成 drain，随后流中途
 * cancel 且携带 agentInbox 的结果被整体丢弃（partialContent.parts.length===0 不落盘，
 * 或调用 id 不在 partialContent 中不结算）时，消息已从 inbox 移除、未持久化 = 丢失。
 *
 * 修复（方案②，改动小且语义正确）：早启动生成器一律不 drain（执行时不传 mailbox 身份），
 * 统一由主循环 drain；无主循环时（autoPrefix 为空分支，全部工具已早启动）在落盘前
 * 显式 drain 一次（ToolExecutionService.drainInboxIntoResults）。
 *
 * 覆盖：
 * - 早启动执行期间不 drain → 流中途 cancel → 主会话 inbox 消息保留（不丢）；
 * - 早启动执行期间不 drain → 无主循环 → 落盘前显式 drain → 消息随最终落盘的
 *   functionResponse 一起投递（inbox 清空、历史携带 agentInbox）；
 * - 主循环接管：早启动不 drain，消息由主循环执行结果投递。
 */

import { ToolIterationLoopService } from '../../modules/api/chat/services/ToolIterationLoopService';
import { ToolExecutionService } from '../../modules/api/chat/services/ToolExecutionService';
import { agentMailbox, MAIN_SESSION_RUN_ID } from '../../tools/subagents/agentMailbox';
import type { Content } from '../../modules/conversation/types';

/** 挂起直到测试主动放行的工具（模拟流式期间启动、结果晚于 cancel 到达的工具） */
function makeGatedTool() {
    let releaseGate!: () => void;
    let handlerStarted!: () => void;
    const gate = new Promise<void>(resolve => { releaseGate = () => resolve(); });
    const started = new Promise<void>(resolve => { handlerStarted = () => resolve(); });
    const tool = {
        declaration: {
            name: 'gated_tool',
            description: 'gated stub',
            parameters: { type: 'object', properties: {}, required: [] }
        },
        handler: async () => {
            handlerStarted();
            await gate;
            return { success: true, data: { applied: true } };
        }
    };
    return { tool, releaseGate, handlerStarted };
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

describe('E-1：早启动生成器不 drain——abort 边角主会话 inbox 消息不丢', () => {
    afterEach(() => {
        agentMailbox.clearAll();
    });

    it('流中途 cancel：早启动工具不消费 inbox，消息保留（不丢失）', async () => {
        const convId = 'conv-e1-abort';
        agentMailbox.registerRun(convId, 'run_a', 'Agent A');
        agentMailbox.sendMessage({
            conversationId: convId, fromRunId: 'run_a', targetRunId: MAIN_SESSION_RUN_ID, text: 'keep-me'
        });
        expect(agentMailbox.peekMessages(convId, MAIN_SESSION_RUN_ID)).toHaveLength(1);

        const gated = makeGatedTool();
        const controller = new AbortController();
        async function* stream() {
            yield { delta: [{ text: 'hello' }] };
            yield { delta: [{ functionCall: { id: 'call_early', name: 'gated_tool', args: { query: 'x' } } }] };
            // 等早启动工具真正开始执行（若它参与 drain，此时消息已被消费）
            await gated.handlerStarted;
            controller.abort();
            // abort 后仍推一个 chunk，让 processStream 在下一轮循环观察到取消
            yield { delta: [{ text: 'tail' }] };
        }
        const channelManager = { generate: jest.fn().mockReturnValue(stream()) };
        const { service } = createHarness(channelManager, { getTool: () => gated.tool });

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

        await loopPromise;

        // cancel 已触发（走 cancelled 输出）
        expect(outputs.some(o => (o as { cancelled?: boolean })?.cancelled === true)).toBe(true);

        // E-1 修复：早启动生成器不参与 drain → cancel 后消息仍保留在 inbox（未丢）
        expect(agentMailbox.peekMessages(convId, MAIN_SESSION_RUN_ID)).toHaveLength(1);
        expect(agentMailbox.peekMessages(convId, MAIN_SESSION_RUN_ID)[0].text).toBe('keep-me');

        // 释放早启动工具：其结果在 cancel 后不被结算（不落盘），但因为它从不 drain，
        // 消息不会随被丢弃的结果一起消失
        gated.releaseGate();
        await new Promise(resolve => setTimeout(resolve, 20));
        expect(agentMailbox.peekMessages(convId, MAIN_SESSION_RUN_ID)).toHaveLength(1);
        expect(agentMailbox.peekMessages(convId, MAIN_SESSION_RUN_ID)[0].text).toBe('keep-me');
    });

    it('无主循环（全部工具已早启动）：落盘前显式 drain → 消息随最终 functionResponse 投递', async () => {
        const convId = 'conv-e1-drain';
        agentMailbox.registerRun(convId, 'run_a', 'Agent A');
        agentMailbox.sendMessage({
            conversationId: convId, fromRunId: 'run_a', targetRunId: MAIN_SESSION_RUN_ID, text: 'deliver-me'
        });

        const gated = makeGatedTool();
        const controller = new AbortController(); // 不 abort；只为 waitForNextSettlement 提供真实挂起
        async function* stream() {
            yield { delta: [{ text: 'hello' }] };
            yield { delta: [{ functionCall: { id: 'call_early', name: 'gated_tool', args: { query: 'x' } } }] };
            yield { delta: [], done: true };
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

        // 等早启动工具启动后放行（runToolLoop 正在等待其结算）
        await gated.handlerStarted;
        await new Promise(resolve => setTimeout(resolve, 20));
        gated.releaseGate();
        await loopPromise;

        // 显式 drain：主会话 inbox 已清空（消息只投递一次）
        expect(agentMailbox.peekMessages(convId, MAIN_SESSION_RUN_ID)).toHaveLength(0);

        // 最终落盘的 functionResponse（最后一次 addContent）携带 agentInbox
        const addContentCalls = conversationManager.addContent.mock.calls;
        expect(addContentCalls.length).toBeGreaterThanOrEqual(2);
        const frCall = addContentCalls[addContentCalls.length - 1];
        expect(frCall[0]).toBe(convId);
        expect(frCall[1].isFunctionResponse).toBe(true);
        const frPart = frCall[1].parts.find((p: { functionResponse?: unknown }) => !!p.functionResponse);
        expect(frPart.functionResponse.response.agentInbox).toHaveLength(1);
        expect(frPart.functionResponse.response.agentInbox[0].text).toBe('deliver-me');
        expect(frPart.functionResponse.response.data.agentInbox).toHaveLength(1);
    });

    it('主循环接管：早启动不 drain，消息由主循环执行结果投递', async () => {
        const convId = 'conv-e1-main';
        agentMailbox.registerRun(convId, 'run_a', 'Agent A');
        agentMailbox.sendMessage({
            conversationId: convId, fromRunId: 'run_a', targetRunId: MAIN_SESSION_RUN_ID, text: 'main-takes-over'
        });

        const gated = makeGatedTool();
        const stubTool = {
            declaration: {
                name: 'stub_tool',
                description: 'stub',
                parameters: { type: 'object', properties: {}, required: [] }
            },
            handler: async () => ({ success: true, data: { applied: true } })
        };
        const controller = new AbortController();
        async function* stream() {
            yield { delta: [{ text: 'hello' }] };
            yield { delta: [{ functionCall: { id: 'call_early', name: 'gated_tool', args: { query: 'x' } } }] };
            yield { delta: [], done: true };
        }
        const channelManager = { generate: jest.fn().mockReturnValue(stream()) };
        const { service, conversationManager } = createHarness(channelManager, {
            getTool: (name?: string) => (name === 'gated_tool' ? gated.tool : stubTool)
        });

        const outputs: unknown[] = [];
        const loopPromise = (async () => {
            for await (const output of service.runToolLoop({
                conversationId: convId,
                configId: 'cfg-1',
                config,
                abortSignal: controller.signal,
                maxIterations: 2
            })) {
                outputs.push(output);
            }
        })();

        await gated.handlerStarted;
        // 等主循环执行 stub_tool 完成并 drain（早启动结果已入 streamingToolResults）
        await new Promise(resolve => setTimeout(resolve, 30));
        gated.releaseGate();
        await loopPromise;

        // 主循环 drain：inbox 清空
        expect(agentMailbox.peekMessages(convId, MAIN_SESSION_RUN_ID)).toHaveLength(0);

        // 主循环执行后的 merged addContent 携带 agentInbox
        const addContentCalls = conversationManager.addContent.mock.calls;
        expect(addContentCalls.length).toBeGreaterThanOrEqual(2);
        const frCall = addContentCalls[addContentCalls.length - 1];
        expect(frCall[1].isFunctionResponse).toBe(true);
        const frPart = frCall[1].parts.find((p: { functionResponse?: unknown }) => !!p.functionResponse);
        expect(frPart.functionResponse.response.agentInbox).toHaveLength(1);
        expect(frPart.functionResponse.response.agentInbox[0].text).toBe('main-takes-over');
    });
});
