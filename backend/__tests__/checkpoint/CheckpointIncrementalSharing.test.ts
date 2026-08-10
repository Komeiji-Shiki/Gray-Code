/**
 * BCP-07 验证测试：分支存档共享不可变内容（决策 12 固化——不做内容哈希去重）。
 *
 * 关联规划：checkpoint-history-branch-architecture.plan.md 第七阶段 BCP-07（L123）+ 决策 12（L2034）；
 * 研究依据：.graycode/research/bcp-phase-research.md §6（增量链文件级天然共享）+ §7.2 场景 22。
 *
 * 本文件验证两条核心结论（纯 checkpoint 域，不依赖 BCP-03/04/05/06 落地）：
 * 1. 增量链文件级共享：同一对话连续创建多个存档（修改少量文件）时，
 *    未变文件在后续存档中不重复存储 —— 通过 backupDir 布局 + manifest.changes 断言；
 * 2. 恢复按增量链引用 base：restore 时未变文件从 base 的备份目录恢复，
 *    不要求每个存档都有完整副本 —— 通过 restoreCheckpoint 集成断言（含多跳链）。
 * 3. 决策 12 语义固化：同内容重复创建 → 记录重复（内容哈希不同 id）但备份文件零重复；
 *    内容哈希去重不做（会改变存档列表语义），存档列表按创建次数增长、磁盘按增量链共享。
 */

import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import '../__fixtures__/diffManagerMock';
import { createTempDirectory } from '../__fixtures__/checkpointFixtures';

import { CheckpointManager, type CheckpointRecord } from '../../modules/checkpoint/CheckpointManager';
import type { CheckpointManifest } from '../../modules/checkpoint/types';

async function writeFile(rootDir: string, relativePath: string, content: string = ''): Promise<void> {
    const fullPath = path.join(rootDir, relativePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content, 'utf-8');
}

async function pathExists(targetPath: string): Promise<boolean> {
    try {
        await fs.access(targetPath);
        return true;
    } catch {
        return false;
    }
}

/** 与 CheckpointManager 一致的 md5 内容哈希 */
function md5(content: string): string {
    return crypto.createHash('md5').update(content).digest('hex');
}

interface Harness {
    manager: CheckpointManager;
    storageRoot: string;
    /** 元数据中的存档记录 */
    storedCheckpoints: () => CheckpointRecord[];
    readManifest: (checkpointId: string) => Promise<CheckpointManifest | null>;
}

/** 与 CheckpointManifestPhase3.test.ts 同构的 harness（单根工作区 + mock 元数据） */
async function createHarness(workspaceRoot: string, storageRoot: string): Promise<Harness> {
    (vscode.workspace as any).workspaceFolders = [
        {
            name: 'root',
            uri: { fsPath: workspaceRoot, scheme: 'file', path: workspaceRoot }
        }
    ];
    (vscode.workspace as any).textDocuments = [];
    (vscode as any).window = {
        setStatusBarMessage: jest.fn(),
        showTextDocument: jest.fn(),
        tabGroups: { all: [], close: jest.fn() }
    };
    (vscode.commands.executeCommand as jest.Mock).mockResolvedValue(undefined);

    const sharedMetadata: { custom: Record<string, unknown> } = {
        custom: { checkpoints: [] as CheckpointRecord[] }
    };
    const storedCheckpoints = (): CheckpointRecord[] =>
        (sharedMetadata.custom.checkpoints as CheckpointRecord[]) || [];

    const baseConfig = {
        enabled: true,
        beforeTools: [],
        afterTools: ['write_file'],
        messageCheckpoint: { beforeMessages: [], afterMessages: [] },
        maxCheckpoints: -1,
        customIgnorePatterns: [],
        exclusion: {
            enabledProfiles: {},
            maxFileSizeBytes: 1024,
            customPatterns: []
        }
    };
    let configValue: Record<string, unknown> = { ...baseConfig };
    const settingsManager = {
        getCheckpointConfig: jest.fn().mockImplementation(() => configValue)
    };

    let metadataWriteChain: Promise<unknown> = Promise.resolve();
    const conversationManager = {
        getMetadata: jest.fn().mockImplementation(async () => sharedMetadata),
        getCustomMetadata: jest.fn().mockImplementation(async (_cid: string, key: string) => {
            return (sharedMetadata.custom as Record<string, unknown>)[key];
        }),
        setCustomMetadata: jest.fn().mockImplementation(async (_cid: string, key: string, value: unknown) => {
            (sharedMetadata.custom as Record<string, unknown>)[key] = value;
        }),
        updateCustomMetadata: jest.fn().mockImplementation(
            (_cid: string, key: string, updater: (current: unknown) => unknown | Promise<unknown>) => {
                const run = metadataWriteChain.then(async () => {
                    const current = (sharedMetadata.custom as Record<string, unknown>)[key];
                    const next = await updater(current);
                    if (next !== current) {
                        (sharedMetadata.custom as Record<string, unknown>)[key] = next;
                    }
                    return next;
                });
                metadataWriteChain = run.catch(() => undefined);
                return run;
            }
        ),
        rejectAllPendingToolCalls: jest.fn().mockResolvedValue(undefined),
        listConversations: jest.fn().mockResolvedValue([])
    };

    const manager = new CheckpointManager(
        settingsManager as any,
        conversationManager as any,
        { globalStorageUri: { fsPath: storageRoot } } as any
    );
    await manager.initialize();

    const readManifest = async (checkpointId: string): Promise<CheckpointManifest | null> => {
        try {
            const metaRaw = await fs.readFile(
                path.join(storageRoot, 'checkpoints', checkpointId, 'manifest.json'),
                'utf-8'
            );
            const manifest = JSON.parse(metaRaw) as CheckpointManifest;
            // CPF-LAZY-1: v2 拆分布局下 files 独立存放于 files.json，按需合并读取
            if (!manifest.files) {
                try {
                    const filesRaw = await fs.readFile(
                        path.join(storageRoot, 'checkpoints', checkpointId, 'files.json'),
                        'utf-8'
                    );
                    manifest.files = (JSON.parse(filesRaw) as { files?: CheckpointManifest['files'] }).files ?? {};
                } catch {
                    manifest.files = {};
                }
            }
            return manifest;
        } catch {
            return null;
        }
    };

    return { manager, storageRoot, storedCheckpoints, readManifest };
}

