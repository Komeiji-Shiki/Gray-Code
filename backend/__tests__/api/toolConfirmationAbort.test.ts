/**
 * R7b：ChatFlowService.handleToolConfirmation 两个工具执行循环的 abort-race 回归测试。
 *
 * 背景：确认流程里等待用户确认/工具完成的 while(true) 循环直接 await gen.next()，
 * 若当前工具不响应 abortSignal 且永不结束，整个请求（含停止按钮）永久挂起。
 *
 * 修复：两处循环（队首确认工具循环 + autoSuffix 自动执行循环）都与 abort race；
 * abort 先到时先给生成器一个短暂收尾窗口（取回已完成部分的真实结果），
 * 随后由既有 abort 检查输出 cancelled 可读信号。
 *
 * 覆盖：
 * - 队首确认工具循环：不响应 abort 的生成器 → 取消后不再挂起、输出 cancelled；
 * - autoSuffix 循环：不响应 abort 的生成器 → 取消后不再挂起、输出 cancelled，
 *   且已完成的队首工具真实结果仍被 settleFunctionResponses 结算。
 */

import { ChatFlowService } from '../../modules/api/chat/services/ChatFlowService';

const config = { id: 'cfg-1', type: 'custom', toolMode: 'function_call', model: 'test-model' };

/**
 * 保持本地的 createHarness（createHarness 收敛批次）：overrides.executeFunctionCallsWithProgress +
 * rejectToolCalls/toolNeedsConfirmation/drainInboxIntoResults 接线（ChatFlowService 构造参数位不同），
 * 与共享的 createChatFlowHarness 差异过大，不收敛，见 ../__fixtures__/harnessFixtures.ts 头注释。
 */
function createHarness(overrides: {
    executeFunctionCallsWithProgress?: jest.Mock;
    checkpointService?: { createToolExecutionCheckpoint: jest.Mock };
} = {}) {
    const conversationManager = {
        getHistory: jest.fn().mockResolvedValue([]),
        getHistoryRef: jest.fn().mockResolvedValue([
            {
                id: 'user-1', role: 'user', isUserInput: true,
                deepSeekVisionTileSplit: false,
                parts: [{ text: 'inspect image' }]
            },
            { id: 'msg-1', role: 'model', parts: [{ functionCall: { id: 'call_1', name: 'stub_tool', args: {} } }] }
        ]),
        getCustomMetadata: jest.fn().mockResolvedValue(undefined),
        setCustomMetadata: jest.fn().mockResolvedValue(undefined),
        addContent: jest.fn().mockResolvedValue(undefined),
        settleFunctionResponses: jest.fn().mockResolvedValue(undefined),
        rejectToolCalls: jest.fn().mockResolvedValue(undefined),
        getMessageNodeIdAt: jest.fn().mockResolvedValue(undefined)
    };
    const toolExecutionService = {
        executeFunctionCallsWithProgress: overrides.executeFunctionCallsWithProgress ?? jest.fn(),
        toolNeedsConfirmation: jest.fn().mockReturnValue(false),
        drainInboxIntoResults: jest.fn()
    };
    const toolCallParserService = {
        extractFunctionCalls: jest.fn().mockReturnValue([{ id: 'call_1', name: 'stub_tool', args: {} }]),
        convertPromptModeToolCallsToFunctionCalls: jest.fn(),
        ensureFunctionCallIds: jest.fn()
    };
    const checkpointService: { createToolExecutionCheckpoint: jest.Mock } = overrides.checkpointService ?? { createToolExecutionCheckpoint: jest.fn() };
    const toolIterationLoopService = {
        runToolLoop: jest.fn().mockReturnValue((async function* () { })()),
        runNonStreamLoop: jest.fn(),
        clearTrimState: jest.fn()
    };
    const service = new ChatFlowService(
        { getConfig: jest.fn().mockResolvedValue(config) } as never,
        conversationManager as never,
        undefined as never,
        {} as never,
        {} as never,
        toolIterationLoopService as never,
        checkpointService as never,
        {} as never,
        toolExecutionService as never,
        toolCallParserService as never
    );
    return {
        service,
        conversationManager,
        toolExecutionService,
        toolCallParserService,
        checkpointService,
        toolIterationLoopService
    };
}

