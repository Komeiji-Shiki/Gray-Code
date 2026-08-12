/**
 * CPF-07：流式早启动工具批次检查点合并测试（ToolIterationLoopService.runToolLoop 集成）。
 *
 * 背景：流式边执行早启动路径对每个工具单独调用 executeFunctionCallsWithResults，若各自
 * 创建检查点，一次模型回复的 N 个工具会产生 N 组 before/after 物理存档（每组独立扫描
 * 工作区 + 前端多行展示 + 消耗 maxCheckpoints 配额）。
 *
 * 修复：批次检查点提升到「一次模型回复 = 一个工具批次」维度统一管理——
 * - before：第一个「已配置存档工具」启动前创建（tool_batch，挂模型消息索引）；
 * - after：全部工具完成后创建（幂等）；
 * - 早启动与主循环执行均以 checkpointMode='skip' 跳过执行核心内部检查点。
 *
 * 覆盖：
 * - 流式早启动多工具 → 只创建一组 before/after（tool_batch，同 messageIndex），
 *   最终 toolIteration 事件下发 [before, after]；执行调用携带 checkpointMode='skip'；
 * - 混合批次（早启动 + 主循环 diff 工具）→ 仍只一组（合并语义）；
 * - 纯只读早启动批次 → 不创建任何检查点（CPF-05 语义保持）；
 * - 流式取消（before 已创建）→ after 不补、cancelled 事件不带 checkpoints；
 * - 纯主循环批次（diff 工具不早启动）→ before 在主循环前创建、after 在完成后创建。
 */
import { createToolLoopHarness } from '../__fixtures__/harnessFixtures';
import type { CheckpointRecord } from '../../modules/checkpoint';

const config = { type: 'custom', toolMode: 'function_call', model: 'test-model' } as never;

/** 简单成功工具 stub（按名返回） */
function makeTool(name: string) {
    return {
        declaration: {
            name,
            description: `${name} stub`,
            parameters: { type: 'object', properties: {}, required: [] }
        },
        handler: async () => ({ success: true, data: { output: 'ok' } })
    };
}

/** 挂起直到主动放行的工具（模拟流式期间启动、结果晚于 cancel 到达的工具） */
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

/** 让 checkpointService 返回带 id 的存档记录（before/after 各一），供最终下发断言 */
function seedCheckpointRecords(checkpointService: { createToolExecutionCheckpoint: jest.Mock }) {
    let seq = 0;
    checkpointService.createToolExecutionCheckpoint.mockImplementation(
        async (_cid: string, messageIndex: number, toolName: string, phase: 'before' | 'after') => ({
            id: `cp-${phase}-${++seq}`,
            conversationId: _cid,
            messageIndex,
            toolName,
            phase,
            timestamp: Date.now(),
            backupDir: 'backup',
            fileCount: 0,
            contentHash: 'h'
        } as CheckpointRecord)
    );
}

/** 收集 runToolLoop 全部输出 */
async function collectOutputs(service: ReturnType<typeof createToolLoopHarness>['service'], options: Record<string, unknown>) {
    const outputs: unknown[] = [];
    for await (const output of service.runToolLoop({
        conversationId: 'conv-cpf7',
        configId: 'cfg-1',
        config,
        maxIterations: 2,
        ...options
    })) {
        outputs.push(output);
    }
    return outputs;
}

