import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
    CheckpointQueryService,
    type CheckpointQueryResult
} from '../../modules/checkpoint/CheckpointQueryService';
import type { ConversationManager } from '../../modules/conversation/ConversationManager';
import type { CheckpointManifestRepository } from '../../modules/checkpoint/CheckpointManifestRepository';
import type { CheckpointRecord } from '../../modules/checkpoint/CheckpointManager';

/**
 * CheckpointQueryService 测试
 *
 * 覆盖：
 * - CP-TYPE-1：getCheckpointRecords 走类型化 getCustomMetadata（无 as any 回退）
 * - CP-QUERY-2：getCheckpoints 区分「无记录」与「读取失败」（失败返回 error 标记）
 * - CP-QUERY-1：getAllConversationsWithCheckpoints 有界并发 + 轻量元数据读取
 */

function makeRecord(partial: Partial<CheckpointRecord> & { id: string }): CheckpointRecord {
    return {
        conversationId: 'conv-1',
        messageIndex: 0,
        toolName: 'test',
        phase: 'before',
        timestamp: 1000,
        backupDir: 'cp_x',
        fileCount: 1,
        contentHash: 'abc',
        excludedCount: 2,
        manifestVersion: 2,
        ...partial
    };
}

function createHarness(): {
    service: CheckpointQueryService;
    manager: {
        getCustomMetadata: jest.Mock;
        getMetadataLight: jest.Mock;
        listConversations: jest.Mock;
        updateCustomMetadata: jest.Mock;
    };
} {
    const manager = {
        getCustomMetadata: jest.fn(),
        getMetadataLight: jest.fn(),
        listConversations: jest.fn(),
        updateCustomMetadata: jest.fn()
    };
    const manifestRepository = {
        loadManifest: jest.fn(),
        clearCache: jest.fn()
    };
    const service = new CheckpointQueryService(
        manager as unknown as ConversationManager,
        path.join(os.tmpdir(), 'limcode-cp-query-test'),
        manifestRepository as unknown as CheckpointManifestRepository,
        (conversationId: string) => `Chat ${conversationId}`
    );
    return { service, manager };
}