/** next() 永不 resolve 的伪生成器（模拟不响应 abort 且永不结束的工具执行） */
function makeHangingGenerator() {
    return {
        next: jest.fn(() => new Promise<never>(() => { })),
        return: jest.fn(),
        throw: jest.fn()
    };
}

describe('handleToolConfirmation 循环与 abort race', () => {
    test('队首确认工具循环：不响应 abort 的生成器取消后不再挂起，输出 cancelled', async () => {
        const controller = new AbortController();
        const hangingGen = makeHangingGenerator();
        const { service } = createHarness({
            executeFunctionCallsWithProgress: jest.fn().mockReturnValue(hangingGen)
        });

        const outputs: unknown[] = [];
        const start = Date.now();
        const loopPromise = (async () => {
            for await (const output of service.handleToolConfirmation({
                conversationId: 'conv-1',
                configId: 'cfg-1',
                toolResponses: [{ id: 'call_1', name: 'stub_tool', confirmed: true }],
                abortSignal: controller.signal
            })) {
                outputs.push(output);
            }
        })();

        // 等第一次 gen.next() 挂起后触发取消
        await new Promise(resolve => setTimeout(resolve, 30));
        expect(hangingGen.next).toHaveBeenCalled();
        controller.abort();
        await loopPromise;

        // 收尾窗口 2s：请求必须返回，不再永久挂起；abort 检查输出 cancelled 可读信号
        expect(Date.now() - start).toBeLessThan(6000);
        expect(outputs.some(o => (o as { cancelled?: boolean })?.cancelled === true)).toBe(true);
    });

    test('autoSuffix 循环：不响应 abort 的生成器取消后不再挂起，且已完成队首工具真实结果仍被结算', async () => {
        const controller = new AbortController();
        const call1 = { id: 'call_1', name: 'stub_tool', args: {} };
        const call2 = { id: 'call_2', name: 'stub_tool2', args: {} };

        // 队首工具正常完成（含 start/end 事件 + done 返回值）
        const fullResult = {
            responseParts: [{ functionResponse: { id: 'call_1', name: 'stub_tool', response: { success: true } } }],
            toolResults: [{ id: 'call_1', name: 'stub_tool', args: {}, result: { success: true } }],
            checkpoints: []
        };
        const completingGen = {
            next: jest.fn()
                .mockResolvedValueOnce({ value: { type: 'start', call: call1 }, done: false })
                .mockResolvedValueOnce({
                    value: { type: 'end', call: call1, toolResult: { id: 'call_1', name: 'stub_tool', args: {}, result: { success: true } } },
                    done: false
                })
                .mockResolvedValueOnce({ value: fullResult, done: true }),
            return: jest.fn(),
            throw: jest.fn()
        };
        // autoSuffix 工具不响应 abort 且永不结束
        const hangingGen = makeHangingGenerator();

        const { service, conversationManager, toolCallParserService } = createHarness({
            executeFunctionCallsWithProgress: jest.fn()
                .mockReturnValueOnce(completingGen)
                .mockReturnValueOnce(hangingGen)
        });
        toolCallParserService.extractFunctionCalls.mockReturnValue([call1, call2]);

        const outputs: unknown[] = [];
        const start = Date.now();
        const loopPromise = (async () => {
            for await (const output of service.handleToolConfirmation({
                conversationId: 'conv-1',
                configId: 'cfg-1',
                toolResponses: [{ id: 'call_1', name: 'stub_tool', confirmed: true }],
                abortSignal: controller.signal
            })) {
                outputs.push(output);
            }
        })();

        // 等 autoSuffix 循环挂起后触发取消
        await new Promise(resolve => setTimeout(resolve, 30));
        expect(hangingGen.next).toHaveBeenCalled();
        controller.abort();
        await loopPromise;

        expect(Date.now() - start).toBeLessThan(6000);
        expect(outputs.some(o => (o as { cancelled?: boolean })?.cancelled === true)).toBe(true);

        // 已完成的队首工具真实结果仍在 abort 前结算（settleFunctionResponses 收到 success:true）
        const settleCalls = conversationManager.settleFunctionResponses.mock.calls as Array<
            [string, Array<{ functionResponse: { id: string; response: Record<string, unknown> } }>]
        >;
        const found = settleCalls.some(call => {
            const parts = call[1] ?? [];
            return parts.some(p =>
                p.functionResponse?.id === 'call_1'
                && (p.functionResponse.response as Record<string, unknown>)?.success === true
            );
        });
        expect(found).toBe(true);
    });

    test('确认路径正常完成：确认工具与 autoSuffix 均以 skip 执行，队列完成后补建 tool_batch after（含批内工具名）', async () => {
        const call1 = { id: 'call_1', name: 'write_file', args: { path: 'a.ts' } };
        const call2 = { id: 'call_2', name: 'execute_command', args: { command: 'x' } };

        const makeCompletingGen = (call: { id: string; name: string; args: Record<string, unknown> }) => ({
            next: jest.fn()
                .mockResolvedValueOnce({ value: { type: 'start', call }, done: false })
                .mockResolvedValueOnce({
                    value: {
                        type: 'end', call,
                        toolResult: { id: call.id, name: call.name, args: call.args, result: { success: true } }
                    },
                    done: false
                })
                .mockResolvedValueOnce({
                    value: {
                        responseParts: [{ functionResponse: { id: call.id, name: call.name, response: { success: true } } }],
                        toolResults: [{ id: call.id, name: call.name, args: call.args, result: { success: true } }],
                        checkpoints: []
                    },
                    done: true
                }),
            return: jest.fn(),
            throw: jest.fn()
        });

        const checkpointService = {
            createToolExecutionCheckpoint: jest.fn().mockResolvedValue({
                id: 'cp-batch-after',
                toolName: 'tool_batch',
                phase: 'after'
            })
        };
        const {
            service,
            conversationManager,
            toolExecutionService,
            toolCallParserService,
            checkpointService: cpService,
            toolIterationLoopService
        } = createHarness({
            checkpointService,
            executeFunctionCallsWithProgress: jest.fn()
                .mockReturnValueOnce(makeCompletingGen(call1))
                .mockReturnValueOnce(makeCompletingGen(call2))
        });
        (toolCallParserService.extractFunctionCalls as jest.Mock).mockReturnValue([call1, call2]);
        (toolExecutionService.toolNeedsConfirmation as jest.Mock).mockImplementation((name: string) => name === 'write_file');

        const outputs: unknown[] = [];
        for await (const output of service.handleToolConfirmation({
            conversationId: 'conv-1',
            configId: 'cfg-1',
            toolResponses: [{ id: 'call_1', name: 'write_file', confirmed: true }]
        })) {
            outputs.push(output);
        }

        // 确认工具与 autoSuffix 均以 checkpointMode='skip' 执行（CPF-07：批次维度统一管理，不再各自建存档）
        expect(toolExecutionService.executeFunctionCallsWithProgress).toHaveBeenCalledTimes(2);
        for (const call of (toolExecutionService.executeFunctionCallsWithProgress as jest.Mock).mock.calls) {
            expect(call[14]).toBe('skip');
        }

        // 队列全部完成：补建一次 tool_batch after，携带批内全部工具名
        expect(cpService.createToolExecutionCheckpoint).toHaveBeenCalledTimes(1);
        const cpCall = (cpService.createToolExecutionCheckpoint as jest.Mock).mock.calls[0];
        expect(cpCall[2]).toBe('tool_batch');
        expect(cpCall[3]).toBe('after');
        expect(cpCall[5].batchToolNames).toEqual(['write_file', 'execute_command']);

        // 补建的 after 随 toolIteration 事件下发
        const toolIterationOutput = outputs.find(o => (o as { toolIteration?: boolean }).toolIteration === true) as {
            checkpoints?: Array<{ toolName: string; phase: string }>;
        } | undefined;
        expect(toolIterationOutput?.checkpoints).toEqual([
            expect.objectContaining({ toolName: 'tool_batch', phase: 'after' })
        ]);

        // 工具结果正常结算（队首与 autoSuffix 均写入历史）
        const settleCalls = conversationManager.settleFunctionResponses.mock.calls as Array<
            [string, Array<{ functionResponse: { id: string } }>]
        >;
        expect(settleCalls.length).toBeGreaterThan(0);
        const settledIds = settleCalls.flatMap(call => (call[1] ?? []).map(p => p.functionResponse?.id));
        expect(settledIds).toContain('call_1');
        expect(settledIds).toContain('call_2');

        // 人工工具确认后的模型续跑从历史真实用户消息恢复压缩模式，不回退默认 true。
        expect(toolIterationLoopService.runToolLoop).toHaveBeenCalledWith(
            expect.objectContaining({ deepSeekVisionTileSplit: false })
        );
    });
});
