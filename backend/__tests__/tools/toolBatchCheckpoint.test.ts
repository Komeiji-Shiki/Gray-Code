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
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ToolExecutionService } from '../../modules/api/chat/services/ToolExecutionService';
import type { CheckpointService } from '../../modules/api/chat/services/CheckpointService';
import type { FunctionCallInfo } from '../../modules/api/chat/utils';
import { setGlobalSettingsManager } from '../../core/settingsContext';
import { SettingsManager, MemorySettingsStorage } from '../../modules/settings';
import type { CheckpointRecord } from '../../modules/checkpoint';
import { ConversationManager } from '../../modules/conversation/ConversationManager';
import { MemoryStorageAdapter } from '../../modules/conversation/storage';
import { BranchService, setGlobalBranchService } from '../../modules/conversation/branch/BranchService';
import { BranchGraphRepository } from '../../modules/conversation/branch/BranchGraphRepository';
import type { ConversationBranchNode } from '../../modules/conversation/branch/types';

function makeCall(name: string, args: Record<string, unknown> = {}): FunctionCallInfo {
    return { id: `call-${name}-${Math.random()}`, name, args } as FunctionCallInfo;
}

interface TestEnv {
    service: ToolExecutionService;
    checkpointService: { createToolExecutionCheckpoint: jest.Mock };
    calls: { before: Array<[string, number, string, 'before']>; after: Array<[string, number, string, 'after']> };
    conversationManager?: { getMessageNodeIdAt: jest.Mock };
}

async function createEnv(configuredTools: string[], conversationManager?: { getMessageNodeIdAt: jest.Mock }): Promise<TestEnv> {
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

    const service = new ToolExecutionService(
        undefined,
        undefined,
        settingsManager as any,
        checkpointService,
        conversationManager as any
    );
    return { service, checkpointService: checkpointService as unknown as { createToolExecutionCheckpoint: jest.Mock }, calls, conversationManager };
}

/** 驱动执行到完成（工具会因无 toolRegistry 返回 tool not found，不影响检查点断言） */
async function run(service: ToolExecutionService, calls: FunctionCallInfo[], conversationId = 'conv-cpf5'): Promise<void> {
    const generator = service.executeFunctionCallsWithProgress(
        calls,
        conversationId,
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

    // ==================== BCP-01：before/after 存档点透传 messageNodeId ====================

    it('BCP-01：注入 conversationManager 时，before/after 存档调用携带由索引反查的 nodeId', async () => {
        const conversationManager = {
            getMessageNodeIdAt: jest.fn().mockResolvedValue('node-batch')
        };
        const env = await createEnv(['write_file'], conversationManager);
        await run(env.service, [makeCall('read_file', { path: 'a.ts' }), makeCall('write_file', { path: 'a.ts', content: 'x' })]);

        expect(env.checkpointService.createToolExecutionCheckpoint).toHaveBeenCalledTimes(2);
        // 反查按消息索引（工具执行所在模型消息）；
        // before/after 两个存档点复用同一次反查（同一 (conversationId, messageIndex)），
        // 避免每批次两次全量重读 transcript 文件
        expect(conversationManager.getMessageNodeIdAt).toHaveBeenCalledWith('conv-cpf5', 0);
        expect(conversationManager.getMessageNodeIdAt).toHaveBeenCalledTimes(1);

        const beforeCall = env.checkpointService.createToolExecutionCheckpoint.mock.calls[0];
        const afterCall = env.checkpointService.createToolExecutionCheckpoint.mock.calls[1];
        // 第 5 个位置参数 = messageNodeId
        expect(beforeCall[4]).toBe('node-batch');
        expect(afterCall[4]).toBe('node-batch');
    });

    it('BCP-01：未注入 conversationManager 时，nodeId 参数为 undefined（CheckpointService 兜底反查，兼容旧调用）', async () => {
        const env = await createEnv(['write_file']);
        await run(env.service, [makeCall('write_file', { path: 'a.ts', content: 'x' })]);

        expect(env.checkpointService.createToolExecutionCheckpoint).toHaveBeenCalledTimes(2);
        const beforeCall = env.checkpointService.createToolExecutionCheckpoint.mock.calls[0];
        const afterCall = env.checkpointService.createToolExecutionCheckpoint.mock.calls[1];
        expect(beforeCall[4]).toBeUndefined();
        expect(afterCall[4]).toBeUndefined();
    });
});

