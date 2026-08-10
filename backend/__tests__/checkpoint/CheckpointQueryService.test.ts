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
import { makeRecord } from '../__fixtures__/checkpointFixtures';

/**
 * CheckpointQueryService 测试
 *
 * 覆盖：
 * - CP-TYPE-1：getCheckpointRecords 走类型化 getCustomMetadata（无 as any 回退）
 * - CP-QUERY-2：getCheckpoints 区分「无记录」与「读取失败」（失败返回 error 标记）
 * - CP-QUERY-1：getAllConversationsWithCheckpoints 有界并发 + 轻量元数据读取
 */

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

    test('CP-PATH-1: pruneMissingBackupCheckpointRecords 拒绝裁剪越界 backupDir 的记录（保留 + 告警，与删除路径同口径）', async () => {
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

            // R3：越界记录与删除路径（CP-DEL-1）同口径——拒绝裁剪、保留 + 告警，
            // 绝不把未校验目录名交给路径扫描；缺备份目录的合法记录才被裁剪
            expect(result.prunedCount).toBe(0);
            expect(result.missingBackupDirs).toEqual([]);
            expect(result.checkpoints.map(c => c.id)).toEqual(['cp-ok', 'cp-evil']);
            expect(stored.map(c => c.id)).toEqual(['cp-ok', 'cp-evil']);
            // 外部目录未被触碰
            await expect(fs.readFile(path.join(victimDir, 'secret.txt'), 'utf-8')).resolves.toBe('secret');
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


describe('CheckpointQueryService.removeOrphanBackupDirs（CP-ORPHAN）', () => {
    /** 构造指向独立临时目录的 service（harness 的固定目录不适合写磁盘） */
    async function createDirHarness(): Promise<{
        service: CheckpointQueryService;
        manager: { getCustomMetadata: jest.Mock; listConversations: jest.Mock };
        root: string;
    }> {
        const manager = {
            getCustomMetadata: jest.fn(),
            getMetadataLight: jest.fn(),
            listConversations: jest.fn().mockResolvedValue(['conv-1', 'conv-2']),
            updateCustomMetadata: jest.fn()
        };
        const manifestRepository = { loadManifest: jest.fn(), clearCache: jest.fn() };
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-cp-orphan-'));
        const service = new CheckpointQueryService(
            manager as unknown as ConversationManager,
            root,
            manifestRepository as unknown as CheckpointManifestRepository,
            () => 'title'
        );
        return { service, manager, root };
    }

    test('跨对话汇总：其它对话引用的存档目录不当作孤儿删除（回归：跨对话误删）', async () => {
        const { service, manager, root } = await createDirHarness();
        try {
            // conv-1 的当前记录引用 cp_1；conv-2 的汇总记录引用 cp_2
            const currentRecords = [makeRecord({ id: 'cp-1', backupDir: 'cp_1' })];
            manager.getCustomMetadata.mockImplementation(async (conversationId: string) => {
                if (conversationId === 'conv-2') {
                    return [makeRecord({ id: 'cp-2', backupDir: 'cp_2', conversationId: 'conv-2' })];
                }
                return null;
            });
            for (const name of ['cp_1', 'cp_2', 'cp_3']) {
                await fs.mkdir(path.join(root, name));
            }
            // cp_3 无引用、无 manifest：回拨 mtime 成超龄真孤儿，确保守卫放行
            const old = new Date(Date.now() - 10 * 60 * 1000);
            await fs.utimes(path.join(root, 'cp_3'), old, old);

            await service.removeOrphanBackupDirs(currentRecords);

            // cp_1（当前对话记录）、cp_2（其它对话记录）都保留；cp_3 无引用被清理
            for (const name of ['cp_1', 'cp_2']) {
                const stat = await fs.stat(path.join(root, name)).catch(() => null);
                expect(stat?.isDirectory()).toBe(true);
            }
            await expect(fs.access(path.join(root, 'cp_3'))).rejects.toThrow();
            // 两个对话的元数据都被枚举（汇总口径）
            expect(manager.getCustomMetadata).toHaveBeenCalledWith('conv-1', 'checkpoints');
            expect(manager.getCustomMetadata).toHaveBeenCalledWith('conv-2', 'checkpoints');
        } finally {
            await fs.rm(root, { recursive: true, force: true });
        }
    });

    test('manifest 守卫（fail-closed）：含 manifest.json 的目录绝不删除，即使记录枚举失败', async () => {
        const { service, manager, root } = await createDirHarness();
        try {
            const currentRecords = [makeRecord({ id: 'cp-1', backupDir: 'cp_1' })];
            // 枚举对话 2 元数据失败 → fail-closed：本次清理整体中止
            manager.getCustomMetadata.mockImplementation(async (conversationId: string) => {
                if (conversationId === 'conv-2') {
                    throw new Error('metadata corrupted');
                }
                return null;
            });
            for (const name of ['cp_1', 'cp_2']) {
                await fs.mkdir(path.join(root, name));
            }
            await fs.writeFile(path.join(root, 'cp_2', 'manifest.json'), '{}');

            await service.removeOrphanBackupDirs(currentRecords);

            // 枚举失败 → 整体中止，cp_2（即使无记录可引）也保留
            const stat = await fs.stat(path.join(root, 'cp_2')).catch(() => null);
            expect(stat?.isDirectory()).toBe(true);
        } finally {
            await fs.rm(root, { recursive: true, force: true });
        }
    });

    test('mtime 新鲜度守卫：无 manifest 但新建的目录跳过（创建中窗口），超龄无 manifest 才删', async () => {
        const { service, manager, root } = await createDirHarness();
        try {
            const currentRecords = [makeRecord({ id: 'cp-1', backupDir: 'cp_1' })];
            manager.getCustomMetadata.mockResolvedValue(null);
            for (const name of ['cp_1', 'cp_fresh', 'cp_old']) {
                await fs.mkdir(path.join(root, name));
            }
            // cp_fresh 保持新建 mtime；cp_old 回拨到 10 分钟前（超过 5 分钟阈值）
            const old = new Date(Date.now() - 10 * 60 * 1000);
            await fs.utimes(path.join(root, 'cp_old'), old, old);

            await service.removeOrphanBackupDirs(currentRecords);

            const fresh = await fs.stat(path.join(root, 'cp_fresh')).catch(() => null);
            expect(fresh?.isDirectory()).toBe(true);
            await expect(fs.access(path.join(root, 'cp_old'))).rejects.toThrow();
        } finally {
            await fs.rm(root, { recursive: true, force: true });
        }
    });
});