describe('BCP-07 增量链文件级共享 + base 引用恢复（决策 12 固化）', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('文件级共享：连续存档只复制变更文件，未变文件在后续存档备份目录中不重复落盘', async () => {
        const workspaceRoot = await createTempDirectory('limcode-bcp07-workspace-');
        const storageRoot = await createTempDirectory('limcode-bcp07-storage-');
        try {
            await writeFile(workspaceRoot, 'a.txt', 'v1');
            await writeFile(workspaceRoot, 'b.txt', 'v1');
            const harness = await createHarness(workspaceRoot, storageRoot);

            // cp1 = 完整备份（a.txt + b.txt）
            const cp1 = await harness.manager.createCheckpoint('conv-1', 0, 'write_file', 'after');
            expect(cp1).not.toBeNull();
            expect(cp1!.type).toBe('full');

            // 只修改 a.txt → cp2 应为增量（base = cp1）
            await writeFile(workspaceRoot, 'a.txt', 'v2');
            const cp2 = await harness.manager.createCheckpoint('conv-1', 0, 'write_file', 'after');
            expect(cp2).not.toBeNull();
            expect(cp2!.type).toBe('incremental');
            expect(cp2!.baseCheckpointId).toBe(cp1!.id);

            // scoped 键形如 ws_xxx/a.txt：rootId 从返回记录的 fileHashes 中提取
            const scopedA = Object.keys(cp1!.fileHashes!).find(k => k.endsWith('/a.txt'))!;
            const scopedB = Object.keys(cp1!.fileHashes!).find(k => k.endsWith('/b.txt'))!;
            const rootId = scopedA.split('/')[0]!;
            expect(scopedA).toBeTruthy();
            expect(scopedB).toBeTruthy();

            // backupDir 布局断言（核心）：cp1 目录含全部文件，cp2 目录只含变更文件
            const cp1Dir = path.join(storageRoot, 'checkpoints', cp1!.id);
            const cp2Dir = path.join(storageRoot, 'checkpoints', cp2!.id);
            expect(await pathExists(path.join(cp1Dir, rootId, 'a.txt'))).toBe(true);
            expect(await pathExists(path.join(cp1Dir, rootId, 'b.txt'))).toBe(true);
            expect(await pathExists(path.join(cp2Dir, rootId, 'a.txt'))).toBe(true);
            // 未变文件 b.txt 不重复落盘：cp2 备份目录中不存在
            expect(await pathExists(path.join(cp2Dir, rootId, 'b.txt'))).toBe(false);

            // manifest 断言：files 是完整工作区映射（恢复目标），changes 只含变更文件
            const manifest2 = await harness.readManifest(cp2!.id);
            expect(manifest2).not.toBeNull();
            expect(manifest2!.files[scopedA]).toBeDefined();
            expect(manifest2!.files[scopedB]).toBeDefined();
            expect(manifest2!.files[scopedB]!.hash).toBe(md5('v1')); // 与 base 相同内容，仅引用
            expect(manifest2!.changes).toHaveLength(1);
            expect(manifest2!.changes[0]!.path).toBe(scopedA);
            expect(manifest2!.changes[0]!.type).toBe('modified');

            // 磁盘占用：cp2 只复制了 a.txt，备份字节必然小于 cp1（b.txt 未重复存储）
            expect(cp2!.backupBytes ?? 0).toBeLessThan(cp1!.backupBytes ?? 0);
            expect(cp2!.fileCount).toBe(1);
            expect(cp1!.fileCount).toBe(2);
        } finally {
            await fs.rm(workspaceRoot, { recursive: true, force: true });
            await fs.rm(storageRoot, { recursive: true, force: true });
        }
    });

    test('恢复按增量链引用 base：未变文件从 base 备份目录恢复，不要求每个存档完整副本', async () => {
        const workspaceRoot = await createTempDirectory('limcode-bcp07-workspace-');
        const storageRoot = await createTempDirectory('limcode-bcp07-storage-');
        try {
            await writeFile(workspaceRoot, 'a.txt', 'v1');
            await writeFile(workspaceRoot, 'b.txt', 'v1');
            const harness = await createHarness(workspaceRoot, storageRoot);

            const cp1 = await harness.manager.createCheckpoint('conv-1', 0, 'write_file', 'after');
            expect(cp1).not.toBeNull();
            await writeFile(workspaceRoot, 'a.txt', 'v2');
            const cp2 = await harness.manager.createCheckpoint('conv-1', 0, 'write_file', 'after');
            expect(cp2).not.toBeNull();
            expect(cp2!.type).toBe('incremental');

            const scopedA = Object.keys(cp1!.fileHashes!).find(k => k.endsWith('/a.txt'))!;
            const rootId = scopedA.split('/')[0]!;
            const cp2Dir = path.join(storageRoot, 'checkpoints', cp2!.id);
            // 前置证明：cp2 备份目录确实没有 b.txt（恢复只能走 base 引用）
            expect(await pathExists(path.join(cp2Dir, rootId, 'b.txt'))).toBe(false);

            // 工作区漂移：b.txt 被删除（外部修改），a.txt 保持 v2（与 cp2 快照一致）
            await fs.rm(path.join(workspaceRoot, 'b.txt'));

            const restore = await harness.manager.restoreCheckpoint('conv-1', cp2!.id);
            expect(restore.success).toBe(true);
            expect(restore.failures).toBeUndefined();
            // b.txt 未在 cp2 目录中 → 只能从 base（cp1）恢复；a.txt 从 cp2 目录恢复
            expect(await fs.readFile(path.join(workspaceRoot, 'a.txt'), 'utf-8')).toBe('v2');
            expect(await fs.readFile(path.join(workspaceRoot, 'b.txt'), 'utf-8')).toBe('v1');
            expect(restore.restored).toBe(1);
            expect(restore.skipped).toBe(1); // a.txt 已与目标一致，跳过

            // 反证：删除 cp1（base）目录后恢复 cp2 → 恢复被拒绝（base 目录缺失被检出），
            // 证明 b.txt 的确由 base 提供（引用关系真实存在，而非 cp2 自带副本）
            await fs.rm(path.join(storageRoot, 'checkpoints', cp1!.id), { recursive: true, force: true });
            await fs.rm(path.join(workspaceRoot, 'b.txt'));
            const broken = await harness.manager.restoreCheckpoint('conv-1', cp2!.id);
            expect(broken.success).toBe(false);
            expect(broken.missingBackupDirs?.includes(cp1!.id)).toBe(true);
        } finally {
            await fs.rm(workspaceRoot, { recursive: true, force: true });
            await fs.rm(storageRoot, { recursive: true, force: true });
        }
    });

    test('多跳增量链：恢复末端存档时各文件按链解析到最近持有者（跨两级 base）', async () => {
        const workspaceRoot = await createTempDirectory('limcode-bcp07-workspace-');
        const storageRoot = await createTempDirectory('limcode-bcp07-storage-');
        try {
            await writeFile(workspaceRoot, 'a.txt', 'v1');
            await writeFile(workspaceRoot, 'b.txt', 'v1');
            const harness = await createHarness(workspaceRoot, storageRoot);

            // cp1 完整：a.txt=v1, b.txt=v1
            const cp1 = await harness.manager.createCheckpoint('conv-1', 0, 'write_file', 'after');
            expect(cp1).not.toBeNull();
            // cp2 增量：只改 a.txt → 目录只含 a.txt=v2
            await writeFile(workspaceRoot, 'a.txt', 'v2');
            const cp2 = await harness.manager.createCheckpoint('conv-1', 0, 'write_file', 'after');
            expect(cp2!.type).toBe('incremental');
            expect(cp2!.baseCheckpointId).toBe(cp1!.id);
            // cp3 增量：只改 b.txt → 目录只含 b.txt=v2
            await writeFile(workspaceRoot, 'b.txt', 'v2');
            const cp3 = await harness.manager.createCheckpoint('conv-1', 0, 'write_file', 'after');
            expect(cp3).not.toBeNull();
            expect(cp3!.type).toBe('incremental');
            expect(cp3!.baseCheckpointId).toBe(cp2!.id);

            const scopedA = Object.keys(cp1!.fileHashes!).find(k => k.endsWith('/a.txt'))!;
            const scopedB = Object.keys(cp1!.fileHashes!).find(k => k.endsWith('/b.txt'))!;
            const rootId = scopedA.split('/')[0]!;
            const cp2Dir = path.join(storageRoot, 'checkpoints', cp2!.id);
            const cp3Dir = path.join(storageRoot, 'checkpoints', cp3!.id);

            // 布局断言：每级增量只持有自己的变更文件
            expect(await pathExists(path.join(cp2Dir, rootId, 'a.txt'))).toBe(true);
            expect(await pathExists(path.join(cp2Dir, rootId, 'b.txt'))).toBe(false);
            expect(await pathExists(path.join(cp3Dir, rootId, 'a.txt'))).toBe(false);
            expect(await pathExists(path.join(cp3Dir, rootId, 'b.txt'))).toBe(true);

            // 工作区漂移：两个文件全部删除
            await fs.rm(path.join(workspaceRoot, 'a.txt'));
            await fs.rm(path.join(workspaceRoot, 'b.txt'));

            // 恢复 cp3：a.txt=v2 必须来自 cp2（最近持有者，非 cp1 的 v1）→ 证明多跳链解析
            const restore = await harness.manager.restoreCheckpoint('conv-1', cp3!.id);
            expect(restore.success).toBe(true);
            expect(restore.failures).toBeUndefined();
            expect(await fs.readFile(path.join(workspaceRoot, 'a.txt'), 'utf-8')).toBe('v2');
            expect(await fs.readFile(path.join(workspaceRoot, 'b.txt'), 'utf-8')).toBe('v2');
            expect(restore.restored).toBe(2);
        } finally {
            await fs.rm(workspaceRoot, { recursive: true, force: true });
            await fs.rm(storageRoot, { recursive: true, force: true });
        }
    });

    test('决策 12：同内容重复创建 → 存档记录重复（无哈希去重）但备份文件零重复', async () => {
        const workspaceRoot = await createTempDirectory('limcode-bcp07-workspace-');
        const storageRoot = await createTempDirectory('limcode-bcp07-storage-');
        try {
            await writeFile(workspaceRoot, 'a.txt', 'v1');
            const harness = await createHarness(workspaceRoot, storageRoot);

            const cp1 = await harness.manager.createCheckpoint('conv-1', 0, 'write_file', 'after');
            expect(cp1).not.toBeNull();
            expect(cp1!.type).toBe('full');

            // 工作区无任何变化 → cp2 为空增量节点（changes=[]），不复制任何文件
            const cp2 = await harness.manager.createCheckpoint('conv-1', 0, 'write_file', 'after');
            expect(cp2).not.toBeNull();
            expect(cp2!.type).toBe('incremental');
            expect(cp2!.changes).toEqual([]);
            expect(cp2!.fileCount).toBe(0);
            expect(cp2!.backupBytes).toBe(0);

            // 决策 12 语义：同内容存档仍创建新记录（contentHash 相同但 id 不同）——
            // 不做内容哈希去重（去重会改变存档列表语义：多条同内容记录并展示为一次）
            const records = harness.storedCheckpoints();
            expect(records).toHaveLength(2);
            expect(records[0]!.id).not.toBe(records[1]!.id);
            expect(records[0]!.contentHash).toBe(records[1]!.contentHash);
            expect(cp2!.contentHash).toBe(cp1!.contentHash);

            // 但磁盘零重复：cp2 备份目录为空（无任何文件副本，仅 manifest/files 元数据）
            const cp2Dir = path.join(storageRoot, 'checkpoints', cp2!.id);
            const entries = await fs.readdir(cp2Dir);
            expect(entries.filter(e => e !== 'manifest.json' && e !== 'files.json')).toEqual([]);

            // 恢复 cp2 仍成功：文件全部由 base（cp1）经增量链提供
            await writeFile(workspaceRoot, 'a.txt', 'drifted');
            const restore = await harness.manager.restoreCheckpoint('conv-1', cp2!.id);
            expect(restore.success).toBe(true);
            expect(restore.failures).toBeUndefined();
            expect(await fs.readFile(path.join(workspaceRoot, 'a.txt'), 'utf-8')).toBe('v1');
        } finally {
            await fs.rm(workspaceRoot, { recursive: true, force: true });
            await fs.rm(storageRoot, { recursive: true, force: true });
        }
    });
});