// ==================== BCP-02：工具执行存档后绑定工作区存档到分支节点 ====================

describe('BCP-02 工具执行存档绑定（fire-and-forget）', () => {
    let tempDir: string;
    let repo: BranchGraphRepository;
    let manager: ConversationManager;
    let branchService: BranchService;

    beforeEach(async () => {
        tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bcp02-tool-'));
        repo = new BranchGraphRepository(tempDir);
        manager = new ConversationManager(new MemoryStorageAdapter());
        branchService = new BranchService(manager, repo);
        setGlobalBranchService(branchService);
    });

    afterEach(async () => {
        setGlobalBranchService(undefined);
        await fsp.rm(tempDir, { recursive: true, force: true });
    });

    /** 建会话 + 建图，返回 [userNodeId, modelNodeId, candidateNodeId] */
    async function seedGraph(conversationId: string): Promise<string[]> {
        await manager.createConversation(conversationId, 'T');
        await manager.addBatch(conversationId, [
            { role: 'user', parts: [{ text: 'q1' }], timestamp: 100 },
            { role: 'model', parts: [{ text: 'a1' }], timestamp: 200 },
        ]);
        const ids = (await manager.getMessagesRaw(conversationId)).map(m => m.id!);
        const candidate = await branchService.createRerollCandidate(conversationId, ids[1], { parts: [{ text: 'a2' }] });
        return [ids[0], ids[1], candidate.nodeId];
    }

    /** checkpointService mock：返回带 id 的存档记录（供绑定使用） */
    async function createToolEnv(configuredTools: string[]): Promise<{
        service: ToolExecutionService;
        checkpointService: { createToolExecutionCheckpoint: jest.Mock };
    }> {
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

        let seq = 0;
        const checkpointService = {
            createToolExecutionCheckpoint: jest.fn().mockImplementation(
                async (_conversationId: string, _messageIndex: number, _toolName: string, phase: 'before' | 'after') => ({
                    id: `cp-${phase}-${++seq}`,
                    conversationId: _conversationId,
                    messageIndex: _messageIndex,
                    toolName: _toolName,
                    phase,
                    timestamp: Date.now(),
                    backupDir: 'backup',
                    fileCount: 0,
                    contentHash: 'h',
                } as CheckpointRecord)
            )
        } as unknown as CheckpointService;

        const service = new ToolExecutionService(
            undefined,
            undefined,
            settingsManager as any,
            checkpointService,
            manager as any
        );
        return {
            service,
            checkpointService: checkpointService as unknown as { createToolExecutionCheckpoint: jest.Mock }
        };
    }

    /** 轮询等待 fire-and-forget 绑定落盘（最多 timeoutMs）。expectedId 存在时等最终值（before/after 两次绑定覆盖同一节点） */
    async function waitForBoundNode(conversationId: string, nodeId: string, expectedId?: string, timeoutMs = 3000): Promise<ConversationBranchNode> {
        const deadline = Date.now() + timeoutMs;
        let last: ConversationBranchNode | undefined;
        while (Date.now() < deadline) {
            const node = (await branchService.getBranchGraph(conversationId)).graph?.nodes[nodeId];
            last = node;
            if (node?.workspaceCheckpointId && (!expectedId || node.workspaceCheckpointId === expectedId)) {
                return node;
            }
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        throw new Error(`node ${nodeId} was not bound to ${expectedId ?? 'any id'} within ${timeoutMs}ms; last=${JSON.stringify(last)}`);
    }

    it('写工具执行 before/after 存档后，节点绑定最新（after）存档 id 且 state=checkpointed', async () => {
        const [userNodeId] = await seedGraph('conv-bcp2');
        const env = await createToolEnv(['write_file']);

        // 工具执行在消息索引 0（user 消息）→ 反查到 user 节点
        await run(env.service, [makeCall('write_file', { path: 'a.ts', content: 'x' })], 'conv-bcp2');

        const node = await waitForBoundNode('conv-bcp2', userNodeId, 'cp-after-2');
        // before 先绑 cp-before-1，after 覆盖为 cp-after-2（最新存档为准）
        expect(node.workspaceCheckpointId).toBe('cp-after-2');
        expect(node.workspaceState).toBe('checkpointed');
        expect(env.checkpointService.createToolExecutionCheckpoint).toHaveBeenCalledTimes(2);
    });

    it('绑定失败（reject）不阻塞工具执行：工具循环正常完成、存档照常创建', async () => {
        const [userNodeId] = await seedGraph('conv-bcp2');
        // 用会 reject 的假 BranchService 替换全局实例（绑定失败仅 warn）
        const rejectingService = {
            bindWorkspaceCheckpoint: jest.fn().mockRejectedValue(new Error('bind boom'))
        } as unknown as BranchService;
        setGlobalBranchService(rejectingService);

        const env = await createToolEnv(['write_file']);
        await expect(
            run(env.service, [makeCall('write_file', { path: 'a.ts', content: 'x' })], 'conv-bcp2')
        ).resolves.toBeUndefined();

        expect(env.checkpointService.createToolExecutionCheckpoint).toHaveBeenCalledTimes(2);
        expect(rejectingService.bindWorkspaceCheckpoint).toHaveBeenCalledWith('conv-bcp2', userNodeId, 'cp-before-1');
    });

    it('绑定挂起（永不 resolve）也不阻塞工具循环（fire-and-forget 语义）', async () => {
        await seedGraph('conv-bcp2');
        const hangingService = {
            bindWorkspaceCheckpoint: jest.fn().mockReturnValue(new Promise(() => {}))
        } as unknown as BranchService;
        setGlobalBranchService(hangingService);

        const env = await createToolEnv(['write_file']);
        // 若绑定被 await，此处将永远无法完成（jest 超时报错）
        await expect(
            run(env.service, [makeCall('write_file', { path: 'a.ts', content: 'x' })], 'conv-bcp2')
        ).resolves.toBeUndefined();

        expect(env.checkpointService.createToolExecutionCheckpoint).toHaveBeenCalledTimes(2);
        expect(hangingService.bindWorkspaceCheckpoint).toHaveBeenCalledTimes(2);
    });

    it('未注册 BranchService（getGlobalBranchService undefined）时绑定跳过，工具循环正常', async () => {
        await seedGraph('conv-bcp2');
        setGlobalBranchService(undefined);

        const env = await createToolEnv(['write_file']);
        await expect(
            run(env.service, [makeCall('write_file', { path: 'a.ts', content: 'x' })], 'conv-bcp2')
        ).resolves.toBeUndefined();
        expect(env.checkpointService.createToolExecutionCheckpoint).toHaveBeenCalledTimes(2);
    });

    it('纯只读批次不创建存档 → 不触发绑定', async () => {
        const [userNodeId] = await seedGraph('conv-bcp2');
        const env = await createToolEnv(['write_file']);
        // 多调用只读批次（read_file + search_in_files(search)）→ CPF-05 不创建存档
        await run(env.service, [makeCall('read_file', { path: 'a.ts' }), makeCall('search_in_files', { query: 'x' })], 'conv-bcp2');

        expect(env.checkpointService.createToolExecutionCheckpoint).not.toHaveBeenCalled();
        const node = (await branchService.getBranchGraph('conv-bcp2')).graph!.nodes[userNodeId]!;
        expect(node.workspaceCheckpointId).toBeUndefined();
    });
});
