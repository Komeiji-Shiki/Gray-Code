/**
 * CPF-07（非流式）：ToolIterationLoopService.runNonStreamLoop 批次检查点测试。
 *
 * 与流式路径对齐：非流式工具批次检查点提升为「回合级 before + 迭代级 after」——
 * - before：同一真实用户回合内只创建一次（挂首个创建迭代的模型消息索引），
 *   后续迭代（含 isNewTurn=false 续跑）不再创建——消除「迭代 N 批次后存档紧挨
 *   迭代 N+1 批次前存档」的冗余展示；
 * - after：每次迭代工具执行完成后创建（挂本迭代模型消息索引，按 afterTools 判定）；
 * - 执行核心以 checkpointMode='skip' 调用（此前为工具级 auto 存档，每个工具一对）。
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

/** 让 checkpointService 返回带 id 的存档记录（before/after 各一），供挂载索引断言 */
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

describe('runNonStreamLoop 批次检查点（回合级 before + 迭代级 after）', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('同一回合两次工具迭代：只建一次 before（回合级），每次迭代各自 after，执行带 skip', async () => {
        const cmdTool = makeTool('execute_command');
        // 模拟真实仓储：getHistoryRef 读可变历史；addContent 增长历史
        // （迭代 1 模型消息 @0 → 迭代 1 FR @1 → 迭代 2 模型消息 @2）
        const history: Array<{ role: string; parts: unknown[]; isFunctionResponse?: boolean }> = [];
        const channelManager = {
            // 迭代 1：工具调用；迭代 2：工具调用；迭代 3：纯文本收尾
            generate: jest.fn()
                .mockResolvedValueOnce({ content: { role: 'model', parts: [{ functionCall: { id: 'call_1', name: 'execute_command', args: { command: 'a' } } }] } })
                .mockResolvedValueOnce({ content: { role: 'model', parts: [{ functionCall: { id: 'call_2', name: 'execute_command', args: { command: 'b' } } }] } })
                .mockResolvedValueOnce({ content: { role: 'model', parts: [{ text: 'final' }] } })
        };
        const { service, conversationManager, checkpointService, toolExecutionService } = createToolLoopHarness(channelManager, {
            getTool: () => cmdTool
        });
        // 覆盖 harness 默认的恒空历史：让模型消息/FR 落盘增长历史（跨迭代挂载索引断言依赖）
        (conversationManager.getHistoryRef as jest.Mock).mockImplementation(async () => history);
        (conversationManager.addContent as jest.Mock).mockImplementation(
            async (_cid: string, content: { role: string; parts: unknown[] }) => {
                history.push(content as never);
                return content;
            }
        );
        (conversationManager.settleFunctionResponses as jest.Mock).mockImplementation(
            async (_cid: string, parts: unknown[]) => {
                history.push({ role: 'user', parts, isFunctionResponse: true } as never);
            }
        );
        seedCheckpointRecords(checkpointService);
        const execSpy = jest.spyOn(toolExecutionService, 'executeFunctionCallsWithResults');

        const result = await service.runNonStreamLoop('conv-ns-cpf7', 'cfg-1', config, 5);

        expect(result.exceededMaxIterations).toBe(false);

        // 执行核心以 checkpointMode='skip' 调用（第 15 个参数）——不再各自创建工具级存档
        expect(execSpy).toHaveBeenCalledTimes(2);
        for (const call of execSpy.mock.calls) {
            expect(call[14]).toBe('skip');
        }

        // 存档创建：before × 1 + after × 2 = 3 次（迭代 2 不再创建 before）
        expect(checkpointService.createToolExecutionCheckpoint).toHaveBeenCalledTimes(3);
        const cpCalls = (checkpointService.createToolExecutionCheckpoint as jest.Mock).mock.calls;
        expect(cpCalls[0][2]).toBe('tool_batch');
        expect(cpCalls[0][3]).toBe('before');
        expect(cpCalls[1][3]).toBe('after');
        expect(cpCalls[2][3]).toBe('after');
        // 挂载索引：before 与迭代 1 的 after 同索引（迭代 1 模型消息 @0）；
        // 迭代 2 的 after 用迭代 2 的模型消息索引（@2）——不被回合级 before 索引污染
        expect(cpCalls[0][1]).toBe(cpCalls[1][1]);
        expect(cpCalls[0][1]).toBe(0);
        expect(cpCalls[2][1]).toBe(2);
        // 批内工具名透传（batchToolNames）
        for (const call of cpCalls) {
            expect(call[5].batchToolNames).toEqual(['execute_command']);
        }
    });
});
