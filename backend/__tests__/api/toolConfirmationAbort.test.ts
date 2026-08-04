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

function createHarness(overrides: { executeFunctionCallsWithProgress?: jest.Mock } = {}) {
    const conversationManager = {
        getHistory: jest.fn().mockResolvedValue([]),
        getHistoryRef: jest.fn().mockResolvedValue([
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
    const toolIterationLoopService = {
        runToolLoop: jest.fn(),
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
        {} as never,
        {} as never,
        toolExecutionService as never,
        toolCallParserService as never
    );
    return { service, conversationManager, toolExecutionService, toolCallParserService };
}

/** next() 永不 resolve 的伪生成器（模拟不响应 abort 且永不结束的工具执行） */
function makeHangingGenerator() {
    return {
        next: jest.fn(() => new Promise<never>(() => { })),
        return: jest.fn(),
        throw: jest.fn()
    };
}

describe('R7b：handleToolConfirmation 循环与 abort race', () => {
    it('队首确认工具循环：不响应 abort 的生成器取消后不再挂起，输出 cancelled', async () => {
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

    it('autoSuffix 循环：不响应 abort 的生成器取消后不再挂起，且已完成队首工具真实结果仍被结算', async () => {
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
});