describe('CPF-07 流式早启动批次检查点合并', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('流式早启动多工具：只创建一组 before/after（tool_batch，同索引），执行调用带 skip', async () => {
        const cmdTool = makeTool('execute_command');
        async function* stream() {
            yield { delta: [{ text: 'hello' }] };
            yield { delta: [{ functionCall: { id: 'call_1', name: 'execute_command', args: { command: 'a' } } }] };
            yield { delta: [{ functionCall: { id: 'call_2', name: 'execute_command', args: { command: 'b' } } }] };
            yield { delta: [], done: true };
        }
        const channelManager = { generate: jest.fn().mockReturnValue(stream()) };
        const { service, checkpointService, toolExecutionService } = createToolLoopHarness(channelManager, {
            getTool: () => cmdTool
        });
        const execSpy = jest.spyOn(toolExecutionService, 'executeFunctionCallsWithResults');
        seedCheckpointRecords(checkpointService);

        const outputs = await collectOutputs(service, {});

        // 早启动执行了 2 个工具，且每次都以 checkpointMode='skip' 调用（第 15 个参数），
        // messageIndex 不再透传（第 3 个参数 undefined——批次检查点由循环层统一创建）
        expect(execSpy).toHaveBeenCalledTimes(2);
        for (const call of execSpy.mock.calls) {
            expect(call[14]).toBe('skip');
            expect(call[2]).toBeUndefined();
        }

        // 检查点只创建一组：before + after（tool_batch，同一 messageIndex）
        expect(checkpointService.createToolExecutionCheckpoint).toHaveBeenCalledTimes(2);
        const cpCalls = (checkpointService.createToolExecutionCheckpoint as jest.Mock).mock.calls;
        expect(cpCalls[0][2]).toBe('tool_batch');
        expect(cpCalls[0][3]).toBe('before');
        expect(cpCalls[1][2]).toBe('tool_batch');
        expect(cpCalls[1][3]).toBe('after');
        expect(cpCalls[0][1]).toBe(cpCalls[1][1]); // 同 messageIndex（模型消息索引）

        // 最终 toolIteration 事件下发 [before, after]
        const toolIterationOutputs = outputs.filter(o => (o as { toolIteration?: boolean }).toolIteration === true);
        expect(toolIterationOutputs.length).toBeGreaterThanOrEqual(1);
        const last = toolIterationOutputs[toolIterationOutputs.length - 1] as {
            checkpoints: Array<{ phase: string; toolName: string }>;
        };
        expect(last.checkpoints).toHaveLength(2);
        expect(last.checkpoints[0].phase).toBe('before');
        expect(last.checkpoints[0].toolName).toBe('tool_batch');
        expect(last.checkpoints[1].phase).toBe('after');
        expect(last.checkpoints[1].toolName).toBe('tool_batch');
    });

    test('混合批次（早启动 execute_command + 主循环 apply_diff）：合并为一组 before/after', async () => {
        const tools: Record<string, ReturnType<typeof makeTool>> = {
            execute_command: makeTool('execute_command'),
            apply_diff: makeTool('apply_diff')
        };
        async function* stream() {
            yield { delta: [{ text: 'hello' }] };
            yield { delta: [{ functionCall: { id: 'call_1', name: 'execute_command', args: { command: 'a' } } }] };
            yield { delta: [{ functionCall: { id: 'call_2', name: 'apply_diff', args: { path: 'a.ts' } } }] };
            yield { delta: [], done: true };
        }
        const channelManager = {
            // 迭代 1：工具调用流；迭代 2：纯文本收尾
            generate: jest.fn()
                .mockReturnValueOnce(stream())
                .mockReturnValueOnce({ content: { role: 'model', parts: [{ text: 'final' }] } })
        };
        const { service, checkpointService, toolExecutionService } = createToolLoopHarness(channelManager, {
            getTool: (name?: string) => tools[name ?? ''] ?? makeTool('stub')
        });
        const execSpy = jest.spyOn(toolExecutionService, 'executeFunctionCallsWithResults');
        const progressSpy = jest.spyOn(toolExecutionService, 'executeFunctionCallsWithProgress');
        seedCheckpointRecords(checkpointService);

        const outputs = await collectOutputs(service, {});

        // 早启动 1 个（execute_command，走 WithResults）+ 主循环 1 个（apply_diff 不早启动，
        // 走 WithProgress）。WithResults 内部透传调用 WithProgress，故 progressSpy 共 2 次：
        // 早启动（经 WithResults 转发）与主循环各一次，均携带 checkpointMode='skip'（第 15 个参数）
        expect(execSpy).toHaveBeenCalledTimes(1);
        expect(execSpy.mock.calls[0][14]).toBe('skip');
        expect(progressSpy).toHaveBeenCalledTimes(2);
        for (const call of progressSpy.mock.calls) {
            expect(call[14]).toBe('skip');
        }

        // 批次合并：仍只有一组 before/after（tool_batch），before 由早启动触发（同索引）
        expect(checkpointService.createToolExecutionCheckpoint).toHaveBeenCalledTimes(2);
        const cpCalls = (checkpointService.createToolExecutionCheckpoint as jest.Mock).mock.calls;
        expect(cpCalls[0][2]).toBe('tool_batch');
        expect(cpCalls[0][3]).toBe('before');
        expect(cpCalls[1][2]).toBe('tool_batch');
        expect(cpCalls[1][3]).toBe('after');
        expect(cpCalls[0][1]).toBe(cpCalls[1][1]);

        // 迭代 2 纯文本收尾：模型消息 after 存档照常（不影响批次断言）
        const modelAfterCalls = (checkpointService.createModelMessageCheckpoint as jest.Mock).mock.calls;
        expect(modelAfterCalls.length).toBeGreaterThanOrEqual(1);
    });

    test('纯只读早启动批次（未配置存档工具）：不创建任何检查点', async () => {
        const readTool = makeTool('read_file');
        async function* stream() {
            yield { delta: [{ functionCall: { id: 'call_1', name: 'read_file', args: { path: 'a.ts' } } }] };
            yield { delta: [{ functionCall: { id: 'call_2', name: 'read_file', args: { path: 'b.ts' } } }] };
            yield { delta: [], done: true };
        }
        const channelManager = { generate: jest.fn().mockReturnValue(stream()) };
        const { service, checkpointService, toolExecutionService } = createToolLoopHarness(channelManager, {
            getTool: () => readTool
        });
        const execSpy = jest.spyOn(toolExecutionService, 'executeFunctionCallsWithResults');
        // 只读工具未配置存档（CPF-05：纯只读批次不创建全工作区存档）
        (checkpointService.isToolConfiguredForCheckpoint as jest.Mock).mockImplementation(
            (name: string) => name !== 'read_file'
        );

        const outputs = await collectOutputs(service, {});

        // 工具照常早启动执行（2 次），但不创建任何批次检查点
        expect(execSpy).toHaveBeenCalledTimes(2);
        expect(checkpointService.createToolExecutionCheckpoint).not.toHaveBeenCalled();
        const toolIterationOutputs = outputs.filter(o => (o as { toolIteration?: boolean }).toolIteration === true);
        expect(toolIterationOutputs.length).toBeGreaterThanOrEqual(1);
        expect((toolIterationOutputs[toolIterationOutputs.length - 1] as { checkpoints?: unknown[] }).checkpoints).toEqual([]);
    });

    test('流式取消（before 已创建）：不补 after，cancelled 事件不带 checkpoints', async () => {
        const gated = makeGatedTool();
        const controller = new AbortController();
        async function* stream() {
            yield { delta: [{ text: 'hello' }] };
            yield { delta: [{ functionCall: { id: 'call_early', name: 'gated_tool', args: { query: 'x' } } }] };
            await gated.handlerStarted;
            controller.abort();
            yield { delta: [{ text: 'tail' }] };
        }
        const channelManager = { generate: jest.fn().mockReturnValue(stream()) };
        const { service, checkpointService } = createToolLoopHarness(channelManager, { getTool: () => gated.tool });
        seedCheckpointRecords(checkpointService);

        const outputs: unknown[] = [];
        const loopPromise = (async () => {
            for await (const output of service.runToolLoop({
                conversationId: 'conv-cpf7',
                configId: 'cfg-1',
                config,
                abortSignal: controller.signal,
                maxIterations: 1
            })) {
                outputs.push(output);
            }
        })();
        await loopPromise;
        gated.releaseGate();
        await new Promise(resolve => setTimeout(resolve, 20));

        // cancel 已触发；before 创建过一次（工具启动前），after 不补（工具未完成）
        expect(outputs.some(o => (o as { cancelled?: boolean })?.cancelled === true)).toBe(true);
        expect(checkpointService.createToolExecutionCheckpoint).toHaveBeenCalledTimes(1);
        const cpCalls = (checkpointService.createToolExecutionCheckpoint as jest.Mock).mock.calls;
        expect(cpCalls[0][2]).toBe('tool_batch');
        expect(cpCalls[0][3]).toBe('before');
        // cancelled 输出不带 checkpoints
        const cancelledOutput = outputs.find(o => (o as { cancelled?: boolean })?.cancelled === true) as Record<string, unknown>;
        expect(cancelledOutput.checkpoints).toBeUndefined();
    });

    test('纯主循环批次（diff 工具不早启动）：before 在主循环前创建、after 在完成后创建', async () => {
        const applyTool = makeTool('apply_diff');
        async function* stream() {
            yield { delta: [{ text: 'hello' }] };
            yield { delta: [{ functionCall: { id: 'call_1', name: 'apply_diff', args: { path: 'a.ts' } } }] };
            yield { delta: [{ functionCall: { id: 'call_2', name: 'apply_diff', args: { path: 'b.ts' } } }] };
            yield { delta: [], done: true };
        }
        const channelManager = { generate: jest.fn().mockReturnValue(stream()) };
        const { service, checkpointService } = createToolLoopHarness(channelManager, {
            getTool: () => applyTool
        });
        seedCheckpointRecords(checkpointService);

        const outputs = await collectOutputs(service, {});

        // 2 个 apply_diff 均不早启动（diff 审阅工具）→ 全走主循环；主循环 skip 内部检查点
        expect(checkpointService.createToolExecutionCheckpoint).toHaveBeenCalledTimes(2);
        const cpCalls = (checkpointService.createToolExecutionCheckpoint as jest.Mock).mock.calls;
        expect(cpCalls[0][2]).toBe('tool_batch');
        expect(cpCalls[0][3]).toBe('before');
        expect(cpCalls[1][2]).toBe('tool_batch');
        expect(cpCalls[1][3]).toBe('after');
        // before/after 挂同一索引（模型消息索引；harness getHistoryRef 返回 [] → 主循环索引为 -1）
        expect(cpCalls[0][1]).toBe(cpCalls[1][1]);

        // 最终下发 [before, after]
        const toolIterationOutputs = outputs.filter(o => (o as { toolIteration?: boolean }).toolIteration === true);
        expect(toolIterationOutputs.length).toBeGreaterThanOrEqual(1);
        const last = toolIterationOutputs[toolIterationOutputs.length - 1] as {
            checkpoints: Array<{ phase: string; toolName: string }>;
        };
        expect(last.checkpoints).toHaveLength(2);
        expect(last.checkpoints[0].phase).toBe('before');
        expect(last.checkpoints[1].phase).toBe('after');
    });

    test('仅配置 after（未配置 before）的早启动批次：不创建 before，完成后仍创建 after', async () => {
        const writeTool = makeTool('write_file');
        async function* stream() {
            yield { delta: [{ text: 'hello' }] };
            yield { delta: [{ functionCall: { id: 'call_1', name: 'write_file', args: { path: 'a.ts' } } }] };
            yield { delta: [], done: true };
        }
        const channelManager = { generate: jest.fn().mockReturnValue(stream()) };
        const { service, checkpointService } = createToolLoopHarness(channelManager, {
            getTool: () => writeTool
        });
        seedCheckpointRecords(checkpointService);
        // 用户只勾选了 write_file 的「执行后」（after），未勾选「执行前」（before）
        (checkpointService.isToolConfiguredForCheckpoint as jest.Mock).mockImplementation(
            (name: string, _args: unknown, phase?: 'before' | 'after') =>
                name === 'write_file' && phase === 'after'
        );

        const outputs = await collectOutputs(service, {});

        // 只创建一次 after（tool_batch）；before 不应创建（此前旧实现会因并集判定而误建）
        expect(checkpointService.createToolExecutionCheckpoint).toHaveBeenCalledTimes(1);
        const cpCalls = (checkpointService.createToolExecutionCheckpoint as jest.Mock).mock.calls;
        expect(cpCalls[0][2]).toBe('tool_batch');
        expect(cpCalls[0][3]).toBe('after');

        // 下发 [after]
        const toolIterationOutputs = outputs.filter(o => (o as { toolIteration?: boolean }).toolIteration === true);
        const last = toolIterationOutputs[toolIterationOutputs.length - 1] as {
            checkpoints: Array<{ phase: string; toolName: string }>;
        };
        expect(last.checkpoints).toHaveLength(1);
        expect(last.checkpoints[0].phase).toBe('after');
        expect(last.checkpoints[0].toolName).toBe('tool_batch');
    });
});