describe('CheckpointQueryService', () => {
    test('CP-TYPE-1: getCheckpointRecords reads records through typed getCustomMetadata', async () => {
        const { service, manager } = createHarness();

        const records = [makeRecord({ id: 'cp-1' }), makeRecord({ id: 'cp-2' })];
        manager.getCustomMetadata.mockResolvedValue(records);
        await expect(service.getCheckpointRecords('conv-1')).resolves.toEqual(records);
        expect(manager.getCustomMetadata).toHaveBeenCalledWith('conv-1', 'checkpoints');

        // 非数组（无记录 / 元数据缺字段）→ 空数组
        manager.getCustomMetadata.mockResolvedValue(undefined);
        await expect(service.getCheckpointRecords('conv-1')).resolves.toEqual([]);
        manager.getCustomMetadata.mockResolvedValue({ not: 'an array' });
        await expect(service.getCheckpointRecords('conv-1')).resolves.toEqual([]);
    });

    test('CP-QUERY-2: no records returns empty array without error marker', async () => {
        const { service, manager } = createHarness();
        manager.getCustomMetadata.mockResolvedValue(undefined);

        const result = await service.getCheckpoints('conv-1');
        expect(result).toEqual([]);
        expect((result as CheckpointQueryResult).error).toBeUndefined();
    });

    test('CP-QUERY-2: read failure returns empty array with error marker (not "no checkpoints")', async () => {
        const { service, manager } = createHarness();
        manager.getCustomMetadata.mockRejectedValue(new Error('metadata corrupt'));

        const result = await service.getCheckpoints('conv-1');
        // 仍是数组（现有调用方兼容），但携带 error 标记与「无记录」区分
        expect(result).toEqual([]);
        expect(result.length).toBe(0);
        expect((result as CheckpointQueryResult).error).toContain('metadata corrupt');
    });

    test('CP-QUERY-2: getCheckpoints maps records to summaries and keeps array usability', async () => {
        const { service, manager } = createHarness();
        manager.getCustomMetadata.mockResolvedValue([
            makeRecord({ id: 'cp-1', backupBytes: 10, excludedCount: 3 }),
            makeRecord({ id: 'cp-2', backupBytes: 20, excludedCount: 1 })
        ]);

        const result = await service.getCheckpoints('conv-1');
        expect(result.map(c => c.id)).toEqual(['cp-1', 'cp-2']);
        expect(result[0].backupBytes).toBe(10);
        expect(result[0].excludedCount).toBe(3);
        expect(result).toHaveLength(2);
        expect((result as CheckpointQueryResult).error).toBeUndefined();
    });

    test('CP-QUERY-1: aggregates conversation stats with lightweight parallel metadata reads', async () => {
        const { service, manager } = createHarness();
        manager.listConversations.mockResolvedValue(['c1', 'c2', 'c3', 'c4']);
        manager.getMetadataLight.mockImplementation(async (conversationId: string) => {
            if (conversationId === 'c1') {
                return {
                    id: 'c1',
                    title: 'Conv One',
                    createdAt: 100,
                    updatedAt: 300,
                    custom: {
                        checkpoints: [
                            makeRecord({ id: 'cp-1', backupBytes: 10 }),
                            makeRecord({ id: 'cp-2' }) // 缺 backupBytes → sizeIncomplete
                        ]
                    }
                };
            }
            if (conversationId === 'c2') {
                return {
                    id: 'c2',
                    title: 'Conv Two',
                    createdAt: 200,
                    updatedAt: 500,
                    custom: { checkpoints: [makeRecord({ id: 'cp-3', backupBytes: 7 })] }
                };
            }
            if (conversationId === 'c3') {
                return { id: 'c3', title: 'Empty', createdAt: 50, updatedAt: 60, custom: { checkpoints: [] } };
            }
            return null; // c4 无元数据
        });

        const results = await service.getAllConversationsWithCheckpoints();
        expect(results).toHaveLength(2);
        // 按 updatedAt 降序：c2 (500) 在前
        expect(results[0]).toMatchObject({
            conversationId: 'c2',
            title: 'Conv Two',
            checkpointCount: 1,
            totalSize: 7,
            updatedAt: 500
        });
        // c1 含缺 backupBytes 的旧存档 → sizeIncomplete
        expect(results[1]).toMatchObject({
            conversationId: 'c1',
            title: 'Conv One',
            checkpointCount: 2,
            totalSize: 10,
            sizeIncomplete: true
        });
        // 无存档对话（c3）与无元数据对话（c4）不出现
        expect(results.some(r => r.conversationId === 'c3')).toBe(false);
        expect(results.some(r => r.conversationId === 'c4')).toBe(false);
        // 使用轻量读接口，不再逐对话 getMetadata
        expect(manager.getMetadataLight).toHaveBeenCalledWith('c1');
        expect(manager.getMetadataLight).toHaveBeenCalledTimes(4);
    });

    test('CP-QUERY-1: metadata reads are bounded (never exceed DEFAULT_CHECKPOINT_CONCURRENCY)', async () => {
        const { service, manager } = createHarness();
        const ids = Array.from({ length: 40 }, (_, i) => `conv-${i}`);
        manager.listConversations.mockResolvedValue(ids);

        let active = 0;
        let maxActive = 0;
        manager.getMetadataLight.mockImplementation(async () => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            await new Promise(resolve => setTimeout(resolve, 5));
            active -= 1;
            return null; // 全部无元数据 → 结果为空
        });

        const results = await service.getAllConversationsWithCheckpoints();
        expect(results).toEqual([]);
        expect(maxActive).toBeGreaterThan(1); // 确实并发读取
        expect(maxActive).toBeLessThanOrEqual(8); // DEFAULT_CHECKPOINT_CONCURRENCY 有界
        expect(manager.getMetadataLight).toHaveBeenCalledTimes(40);
    });

    test('CP-PATH-1: getCheckpoints(withSize) 拒绝扫描越界 backupDir（记录保留、大小按 0、不写回）', async () => {
        const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-cp-query-path-'));
        try {
            const checkpointsDir = path.join(storageRoot, 'checkpoints');
            await fs.mkdir(checkpointsDir, { recursive: true });
            // 存档目录外的“受害者”目录：若扫描发生将统计到 secret.txt 的大小
            const victimDir = path.join(storageRoot, 'victim');
            await fs.mkdir(victimDir, { recursive: true });
            await fs.writeFile(path.join(victimDir, 'secret.txt'), 'secret-data', 'utf-8');

            const manager = {
                getCustomMetadata: jest.fn().mockResolvedValue([
                    // 无 backupBytes → 触发懒扫描；backupDir 含 ../ 越界
                    makeRecord({ id: 'cp-1', backupDir: `..${path.sep}victim` })
                ]),
                updateCustomMetadata: jest.fn()
            };
            const manifestRepository = { loadManifest: jest.fn(), clearCache: jest.fn() };
            const service = new CheckpointQueryService(
                manager as unknown as ConversationManager,
                checkpointsDir,
                manifestRepository as unknown as CheckpointManifestRepository,
                (conversationId: string) => `Chat ${conversationId}`
            );

            const result = await service.getCheckpoints('conv-1', { withSize: true });

            // 记录保留（与删除路径“拒绝但保留记录”一致），但绝不扫描越界目录：大小按 0 计
            expect(result).toHaveLength(1);
            expect(result[0].id).toBe('cp-1');
            expect(result[0].backupBytes).toBe(0);
            expect(result[0].size).toBe(0);
            // 不写回摘要缓存（越界目录不存在可写回的合法大小）
            expect(manager.updateCustomMetadata).not.toHaveBeenCalled();
        } finally {
            await fs.rm(storageRoot, { recursive: true, force: true });
        }
    });

    test('CP-PATH-1: backupDirectoryExists 对越界目录名返回 false（即使外部目录真实存在）', async () => {
        const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-cp-query-path-'));
        try {
            const checkpointsDir = path.join(storageRoot, 'checkpoints');
            await fs.mkdir(checkpointsDir, { recursive: true });
            const victimDir = path.join(storageRoot, 'victim');
            await fs.mkdir(victimDir, { recursive: true });

            const manager = {
                getCustomMetadata: jest.fn(),
                getMetadataLight: jest.fn(),
                listConversations: jest.fn(),
                updateCustomMetadata: jest.fn()
            };
            const manifestRepository = { loadManifest: jest.fn(), clearCache: jest.fn() };
            const service = new CheckpointQueryService(
                manager as unknown as ConversationManager,
                checkpointsDir,
                manifestRepository as unknown as CheckpointManifestRepository,
                (conversationId: string) => `Chat ${conversationId}`
            );

            // 越界目录真实存在也视为不存在（绝不 stat/access 存档目录外路径）
            await expect(service.backupDirectoryExists(`..${path.sep}victim`)).resolves.toBe(false);
            await expect(service.backupDirectoryExists('..')).resolves.toBe(false);
            await expect(service.backupDirectoryExists('cp_ok')).resolves.toBe(false); // 目录不存在
            await fs.mkdir(path.join(checkpointsDir, 'cp_ok'));
            await expect(service.backupDirectoryExists('cp_ok')).resolves.toBe(true); // 合法名正常判定
        } finally {
            await fs.rm(storageRoot, { recursive: true, force: true });
        }
    });

    test('CP-PATH-1: pruneMissingBackupCheckpointRecords 裁剪越界 backupDir 的记录', async () => {
        const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-cp-query-path-'));
        try {
            const checkpointsDir = path.join(storageRoot, 'checkpoints');
            await fs.mkdir(checkpointsDir, { recursive: true });
            await fs.mkdir(path.join(checkpointsDir, 'cp_ok'), { recursive: true });
            const victimDir = path.join(storageRoot, 'victim');
            await fs.mkdir(victimDir, { recursive: true });
            await fs.writeFile(path.join(victimDir, 'secret.txt'), 'secret', 'utf-8');

            let stored: CheckpointRecord[] = [
                makeRecord({ id: 'cp-ok', backupDir: 'cp_ok' }),
                makeRecord({ id: 'cp-evil', messageIndex: 1, backupDir: `..${path.sep}victim` })
            ];
            const manager = {
                getCustomMetadata: jest.fn().mockResolvedValue(stored),
                updateCustomMetadata: jest.fn().mockImplementation(
                    async (_cid: string, _key: string, updater: (current: unknown) => unknown | Promise<unknown>) => {
                        const next = await updater(stored);
                        if (next !== stored) {
                            stored = next as CheckpointRecord[];
                        }
                        return stored;
                    }
                )
            };
            const manifestRepository = { loadManifest: jest.fn(), clearCache: jest.fn() };
            const service = new CheckpointQueryService(
                manager as unknown as ConversationManager,
                checkpointsDir,
                manifestRepository as unknown as CheckpointManifestRepository,
                (conversationId: string) => `Chat ${conversationId}`
            );

            const result = await service.pruneMissingBackupCheckpointRecords('conv-1', stored);

            // 越界记录被裁剪（无法安全恢复），合法记录保留
            expect(result.prunedCount).toBe(1);
            expect(result.checkpoints.map(c => c.id)).toEqual(['cp-ok']);
            expect(stored.map(c => c.id)).toEqual(['cp-ok']);
        } finally {
            await fs.rm(storageRoot, { recursive: true, force: true });
        }
    });
});

    test('BCP-01: summary 透传 messageNodeId；旧存档无该字段时缺省（index 定位兼容）', async () => {
        const { service, manager } = createHarness();
        manager.getCustomMetadata.mockResolvedValue([
            makeRecord({ id: 'cp-new', messageNodeId: 'node-1' }),
            makeRecord({ id: 'cp-old' }) // 旧存档：无 messageNodeId
        ]);

        const result = await service.getCheckpoints('conv-1');
        expect(result[0].messageNodeId).toBe('node-1');
        expect(result[1].messageNodeId).toBeUndefined();
        // 两者都保留 messageIndex（定位语义不回退）
        expect(result[0].messageIndex).toBe(0);
        expect(result[1].messageIndex).toBe(0);
        expect((result as CheckpointQueryResult).error).toBeUndefined();
    });
