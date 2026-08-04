/**
 * CPF-05 测试：只读 tool_batch 不创建存档。
 *
 * 判定基于真实工具名集合（toolNames.some(name => configuredTools.includes(name))），
 * 而不是笼统的「批次存在写工具」或「配置列表非空」。
 *
 * 验收：
 * - read_file + search_in_files(search) → 不创建存档
 * - list_files + find_files → 不创建存档
 * - get_symbols + find_references → 不创建存档
 * - read_file + write_file（write_file 已配置）→ 创建存档（tool_batch）
 * - search_in_files(replace)（已配置）→ 创建存档
 */
import { ToolExecutionService } from '../../modules/api/chat/services/ToolExecutionService';
import type { CheckpointService } from '../../modules/api/chat/services/CheckpointService';
import type { FunctionCallInfo } from '../../modules/api/chat/utils';
import { setGlobalSettingsManager } from '../../core/settingsContext';
import { SettingsManager, MemorySettingsStorage } from '../../modules/settings';
import type { CheckpointRecord } from '../../modules/checkpoint';

function makeCall(name: string, args: Record<string, unknown> = {}): FunctionCallInfo {
    return { id: `call-${name}-${Math.random()}`, name, args } as FunctionCallInfo;
}

interface TestEnv {
    service: ToolExecutionService;
    checkpointService: { createToolExecutionCheckpoint: jest.Mock };
    calls: { before: Array<[string, number, string, 'before']>; after: Array<[string, number, string, 'after']> };
}

async function createEnv(configuredTools: string[]): Promise<TestEnv> {
    const settingsManager = new SettingsManager(new MemorySettingsStorage());
    await settingsManager.initialize();
    setGlobalSettingsManager(settingsManager);
    await settingsManager.updateCheckpointConfig({
        enabled: true,
        beforeTools: configuredTools,
        afterTools: configuredTools,
        messageCheckpoint: { beforeMessages: [], afterMessages: [] },
        maxCheckpoints: -1,
        customIgnorePatterns: []
    });

    const calls: TestEnv['calls'] = { before: [], after: [] };
    const checkpointService = {
        createToolExecutionCheckpoint: jest.fn().mockImplementation(
            async (conversationId: string, messageIndex: number, toolName: string, phase: 'before' | 'after') => {
                if (phase === 'before') calls.before.push([conversationId, messageIndex, toolName, phase]);
                else calls.after.push([conversationId, messageIndex, toolName, phase]);
                return null; // 不真正创建（只断言是否被调用）
            }
        )
    } as unknown as CheckpointService;

    const service = new ToolExecutionService(undefined, undefined, settingsManager as any, checkpointService);
    return { service, checkpointService: checkpointService as unknown as { createToolExecutionCheckpoint: jest.Mock }, calls };
}

/** 驱动执行到完成（工具会因无 toolRegistry 返回 tool not found，不影响检查点断言） */
async function run(service: ToolExecutionService, calls: FunctionCallInfo[]): Promise<void> {
    const generator = service.executeFunctionCallsWithProgress(
        calls,
        'conv-cpf5',
        0,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined
    );
    let next = await generator.next();
    while (!next.done) {
        next = await generator.next();
    }
}

describe('CPF-05 read-only tool_batch skips checkpoint creation', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it.each([
        ['read_file + search_in_files(search)', [makeCall('read_file', { path: 'a.ts' }), makeCall('search_in_files', { query: 'x' })]],
        ['list_files + find_files', [makeCall('list_files', {}), makeCall('find_files', { patterns: ['**/*.ts'] })]],
        ['get_symbols + find_references', [makeCall('get_symbols', { path: 'a.ts' }), makeCall('find_references', { path: 'a.ts', line: 1 })]]
    ])('纯只读批次 %s：不创建存档（即使配置了写工具）', async (_label, calls) => {
        const env = await createEnv(['write_file', 'apply_diff']);
        await run(env.service, calls);
        expect(env.checkpointService.createToolExecutionCheckpoint).not.toHaveBeenCalled();
    });

    it('read_file + write_file（write_file 已配置）：创建 before/after 存档（tool_batch）', async () => {
        const env = await createEnv(['write_file']);
        await run(env.service, [makeCall('read_file', { path: 'a.ts' }), makeCall('write_file', { path: 'a.ts', content: 'x' })]);

        expect(env.checkpointService.createToolExecutionCheckpoint).toHaveBeenCalledTimes(2);
        expect(env.calls.before[0][2]).toBe('tool_batch');
        expect(env.calls.after[0][2]).toBe('tool_batch');
    });

    it('批次含未配置的写工具：不创建存档', async () => {
        // 配置里只有 apply_diff；批内 write_file 未配置
        const env = await createEnv(['apply_diff']);
        await run(env.service, [makeCall('read_file', { path: 'a.ts' }), makeCall('write_file', { path: 'a.ts', content: 'x' })]);
        expect(env.checkpointService.createToolExecutionCheckpoint).not.toHaveBeenCalled();
    });

    it('search_in_files(replace) 单调用（已配置）：创建存档', async () => {
        const env = await createEnv(['search_in_files']);
        await run(env.service, [makeCall('search_in_files', { query: 'old', mode: 'replace', replace: 'new' })]);
        expect(env.checkpointService.createToolExecutionCheckpoint).toHaveBeenCalledTimes(2);
        expect(env.calls.before[0][2]).toBe('search_in_files');
    });

    it('search_in_files(search) 单调用：不创建存档（保持既有语义）', async () => {
        const env = await createEnv(['search_in_files']);
        await run(env.service, [makeCall('search_in_files', { query: 'x' })]);
        expect(env.checkpointService.createToolExecutionCheckpoint).not.toHaveBeenCalled();
    });

    it('批次内 search_in_files(replace)（已配置）：创建存档', async () => {
        const env = await createEnv(['search_in_files']);
        await run(env.service, [makeCall('read_file', { path: 'a.ts' }), makeCall('search_in_files', { query: 'old', mode: 'replace', replace: 'new' })]);
        expect(env.checkpointService.createToolExecutionCheckpoint).toHaveBeenCalledTimes(2);
        expect(env.calls.before[0][2]).toBe('tool_batch');
    });
});
