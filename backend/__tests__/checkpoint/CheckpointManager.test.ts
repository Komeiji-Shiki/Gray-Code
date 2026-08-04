import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

jest.mock('../../tools/file/diffManager', () => ({
    getDiffManager: () => ({
        cancelAllPending: jest.fn().mockResolvedValue({ cancelled: [] })
    })
}));

import { CheckpointManager, CheckpointRecord } from '../../modules/checkpoint/CheckpointManager';
import { fileWriteLockManager } from '../../core/fileWriteLockManager';

/**
 * CheckpointManager restore 测试
 *
 * 这些用例专门保护引入的 restore 边界：
 * - 恢复时必须服从“当前工作区”的 ignore 规则
 * - 该语义对新旧两类 checkpoint 记录都成立
 */
async function createTempDirectory(prefix: string): Promise<string> {
    return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/**
 * 创建测试文件，自动补齐父目录。
 */
async function writeFile(rootDir: string, relativePath: string, content: string = ''): Promise<void> {
    const fullPath = path.join(rootDir, relativePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content, 'utf-8');
}

/**
 * 判断某个路径当前是否存在。
 */
async function pathExists(targetPath: string): Promise<boolean> {
    try {
        await fs.access(targetPath);
        return true;
    } catch {
        return false;
    }
}

/**
 * 生成与 CheckpointManager 一致的文件内容哈希。
 */
function hashContent(content: string): string {
    return crypto.createHash('md5').update(content).digest('hex');
}

/**
 * 构造一个最小可运行的 CheckpointManager 测试环境。
 *
 * 这里显式 mock 出：
 * - 单根工作区
 * - checkpoint 设置
 * - conversation metadata 读写
 * - restore 期间会碰到的 VS Code API
 */
async function createCheckpointManager(
    workspaceRoot: string,
    storageRoot: string,
    checkpoints: CheckpointRecord[],
    customIgnorePatterns: string[] = [],
    multiConversation?: Record<string, CheckpointRecord[]>
): Promise<CheckpointManager> {
    (vscode.workspace as any).workspaceFolders = [
        {
            uri: {
                fsPath: workspaceRoot,
                scheme: 'file',
                path: workspaceRoot
            }
        }
    ];
    (vscode.workspace as any).textDocuments = [];
    (vscode as any).window = {
        setStatusBarMessage: jest.fn(),
        showTextDocument: jest.fn(),
        tabGroups: {
            all: [],
            close: jest.fn()
        }
    };
    (vscode.commands.executeCommand as jest.Mock).mockResolvedValue(undefined);

    // 单对话模式：所有读写共享同一 metadata 对象（兼容既有测试）
    const sharedMetadata = { custom: { checkpoints: [...checkpoints] } };
    // 多对话模式：按 conversationId 隔离存储，模拟真实 ConversationManager
    const metadataByConversation = new Map<string, { custom: Record<string, unknown> }>();
    if (multiConversation) {
        for (const [id, cps] of Object.entries(multiConversation)) {
            metadataByConversation.set(id, { custom: { checkpoints: [...cps] } });
        }
    }
    const resolveMetadata = (conversationId: string): { custom: Record<string, unknown> } => {
        if (multiConversation) {
            let m = metadataByConversation.get(conversationId);
            if (!m) {
                m = { custom: {} };
                metadataByConversation.set(conversationId, m);
            }
            return m;
        }
        return sharedMetadata;
    };

    const settingsManager = {
        getCheckpointConfig: jest.fn().mockReturnValue({
            enabled: true,
            beforeTools: [],
            afterTools: [],
            messageCheckpoint: {
                beforeMessages: [],
                afterMessages: []
            },
            maxCheckpoints: -1,
            customIgnorePatterns
        })
    };
    // 模拟真实 withMetadataWriteSerialized 链：并发调用串行执行，第二个 updater 基于第一个写回后的最新列表
    let metadataWriteChain: Promise<unknown> = Promise.resolve();
    const conversationManager = {
        getMetadata: jest.fn().mockImplementation(async (conversationId: string) => resolveMetadata(conversationId)),
        getCustomMetadata: jest.fn().mockImplementation(async (conversationId: string, key: string) => {
            return (resolveMetadata(conversationId).custom as Record<string, unknown>)[key];
        }),
        setCustomMetadata: jest.fn().mockImplementation(async (conversationId: string, key: string, value: unknown) => {
            (resolveMetadata(conversationId).custom as Record<string, unknown>)[key] = value;
        }),
        updateCustomMetadata: jest.fn().mockImplementation(
            (conversationId: string, key: string, updater: (current: unknown) => unknown | Promise<unknown>) => {
                const run = metadataWriteChain.then(async () => {
                    const current = (resolveMetadata(conversationId).custom as Record<string, unknown>)[key];
                    const next = await updater(current);
                    if (next !== current) {
                        (resolveMetadata(conversationId).custom as Record<string, unknown>)[key] = next;
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
        {
            globalStorageUri: {
                fsPath: storageRoot
            }
        } as any
    );
    await manager.initialize();
    return manager;
}

describe('CheckpointManager restore ignore semantics', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('restore skips checkpoint files that are currently ignored', async () => {
        const workspaceRoot = await createTempDirectory('limcode-checkpoint-workspace-');
        const storageRoot = await createTempDirectory('limcode-checkpoint-storage-');
        const conversationId = 'conv-current-ignore';
        const checkpointId = 'cp-current-ignore';
        const visibleContent = 'checkpoint visible\n';
        const ignoredContent = 'checkpoint ignored\n';

        try {
            // 工作区当前已经把 ignored/ 视为不可触碰区域，restore 不应覆盖里面的内容。
            await writeFile(workspaceRoot, 'visible.txt', 'workspace visible\n');
            await writeFile(workspaceRoot, 'ignored/secret.txt', 'keep current ignored\n');

            const checkpoint: CheckpointRecord = {
                id: checkpointId,
                conversationId,
                messageIndex: 0,
                toolName: 'apply_diff',
                phase: 'after',
                timestamp: Date.now(),
                backupDir: checkpointId,
                fileCount: 2,
                contentHash: 'hash-current-ignore',
                type: 'full',
                fileHashes: {
                    'visible.txt': hashContent(visibleContent),
                    'ignored/secret.txt': hashContent(ignoredContent)
                },
                emptyDirs: ['ignored/empty']
            };

            const backupRoot = path.join(storageRoot, 'checkpoints', checkpointId);
            await writeFile(backupRoot, 'visible.txt', visibleContent);
            await writeFile(backupRoot, 'ignored/secret.txt', ignoredContent);

            const manager = await createCheckpointManager(
                workspaceRoot,
                storageRoot,
                [checkpoint],
                ['ignored/']
            );

            const result = await manager.restoreCheckpoint(conversationId, checkpointId);

            expect(result).toMatchObject({
                success: true,
                restored: 1,
                deleted: 0,
                skipped: 0
            });
            // 只有当前未忽略的文件应被恢复；忽略路径和忽略空目录都必须保持不变。
            await expect(fs.readFile(path.join(workspaceRoot, 'visible.txt'), 'utf-8')).resolves.toBe(visibleContent);
            await expect(fs.readFile(path.join(workspaceRoot, 'ignored/secret.txt'), 'utf-8')).resolves.toBe('keep current ignored\n');
            await expect(pathExists(path.join(workspaceRoot, 'ignored/empty'))).resolves.toBe(false);
        } finally {
            await fs.rm(workspaceRoot, { recursive: true, force: true });
            await fs.rm(storageRoot, { recursive: true, force: true });
        }
    });

    test('legacy restore also skips checkpoint files that are currently ignored', async () => {
        const workspaceRoot = await createTempDirectory('limcode-checkpoint-workspace-');
        const storageRoot = await createTempDirectory('limcode-checkpoint-storage-');
        const conversationId = 'conv-legacy-ignore';
        const checkpointId = 'cp-legacy-ignore';
        const visibleContent = 'legacy visible\n';
        const ignoredContent = 'legacy ignored\n';

        try {
            // legacy checkpoint 没有 fileHashes，但 restore 仍然不能绕过当前 ignore 规则。
            await writeFile(workspaceRoot, 'visible.txt', 'workspace visible\n');
            await writeFile(workspaceRoot, 'ignored/secret.txt', 'keep current ignored\n');

            const checkpoint: CheckpointRecord = {
                id: checkpointId,
                conversationId,
                messageIndex: 0,
                toolName: 'apply_diff',
                phase: 'after',
                timestamp: Date.now(),
                backupDir: checkpointId,
                fileCount: 2,
                contentHash: 'hash-legacy-ignore',
                type: 'full'
            };

            const backupRoot = path.join(storageRoot, 'checkpoints', checkpointId);
            await writeFile(backupRoot, 'visible.txt', visibleContent);
            await writeFile(backupRoot, 'ignored/secret.txt', ignoredContent);
            await fs.mkdir(path.join(backupRoot, 'ignored/empty'), { recursive: true });

            const manager = await createCheckpointManager(
                workspaceRoot,
                storageRoot,
                [checkpoint],
                ['ignored/']
            );

            const result = await manager.restoreCheckpoint(conversationId, checkpointId);

            expect(result).toMatchObject({
                success: true,
                restored: 1,
                deleted: 0
            });
            // 新旧恢复路径最终都应该表现为同一条规则：只恢复当前可见路径。
            await expect(fs.readFile(path.join(workspaceRoot, 'visible.txt'), 'utf-8')).resolves.toBe(visibleContent);
            await expect(fs.readFile(path.join(workspaceRoot, 'ignored/secret.txt'), 'utf-8')).resolves.toBe('keep current ignored\n');
            await expect(pathExists(path.join(workspaceRoot, 'ignored/empty'))).resolves.toBe(false);
        } finally {
            await fs.rm(workspaceRoot, { recursive: true, force: true });
            await fs.rm(storageRoot, { recursive: true, force: true });
        }
    });

    test('#28: restore fails when incremental chain is broken', async () => {
        const workspaceRoot = await createTempDirectory('limcode-checkpoint-workspace-');
        const storageRoot = await createTempDirectory('limcode-checkpoint-storage-');
        const conversationId = 'conv-chain-broken';
        const baseId = 'cp-base';
        const targetId = 'cp-target';

        try {
            await writeFile(workspaceRoot, 'a.txt', 'base content\n');

            // base checkpoint: full backup
            const baseCheckpoint: CheckpointRecord = {
                id: baseId,
                conversationId,
                messageIndex: 0,
                toolName: 'write_file',
                phase: 'after',
                timestamp: 1000,
                backupDir: baseId,
                fileCount: 1,
                contentHash: 'hash-base',
                type: 'full',
                fileHashes: { 'a.txt': hashContent('base content\n') }
            };

            // target checkpoint: incremental, references baseId (which won't be in the list)
            const targetCheckpoint: CheckpointRecord = {
                id: targetId,
                conversationId,
                messageIndex: 1,
                toolName: 'apply_diff',
                phase: 'after',
                timestamp: 2000,
                backupDir: targetId,
                fileCount: 1,
                contentHash: 'hash-target',
                type: 'incremental',
                baseCheckpointId: baseId,
                fileHashes: { 'a.txt': hashContent('modified content\n') }
            };

            // backup dirs on disk
            const backupRootBase = path.join(storageRoot, 'checkpoints', baseId);
            await writeFile(backupRootBase, 'a.txt', 'base content\n');
            const backupRootTarget = path.join(storageRoot, 'checkpoints', targetId);
            await writeFile(backupRootTarget, 'a.txt', 'modified content\n');

            // Only target in the list — base is missing → chain broken
            const manager = await createCheckpointManager(
                workspaceRoot,
                storageRoot,
                [targetCheckpoint],
                []
            );

            const result = await manager.restoreCheckpoint(conversationId, targetId);

            expect(result.success).toBe(false);
            expect(result.error).toBeDefined();
            expect(result.error!.length).toBeGreaterThan(0);  // message depends on locale
        } finally {
            await fs.rm(workspaceRoot, { recursive: true, force: true });
            await fs.rm(storageRoot, { recursive: true, force: true });
        }
    });

    test('#29: restore does not delete files that were not in checkpoint fileHashes', async () => {
        const workspaceRoot = await createTempDirectory('limcode-checkpoint-workspace-');
        const storageRoot = await createTempDirectory('limcode-checkpoint-storage-');
        const conversationId = 'conv-no-delete-untracked';
        const checkpointId = 'cp-untracked';

        try {
            // Workspace has an extra file that the checkpoint never recorded
            await writeFile(workspaceRoot, 'tracked.txt', 'tracked\n');
            await writeFile(workspaceRoot, 'untracked.txt', 'do not delete me\n');

            const trackedContent = 'tracked checkpoint\n';
            const checkpoint: CheckpointRecord = {
                id: checkpointId,
                conversationId,
                messageIndex: 0,
                toolName: 'write_file',
                phase: 'after',
                timestamp: Date.now(),
                backupDir: checkpointId,
                fileCount: 1,
                contentHash: 'hash-untracked',
                type: 'full',
                // Only tracked.txt was recorded; untracked.txt was not in fileHashes
                fileHashes: { 'tracked.txt': hashContent(trackedContent) }
            };

            const backupRoot = path.join(storageRoot, 'checkpoints', checkpointId);
            await writeFile(backupRoot, 'tracked.txt', trackedContent);

            const manager = await createCheckpointManager(
                workspaceRoot,
                storageRoot,
                [checkpoint],
                []
            );

            const result = await manager.restoreCheckpoint(conversationId, checkpointId);

            expect(result.success).toBe(true);
            // untracked.txt was NOT in fileHashes → should survive (#29)
            await expect(fs.readFile(path.join(workspaceRoot, 'untracked.txt'), 'utf-8')).resolves.toBe('do not delete me\n');
            await expect(fs.readFile(path.join(workspaceRoot, 'tracked.txt'), 'utf-8')).resolves.toBe(trackedContent);
        } finally {
            await fs.rm(workspaceRoot, { recursive: true, force: true });
            await fs.rm(storageRoot, { recursive: true, force: true });
        }
    });

    test('#30: restore collects failures for missing-in-chain, hash-mismatch, copy-failed', async () => {
        const workspaceRoot = await createTempDirectory('limcode-checkpoint-workspace-');
        const storageRoot = await createTempDirectory('limcode-checkpoint-storage-');
        const conversationId = 'conv-failures';
        const checkpointId = 'cp-failures';

        try {
            // Two files tracked in checkpoint; a.txt has backup copy, b.txt does not (missing_in_chain)
            // c.txt: backup content hash mismatches declared hash (hash_mismatch)
            // d.txt: backup file has correct hash but restore will work fine
            await writeFile(workspaceRoot, 'a.txt', 'current a\n');
            await writeFile(workspaceRoot, 'b.txt', 'current b\n');
            await writeFile(workspaceRoot, 'c.txt', 'current c\n');
            await writeFile(workspaceRoot, 'd.txt', 'current d\n');

            const correctHashD = hashContent('restored d\n');
            const checkpoint: CheckpointRecord = {
                id: checkpointId,
                conversationId,
                messageIndex: 0,
                toolName: 'apply_diff',
                phase: 'after',
                timestamp: Date.now(),
                backupDir: checkpointId,
                fileCount: 2,
                contentHash: 'hash-failures',
                type: 'full',
                fileHashes: {
                    'a.txt': hashContent('missing in chain a\n'),
                    'b.txt': hashContent('missing in chain b\n'),
                    'c.txt': hashContent('mismatch c\n'),
                    'd.txt': correctHashD
                }
            };

            const backupRoot = path.join(storageRoot, 'checkpoints', checkpointId);
            // a.txt: NOT created in backup → missing_in_chain
            // b.txt: NOT created in backup → missing_in_chain
            // c.txt: created but with WRONG content → hash_mismatch
            await writeFile(backupRoot, 'c.txt', 'wrong content for c\n');
            // d.txt: backup has correct content → should succeed
            await writeFile(backupRoot, 'd.txt', 'restored d\n');

            const manager = await createCheckpointManager(
                workspaceRoot,
                storageRoot,
                [checkpoint],
                []
            );

            const result = await manager.restoreCheckpoint(conversationId, checkpointId);

            expect(result.success).toBe(false);
            expect(result.failures).toBeDefined();
            const failures = result.failures!;

            // a.txt and b.txt are missing_in_chain
            const missing = failures.filter(f => f.reason === 'missing_in_chain');
            expect(missing.length).toBe(2);
            const missingPaths = missing.map(f => f.path).sort();
            expect(missingPaths).toEqual(['a.txt', 'b.txt']);

            // c.txt is hash_mismatch
            const mismatches = failures.filter(f => f.reason === 'hash_mismatch');
            expect(mismatches.length).toBe(1);
            expect(mismatches[0].path).toBe('c.txt');

            // d.txt should have been restored successfully
            expect(result.restored).toBe(1);
            await expect(fs.readFile(path.join(workspaceRoot, 'd.txt'), 'utf-8')).resolves.toBe('restored d\n');
        } finally {
            await fs.rm(workspaceRoot, { recursive: true, force: true });
            await fs.rm(storageRoot, { recursive: true, force: true });
        }
    });

    test('#28: intact chain (no missing base) restores successfully', async () => {
        const workspaceRoot = await createTempDirectory('limcode-checkpoint-workspace-');
        const storageRoot = await createTempDirectory('limcode-checkpoint-storage-');
        const conversationId = 'conv-chain-intact';
        const baseId = 'cp-base-intact';
        const targetId = 'cp-target-intact';

        try {
            await writeFile(workspaceRoot, 'file.txt', 'current\n');

            const baseCheckpoint: CheckpointRecord = {
                id: baseId,
                conversationId,
                messageIndex: 0,
                toolName: 'write_file',
                phase: 'after',
                timestamp: 1000,
                backupDir: baseId,
                fileCount: 1,
                contentHash: 'hash-base-intact',
                type: 'full',
                fileHashes: { 'file.txt': hashContent('base\n') }
            };

            const targetContent = 'target\n';
            const targetCheckpoint: CheckpointRecord = {
                id: targetId,
                conversationId,
                messageIndex: 1,
                toolName: 'apply_diff',
                phase: 'after',
                timestamp: 2000,
                backupDir: targetId,
                fileCount: 1,
                contentHash: 'hash-target-intact',
                type: 'incremental',
                baseCheckpointId: baseId,
                fileHashes: { 'file.txt': hashContent(targetContent) },
                changes: [{ path: 'file.txt', type: 'modified', hash: hashContent(targetContent) }]
            };

            const backupRootBase = path.join(storageRoot, 'checkpoints', baseId);
            await writeFile(backupRootBase, 'file.txt', 'base\n');
            const backupRootTarget = path.join(storageRoot, 'checkpoints', targetId);
            await writeFile(backupRootTarget, 'file.txt', targetContent);

            const manager = await createCheckpointManager(
                workspaceRoot,
                storageRoot,
                [baseCheckpoint, targetCheckpoint],
                []
            );

            const result = await manager.restoreCheckpoint(conversationId, targetId);

            expect(result.success).toBe(true);
            expect(result.restored).toBe(1);
            await expect(fs.readFile(path.join(workspaceRoot, 'file.txt'), 'utf-8')).resolves.toBe(targetContent);
        } finally {
            await fs.rm(workspaceRoot, { recursive: true, force: true });
            await fs.rm(storageRoot, { recursive: true, force: true });
        }
    });

describe('CheckpointManager metadata RMW migration (A2)', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    function makeRecord(overrides: Partial<CheckpointRecord> & { id: string }): CheckpointRecord {
        return {
            conversationId: 'conv',
            messageIndex: 0,
            toolName: 'write_file',
            phase: 'after',
            timestamp: 1000,
            backupDir: overrides.id,
            fileCount: 0,
            contentHash: 'h',
            type: 'full',
            ...overrides
        };
    }

    test('saveCheckpointToConversation appends records via updateCustomMetadata', async () => {
        const workspaceRoot = await createTempDirectory('limcode-checkpoint-workspace-');
        const storageRoot = await createTempDirectory('limcode-checkpoint-storage-');
        const conversationId = 'conv-save';

        try {
            const oldCp = makeRecord({ id: 'cp-old', conversationId, timestamp: 1000 });
            const manager = await createCheckpointManager(workspaceRoot, storageRoot, [oldCp], []);

            const newCp = makeRecord({
                id: 'cp-new', conversationId, messageIndex: 1, timestamp: 2000,
                type: 'incremental', baseCheckpointId: 'cp-old'
            });
            await (manager as any).saveCheckpointToConversation(conversationId, newCp);

            const list = await manager.getCheckpoints(conversationId);
            expect(list.map(c => c.id)).toEqual(['cp-old', 'cp-new']);
        } finally {
            await fs.rm(workspaceRoot, { recursive: true, force: true });
            await fs.rm(storageRoot, { recursive: true, force: true });
        }
    });

    test('concurrent saves both persist without lost updates', async () => {
        const workspaceRoot = await createTempDirectory('limcode-checkpoint-workspace-');
        const storageRoot = await createTempDirectory('limcode-checkpoint-storage-');
        const conversationId = 'conv-concurrent-save';

        try {
            const oldCp = makeRecord({ id: 'cp-old', conversationId, timestamp: 1000 });
            const manager = await createCheckpointManager(workspaceRoot, storageRoot, [oldCp], []);
            const cpA = makeRecord({ id: 'cp-a', conversationId, messageIndex: 1, timestamp: 2000 });
            const cpB = makeRecord({ id: 'cp-b', conversationId, messageIndex: 2, timestamp: 3000 });

            await Promise.all([
                (manager as any).saveCheckpointToConversation(conversationId, cpA),
                (manager as any).saveCheckpointToConversation(conversationId, cpB)
            ]);

            const list = await manager.getCheckpoints(conversationId);
            expect(list.map(c => c.id)).toEqual(['cp-old', 'cp-a', 'cp-b']);
        } finally {
            await fs.rm(workspaceRoot, { recursive: true, force: true });
            await fs.rm(storageRoot, { recursive: true, force: true });
        }
    });

    test('deleteCheckpoint removes record and its backup dir', async () => {
        const workspaceRoot = await createTempDirectory('limcode-checkpoint-workspace-');
        const storageRoot = await createTempDirectory('limcode-checkpoint-storage-');
        const conversationId = 'conv-delete';
        const cp1 = makeRecord({ id: 'cp-1', conversationId, timestamp: 1000 });
        const cp2 = makeRecord({ id: 'cp-2', conversationId, messageIndex: 1, timestamp: 2000 });

        try {
            const backupRoot1 = path.join(storageRoot, 'checkpoints', 'cp-1');
            await writeFile(backupRoot1, 'a.txt', 'backup a\n');
            const backupRoot2 = path.join(storageRoot, 'checkpoints', 'cp-2');
            await writeFile(backupRoot2, 'b.txt', 'backup b\n');

            const manager = await createCheckpointManager(workspaceRoot, storageRoot, [cp1, cp2], []);

            const deleted = await manager.deleteCheckpoint(conversationId, 'cp-1');

            expect(deleted).toBe(true);
            const list = await manager.getCheckpoints(conversationId);
            expect(list.map(c => c.id)).toEqual(['cp-2']);
            await expect(pathExists(backupRoot1)).resolves.toBe(false);
            await expect(pathExists(backupRoot2)).resolves.toBe(true);
        } finally {
            await fs.rm(workspaceRoot, { recursive: true, force: true });
            await fs.rm(storageRoot, { recursive: true, force: true });
        }
    });

    test('deleteCheckpoint refuses when referenced as base (isReferencedBase)', async () => {
        const workspaceRoot = await createTempDirectory('limcode-checkpoint-workspace-');
        const storageRoot = await createTempDirectory('limcode-checkpoint-storage-');
        const conversationId = 'conv-referenced';
        const baseCp = makeRecord({ id: 'cp-base', conversationId, timestamp: 1000 });
        const targetCp = makeRecord({
            id: 'cp-target', conversationId, messageIndex: 1, timestamp: 2000,
            type: 'incremental', baseCheckpointId: 'cp-base'
        });

        try {
            const backupRootBase = path.join(storageRoot, 'checkpoints', 'cp-base');
            await writeFile(backupRootBase, 'a.txt', 'base\n');
            const backupRootTarget = path.join(storageRoot, 'checkpoints', 'cp-target');
            await writeFile(backupRootTarget, 'a.txt', 'target\n');

            const manager = await createCheckpointManager(workspaceRoot, storageRoot, [baseCp, targetCp], []);

            const deleted = await manager.deleteCheckpoint(conversationId, 'cp-base');

            expect(deleted).toBe(false);
            // 列表不变、磁盘目录保留（链完整性）
            const list = await manager.getCheckpoints(conversationId);
            expect(list.map(c => c.id)).toEqual(['cp-base', 'cp-target']);
            await expect(pathExists(backupRootBase)).resolves.toBe(true);
            await expect(pathExists(backupRootTarget)).resolves.toBe(true);
        } finally {
            await fs.rm(workspaceRoot, { recursive: true, force: true });
            await fs.rm(storageRoot, { recursive: true, force: true });
        }
    });

    test('deleteCheckpointsFromIndex removes records from messageIndex onward', async () => {
        const workspaceRoot = await createTempDirectory('limcode-checkpoint-workspace-');
        const storageRoot = await createTempDirectory('limcode-checkpoint-storage-');
        const conversationId = 'conv-from-index';
        const cps: CheckpointRecord[] = [0, 1, 2].map(i => makeRecord({
            id: `cp-${i}`, conversationId, messageIndex: i, timestamp: 1000 + i
        }));

        try {
            for (const cp of cps) {
                await writeFile(path.join(storageRoot, 'checkpoints', cp.backupDir), 'x.txt', `x${cp.messageIndex}\n`);
            }
            const manager = await createCheckpointManager(workspaceRoot, storageRoot, cps, []);

            const deleted = await manager.deleteCheckpointsFromIndex(conversationId, 1);

            expect(deleted).toBe(2);
            const list = await manager.getCheckpoints(conversationId);
            expect(list.map(c => c.id)).toEqual(['cp-0']);
            await expect(pathExists(path.join(storageRoot, 'checkpoints', 'cp-1'))).resolves.toBe(false);
        } finally {
            await fs.rm(workspaceRoot, { recursive: true, force: true });
            await fs.rm(storageRoot, { recursive: true, force: true });
        }
    });

    test('deleteCheckpointsFromIndex keeps excludeCheckpointId and its base chain', async () => {
        const workspaceRoot = await createTempDirectory('limcode-checkpoint-workspace-');
        const storageRoot = await createTempDirectory('limcode-checkpoint-storage-');
        const conversationId = 'conv-from-index-exclude';
        const cps: CheckpointRecord[] = [
            makeRecord({ id: 'cp-base', conversationId, messageIndex: 0, timestamp: 1000 }),
            makeRecord({
                id: 'cp-target', conversationId, messageIndex: 1, timestamp: 2000,
                type: 'incremental', baseCheckpointId: 'cp-base'
            }),
            makeRecord({
                id: 'cp-later', conversationId, messageIndex: 2, timestamp: 3000,
                type: 'incremental', baseCheckpointId: 'cp-target'
            })
        ];

        try {
            for (const cp of cps) {
                await writeFile(path.join(storageRoot, 'checkpoints', cp.backupDir), 'x.txt', 'x\n');
            }
            const manager = await createCheckpointManager(workspaceRoot, storageRoot, cps, []);

            const deleted = await manager.deleteCheckpointsFromIndex(conversationId, 1, 'cp-target');

            expect(deleted).toBe(1);
            const list = await manager.getCheckpoints(conversationId);
            expect(list.map(c => c.id)).toEqual(['cp-base', 'cp-target']);
        } finally {
            await fs.rm(workspaceRoot, { recursive: true, force: true });
            await fs.rm(storageRoot, { recursive: true, force: true });
        }
    });

    test('deleteAllCheckpoints clears records and backup dirs', async () => {
        const workspaceRoot = await createTempDirectory('limcode-checkpoint-workspace-');
        const storageRoot = await createTempDirectory('limcode-checkpoint-storage-');
        const conversationId = 'conv-delete-all';
        const cps: CheckpointRecord[] = [0, 1].map(i => makeRecord({
            id: `cp-${i}`, conversationId, messageIndex: i, timestamp: 1000 + i
        }));

        try {
            for (const cp of cps) {
                await writeFile(path.join(storageRoot, 'checkpoints', cp.backupDir), 'x.txt', 'x\n');
            }
            const manager = await createCheckpointManager(workspaceRoot, storageRoot, cps, []);

            const result = await manager.deleteAllCheckpoints(conversationId);

            expect(result.success).toBe(true);
            expect(result.deletedCount).toBe(2);
            expect(await manager.getCheckpoints(conversationId)).toEqual([]);
            await expect(pathExists(path.join(storageRoot, 'checkpoints', 'cp-0'))).resolves.toBe(false);
            await expect(pathExists(path.join(storageRoot, 'checkpoints', 'cp-1'))).resolves.toBe(false);
        } finally {
            await fs.rm(workspaceRoot, { recursive: true, force: true });
            await fs.rm(storageRoot, { recursive: true, force: true });
        }
    });

    test('pruneMissingBackupCheckpointRecords filters records without backup dir', async () => {
        const workspaceRoot = await createTempDirectory('limcode-checkpoint-workspace-');
        const storageRoot = await createTempDirectory('limcode-checkpoint-storage-');
        const conversationId = 'conv-prune';
        const withBackup = makeRecord({ id: 'cp-ok', conversationId, timestamp: 1000 });
        const missing = makeRecord({ id: 'cp-missing', conversationId, messageIndex: 1, timestamp: 2000 });

        try {
            await writeFile(path.join(storageRoot, 'checkpoints', 'cp-ok'), 'x.txt', 'x\n');
            const manager = await createCheckpointManager(workspaceRoot, storageRoot, [withBackup, missing], []);

            // L-10（R4 复查）：CheckpointManager 上的私有转发包装已删除（死代码），
            // 该能力由 CheckpointQueryService 直接提供，测试改为调用 queryService。
            const result = await (manager as any).queryService.pruneMissingBackupCheckpointRecords(conversationId, [withBackup, missing]);

            expect(result.prunedCount).toBe(1);
            const list = await manager.getCheckpoints(conversationId);
            expect(list.map(c => c.id)).toEqual(['cp-ok']);
        } finally {
            await fs.rm(workspaceRoot, { recursive: true, force: true });
            await fs.rm(storageRoot, { recursive: true, force: true });
        }
    });

    test('cleanupOldCheckpoints merges chain before deleting referenced base', async () => {
        const workspaceRoot = await createTempDirectory('limcode-checkpoint-workspace-');
        const storageRoot = await createTempDirectory('limcode-checkpoint-storage-');
        const conversationId = 'conv-cleanup';
        const baseCp = makeRecord({ id: 'cp-base', conversationId, timestamp: 1000 });
        const targetCp = makeRecord({
            id: 'cp-target', conversationId, messageIndex: 1, timestamp: 2000,
            type: 'incremental', baseCheckpointId: 'cp-base'
        });

        try {
            // base 备份含 target 没有的 b.txt（合并时应复制进 target 目录）
            await writeFile(path.join(storageRoot, 'checkpoints', 'cp-base'), 'b.txt', 'base-only\n');
            await writeFile(path.join(storageRoot, 'checkpoints', 'cp-target'), 'a.txt', 'target\n');

            const manager = await createCheckpointManager(workspaceRoot, storageRoot, [baseCp, targetCp], []);
            ((manager as any).settingsManager.getCheckpointConfig as jest.Mock).mockReturnValue({
                enabled: true,
                beforeTools: [],
                afterTools: [],
                messageCheckpoint: { beforeMessages: [], afterMessages: [] },
                maxCheckpoints: 1,
                customIgnorePatterns: []
            });

            await (manager as any).cleanupOldCheckpoints(conversationId);

            // 链上中间节点被合并后删除，只剩 target，且 base 引用已重挂
            const list = await manager.getCheckpoints(conversationId);
            expect(list.map(c => c.id)).toEqual(['cp-target']);
            expect(list[0].baseCheckpointId).toBeUndefined();
            // base 独有文件已并入 target 备份目录，base 目录已删除
            await expect(pathExists(path.join(storageRoot, 'checkpoints', 'cp-target', 'b.txt'))).resolves.toBe(true);
            await expect(pathExists(path.join(storageRoot, 'checkpoints', 'cp-base'))).resolves.toBe(false);
        } finally {
            await fs.rm(workspaceRoot, { recursive: true, force: true });
            await fs.rm(storageRoot, { recursive: true, force: true });
        }
    });

    test('deleteCheckpointsBatch deletes selected checkpoints across conversations', async () => {
        const workspaceRoot = await createTempDirectory('limcode-checkpoint-workspace-');
        const storageRoot = await createTempDirectory('limcode-checkpoint-storage-');
        const convA = 'conv-batch-a';
        const convB = 'conv-batch-b';
        const cpsA: CheckpointRecord[] = [0, 1].map(i => makeRecord({
            id: `a-${i}`, conversationId: convA, messageIndex: i, timestamp: 1000 + i
        }));
        const cpsB: CheckpointRecord[] = [0, 1].map(i => makeRecord({
            id: `b-${i}`, conversationId: convB, messageIndex: i, timestamp: 2000 + i
        }));

        try {
            for (const cp of [...cpsA, ...cpsB]) {
                await writeFile(path.join(storageRoot, 'checkpoints', cp.backupDir), 'x.txt', 'x\n');
            }
            const manager = await createCheckpointManager(workspaceRoot, storageRoot, [...cpsA, ...cpsB], [], {
                [convA]: cpsA,
                [convB]: cpsB
            });

            const results = await manager.deleteCheckpointsBatch([
                { conversationId: convA, checkpointIds: ['a-1'] },
                { conversationId: convB, checkpointIds: ['b-0', 'b-1'] }
            ]);

            expect(results).toHaveLength(2);
            expect(results[0]).toEqual({ conversationId: convA, deletedIds: ['a-1'], rejectedIds: [], success: true });
            expect(results[1]).toEqual({ conversationId: convB, deletedIds: ['b-0', 'b-1'], rejectedIds: [], success: true });

            const listA = await manager.getCheckpoints(convA);
            expect(listA.map(c => c.id)).toEqual(['a-0']);
            const listB = await manager.getCheckpoints(convB);
            expect(listB).toEqual([]);
            await expect(pathExists(path.join(storageRoot, 'checkpoints', 'a-1'))).resolves.toBe(false);
            await expect(pathExists(path.join(storageRoot, 'checkpoints', 'a-0'))).resolves.toBe(true);
        } finally {
            await fs.rm(workspaceRoot, { recursive: true, force: true });
            await fs.rm(storageRoot, { recursive: true, force: true });
        }
    });

    test('deleteCheckpointsBatch refuses base referenced by kept checkpoints', async () => {
        const workspaceRoot = await createTempDirectory('limcode-checkpoint-workspace-');
        const storageRoot = await createTempDirectory('limcode-checkpoint-storage-');
        const conversationId = 'conv-batch-refused';
        const baseCp = makeRecord({ id: 'cp-base', conversationId, timestamp: 1000 });
        const midCp = makeRecord({
            id: 'cp-mid', conversationId, messageIndex: 1, timestamp: 2000,
            type: 'incremental', baseCheckpointId: 'cp-base'
        });
        const tailCp = makeRecord({
            id: 'cp-tail', conversationId, messageIndex: 2, timestamp: 3000,
            type: 'incremental', baseCheckpointId: 'cp-mid'
        });

        try {
            for (const cp of [baseCp, midCp, tailCp]) {
                await writeFile(path.join(storageRoot, 'checkpoints', cp.backupDir), 'x.txt', 'x\n');
            }
            const manager = await createCheckpointManager(workspaceRoot, storageRoot, [baseCp, midCp, tailCp], []);

            // 只删 mid：被保留的 tail 引用为基快照，应拒绝
            const refused = await manager.deleteCheckpointsBatch([
                { conversationId, checkpointIds: ['cp-mid'] }
            ]);
            expect(refused[0]).toEqual({ conversationId, deletedIds: [], rejectedIds: ['cp-mid'], success: true });
            const list1 = await manager.getCheckpoints(conversationId);
            expect(list1.map(c => c.id)).toEqual(['cp-base', 'cp-mid', 'cp-tail']);

            // 同时删 mid + tail（整条链）：mid 虽被 tail 引用，但 tail 也在删除集合内，应全部删除
            const chained = await manager.deleteCheckpointsBatch([
                { conversationId, checkpointIds: ['cp-mid', 'cp-tail'] }
            ]);
            expect(chained[0].deletedIds.sort()).toEqual(['cp-mid', 'cp-tail']);
            expect(chained[0].rejectedIds).toEqual([]);
            const list2 = await manager.getCheckpoints(conversationId);
            expect(list2.map(c => c.id)).toEqual(['cp-base']);
            await expect(pathExists(path.join(storageRoot, 'checkpoints', 'cp-mid'))).resolves.toBe(false);
            await expect(pathExists(path.join(storageRoot, 'checkpoints', 'cp-tail'))).resolves.toBe(false);
        } finally {
            await fs.rm(workspaceRoot, { recursive: true, force: true });
            await fs.rm(storageRoot, { recursive: true, force: true });
        }
    });

    test('deleteCheckpointsBatch computes ancestor closure: kept tail protects the whole base chain', async () => {
        const workspaceRoot = await createTempDirectory('limcode-checkpoint-workspace-');
        const storageRoot = await createTempDirectory('limcode-checkpoint-storage-');
        const conversationId = 'conv-batch-closure';
        const cpA = makeRecord({ id: 'cp-a', conversationId, timestamp: 1000 });
        const cpB = makeRecord({
            id: 'cp-b', conversationId, messageIndex: 1, timestamp: 2000,
            type: 'incremental', baseCheckpointId: 'cp-a'
        });
        const cpC = makeRecord({
            id: 'cp-c', conversationId, messageIndex: 2, timestamp: 3000,
            type: 'incremental', baseCheckpointId: 'cp-b'
        });

        try {
            for (const cp of [cpA, cpB, cpC]) {
                await writeFile(path.join(storageRoot, 'checkpoints', cp.backupDir), 'x.txt', 'x\n');
            }
            const manager = await createCheckpointManager(workspaceRoot, storageRoot, [cpA, cpB, cpC], []);

            // 删除 {A, B} 但保留 C：C 依赖 B、B 依赖 A。
            // 旧实现只检查一层直接引用，会删 A 而保留 B → B 断链；
            // 闭包计算后 A、B 都被强制保留（CP-05）。
            const result = await manager.deleteCheckpointsBatch([
                { conversationId, checkpointIds: ['cp-a', 'cp-b'] }
            ]);
            expect(result[0].deletedIds).toEqual([]);
            expect(result[0].rejectedIds.sort()).toEqual(['cp-a', 'cp-b']);
            const list = await manager.getCheckpoints(conversationId);
            expect(list.map(c => c.id)).toEqual(['cp-a', 'cp-b', 'cp-c']);
        } finally {
            await fs.rm(workspaceRoot, { recursive: true, force: true });
            await fs.rm(storageRoot, { recursive: true, force: true });
        }
    });

    test('deleteCheckpointsBatch with empty checkpointIds deletes all in conversation', async () => {
        const workspaceRoot = await createTempDirectory('limcode-checkpoint-workspace-');
        const storageRoot = await createTempDirectory('limcode-checkpoint-storage-');
        const conversationId = 'conv-batch-all';
        const cps: CheckpointRecord[] = [0, 1].map(i => makeRecord({
            id: `cp-${i}`, conversationId, messageIndex: i, timestamp: 1000 + i
        }));

        try {
            for (const cp of cps) {
                await writeFile(path.join(storageRoot, 'checkpoints', cp.backupDir), 'x.txt', 'x\n');
            }
            const manager = await createCheckpointManager(workspaceRoot, storageRoot, cps, []);

            const results = await manager.deleteCheckpointsBatch([
                { conversationId, checkpointIds: [] }
            ]);

            expect(results[0].deletedIds.sort()).toEqual(['cp-0', 'cp-1']);
            expect(results[0].rejectedIds).toEqual([]);
            expect(await manager.getCheckpoints(conversationId)).toEqual([]);
            await expect(pathExists(path.join(storageRoot, 'checkpoints', 'cp-0'))).resolves.toBe(false);
            await expect(pathExists(path.join(storageRoot, 'checkpoints', 'cp-1'))).resolves.toBe(false);
        } finally {
            await fs.rm(workspaceRoot, { recursive: true, force: true });
            await fs.rm(storageRoot, { recursive: true, force: true });

        }
    });


    describe('CP-DEL-1 / CP-IDX-1 / CP-PREV-1（删除路径安全与链完整性）', () => {
        test('deleteCheckpoint refuses unsafe backupDir without touching out-of-bounds path', async () => {
            const workspaceRoot = await createTempDirectory('limcode-checkpoint-workspace-');
            const storageRoot = await createTempDirectory('limcode-checkpoint-storage-');
            const conversationId = 'conv-del-unsafe';
            const evilDir = `..${path.sep}outside`;
            const evilCp = makeRecord({ id: 'cp-evil', conversationId, timestamp: 1000, backupDir: evilDir });

            try {
                const outsideDir = path.join(storageRoot, 'outside');
                await writeFile(outsideDir, 'victim.txt', 'keep me');
                const manager = await createCheckpointManager(workspaceRoot, storageRoot, [evilCp], []);

                const deleted = await manager.deleteCheckpoint(conversationId, 'cp-evil');

                expect(deleted).toBe(false);
                // 记录保留（删除被拒绝），外部目录未被递归删除
                const list = await manager.getCheckpoints(conversationId);
                expect(list.map(c => c.id)).toEqual(['cp-evil']);
                await expect(fs.readFile(path.join(outsideDir, 'victim.txt'), 'utf-8')).resolves.toBe('keep me');
            } finally {
                await fs.rm(workspaceRoot, { recursive: true, force: true });
                await fs.rm(storageRoot, { recursive: true, force: true });
            }
        });

        test('deleteCheckpointsFromIndex keeps records with unsafe backupDir and deletes the rest', async () => {
            const workspaceRoot = await createTempDirectory('limcode-checkpoint-workspace-');
            const storageRoot = await createTempDirectory('limcode-checkpoint-storage-');
            const conversationId = 'conv-idx-unsafe';
            const evilCp = makeRecord({
                id: 'cp-evil', conversationId, messageIndex: 0, timestamp: 1000,
                backupDir: `..${path.sep}outside`
            });
            const okCp = makeRecord({ id: 'cp-ok', conversationId, messageIndex: 1, timestamp: 2000 });

            try {
                const outsideDir = path.join(storageRoot, 'outside');
                await writeFile(outsideDir, 'victim.txt', 'keep me');
                await writeFile(path.join(storageRoot, 'checkpoints', 'cp-ok'), 'x.txt', 'x');
                const manager = await createCheckpointManager(workspaceRoot, storageRoot, [evilCp, okCp], []);

                const deleted = await manager.deleteCheckpointsFromIndex(conversationId, 0);

                expect(deleted).toBe(1); // 只删 cp-ok；cp-evil 因 backupDir 越界被保留
                const list = await manager.getCheckpoints(conversationId);
                expect(list.map(c => c.id)).toEqual(['cp-evil']);
                await expect(pathExists(path.join(storageRoot, 'checkpoints', 'cp-ok'))).resolves.toBe(false);
                await expect(fs.readFile(path.join(outsideDir, 'victim.txt'), 'utf-8')).resolves.toBe('keep me');
            } finally {
                await fs.rm(workspaceRoot, { recursive: true, force: true });
                await fs.rm(storageRoot, { recursive: true, force: true });
            }
        });

        test('deleteAllCheckpoints keeps records with unsafe backupDir', async () => {
            const workspaceRoot = await createTempDirectory('limcode-checkpoint-workspace-');
            const storageRoot = await createTempDirectory('limcode-checkpoint-storage-');
            const conversationId = 'conv-all-unsafe';
            const evilCp = makeRecord({
                id: 'cp-evil', conversationId, messageIndex: 0, timestamp: 1000,
                backupDir: `..${path.sep}outside`
            });
            const okCp = makeRecord({ id: 'cp-ok', conversationId, messageIndex: 1, timestamp: 2000 });

            try {
                const outsideDir = path.join(storageRoot, 'outside');
                await writeFile(outsideDir, 'victim.txt', 'keep me');
                await writeFile(path.join(storageRoot, 'checkpoints', 'cp-ok'), 'x.txt', 'x');
                const manager = await createCheckpointManager(workspaceRoot, storageRoot, [evilCp, okCp], []);

                const result = await manager.deleteAllCheckpoints(conversationId);

                expect(result.success).toBe(true);
                expect(result.deletedCount).toBe(1); // cp-ok 已删，cp-evil 保留
                const list = await manager.getCheckpoints(conversationId);
                expect(list.map(c => c.id)).toEqual(['cp-evil']);
                await expect(pathExists(path.join(storageRoot, 'checkpoints', 'cp-ok'))).resolves.toBe(false);
                await expect(fs.readFile(path.join(outsideDir, 'victim.txt'), 'utf-8')).resolves.toBe('keep me');
            } finally {
                await fs.rm(workspaceRoot, { recursive: true, force: true });
                await fs.rm(storageRoot, { recursive: true, force: true });
            }
        });

        test('deleteCheckpointsBatch reports unsafe backupDir in rejectedIds', async () => {
            const workspaceRoot = await createTempDirectory('limcode-checkpoint-workspace-');
            const storageRoot = await createTempDirectory('limcode-checkpoint-storage-');
            const conversationId = 'conv-batch-unsafe';
            const evilCp = makeRecord({
                id: 'cp-evil', conversationId, messageIndex: 0, timestamp: 1000,
                backupDir: `..${path.sep}outside`
            });
            const okCp = makeRecord({ id: 'cp-ok', conversationId, messageIndex: 1, timestamp: 2000 });

            try {
                const outsideDir = path.join(storageRoot, 'outside');
                await writeFile(outsideDir, 'victim.txt', 'keep me');
                await writeFile(path.join(storageRoot, 'checkpoints', 'cp-ok'), 'x.txt', 'x');
                const manager = await createCheckpointManager(workspaceRoot, storageRoot, [evilCp, okCp], []);

                const results = await manager.deleteCheckpointsBatch([
                    { conversationId, checkpointIds: ['cp-evil', 'cp-ok'] }
                ]);

                expect(results[0].deletedIds).toEqual(['cp-ok']);
                expect(results[0].rejectedIds).toEqual(['cp-evil']);
                const list = await manager.getCheckpoints(conversationId);
                expect(list.map(c => c.id)).toEqual(['cp-evil']);
                await expect(pathExists(path.join(storageRoot, 'checkpoints', 'cp-ok'))).resolves.toBe(false);
                await expect(fs.readFile(path.join(outsideDir, 'victim.txt'), 'utf-8')).resolves.toBe('keep me');
            } finally {
                await fs.rm(workspaceRoot, { recursive: true, force: true });
                await fs.rm(storageRoot, { recursive: true, force: true });
            }
        });

        test('CP-IDX-1: index deletion keeps base chain of retained nodes when message index regresses (edit + retry)', async () => {
            const workspaceRoot = await createTempDirectory('limcode-checkpoint-workspace-');
            const storageRoot = await createTempDirectory('limcode-checkpoint-storage-');
            const conversationId = 'conv-idx-closure';
            // 序列：B(index=10) → 截断对话 → 重试产生 R(index=3, base=B) → 再次截断到 fromIndex=4。
            // 仅按索引判断会删 B（10>=4）而留 R（3<4）→ R 的 baseCheckpointId 悬空（永久断链）；
            // 祖先闭包必须强制保留 B。另有真正过期的 stale(index=5) 应被删除。
            const baseContent = 'base content\n';
            const targetContent = 'target content\n';
            const b = makeRecord({
                id: 'cp-b', conversationId, messageIndex: 10, timestamp: 1000, type: 'full',
                fileHashes: { 'a.txt': hashContent(baseContent) }
            });
            const r = makeRecord({
                id: 'cp-r', conversationId, messageIndex: 3, timestamp: 2000,
                type: 'incremental', baseCheckpointId: 'cp-b',
                fileHashes: { 'a.txt': hashContent(targetContent) },
                changes: [{ path: 'a.txt', type: 'modified', hash: hashContent(targetContent) }]
            });
            const stale = makeRecord({ id: 'cp-stale', conversationId, messageIndex: 5, timestamp: 3000 });

            try {
                await writeFile(workspaceRoot, 'a.txt', 'current\n');
                await writeFile(path.join(storageRoot, 'checkpoints', 'cp-b'), 'a.txt', baseContent);
                await writeFile(path.join(storageRoot, 'checkpoints', 'cp-r'), 'a.txt', targetContent);
                await writeFile(path.join(storageRoot, 'checkpoints', 'cp-stale'), 'x.txt', 'x');
                const manager = await createCheckpointManager(workspaceRoot, storageRoot, [b, r, stale], []);

                const deleted = await manager.deleteCheckpointsFromIndex(conversationId, 4);

                expect(deleted).toBe(1); // 只删 stale
                const list = await manager.getCheckpoints(conversationId);
                expect(list.map(c => c.id).sort()).toEqual(['cp-b', 'cp-r']);
                await expect(pathExists(path.join(storageRoot, 'checkpoints', 'cp-stale'))).resolves.toBe(false);
                // R 的恢复链完好：基快照 B 仍在，恢复不报 chainBroken
                const restore = await manager.restoreCheckpoint(conversationId, 'cp-r');
                expect(restore.success).toBe(true);
                await expect(fs.readFile(path.join(workspaceRoot, 'a.txt'), 'utf-8')).resolves.toBe(targetContent);
            } finally {
                await fs.rm(workspaceRoot, { recursive: true, force: true });
                await fs.rm(storageRoot, { recursive: true, force: true });
            }
        });

        test('CP-PREV-1: preview reports deleted (confirmed) and deletedIfUnconfirmed separately', async () => {
            const workspaceRoot = await createTempDirectory('limcode-checkpoint-workspace-');
            const storageRoot = await createTempDirectory('limcode-checkpoint-storage-');
            const conversationId = 'conv-preview-count';
            const checkpointId = 'cp-preview-count';
            const trackedContent = 'tracked v1\n';

            try {
                await writeFile(path.join(storageRoot, 'checkpoints', checkpointId), 'tracked.txt', trackedContent);
                // 工作区：tracked.txt 内容已变化 + untracked.txt 快照后新建
                await writeFile(workspaceRoot, 'tracked.txt', 'current changed\n');
                await writeFile(workspaceRoot, 'untracked.txt', 'new file\n');

                const checkpoint: CheckpointRecord = {
                    id: checkpointId,
                    conversationId,
                    messageIndex: 0,
                    toolName: 'write_file',
                    phase: 'after',
                    timestamp: Date.now(),
                    backupDir: checkpointId,
                    fileCount: 1,
                    contentHash: 'hash-preview-count',
                    type: 'full',
                    fileHashes: { 'tracked.txt': hashContent(trackedContent) },
                    emptyDirs: []
                };

                const manager = await createCheckpointManager(workspaceRoot, storageRoot, [checkpoint], []);
                const preview = await manager.previewRestore(conversationId, checkpointId);

                expect(preview.success).toBe(true);
                // untracked 默认保留：确认前实际只会删除 0 个文件
                expect(preview.deletedIfUnconfirmed).toBe(0);
                // 确认删除 untracked 后总数 = 1
                expect(preview.deleted).toBe(1);
                expect(preview.untrackedPaths).toEqual(['untracked.txt']);
            } finally {
                await fs.rm(workspaceRoot, { recursive: true, force: true });
                await fs.rm(storageRoot, { recursive: true, force: true });
            }
        });

        test('CP-LOCK-2: previewRestore runs without the global file write lock; restore acquires it', async () => {
            const workspaceRoot = await createTempDirectory('limcode-checkpoint-workspace-');
            const storageRoot = await createTempDirectory('limcode-checkpoint-storage-');
            const conversationId = 'conv-preview-lock';
            const checkpointId = 'cp-preview-lock';
            const trackedContent = 'tracked v1\n';

            try {
                const backupRoot = path.join(storageRoot, 'checkpoints', checkpointId);
                await writeFile(backupRoot, 'tracked.txt', trackedContent);
                // 工作区：tracked.txt（内容已变化）+ untracked.txt（快照后新建）
                await writeFile(workspaceRoot, 'tracked.txt', 'current changed\n');
                await writeFile(workspaceRoot, 'untracked.txt', 'new file\n');

                const checkpoint: CheckpointRecord = {
                    id: checkpointId,
                    conversationId,
                    messageIndex: 0,
                    toolName: 'write_file',
                    phase: 'after',
                    timestamp: Date.now(),
                    backupDir: checkpointId,
                    fileCount: 1,
                    contentHash: 'hash-preview-lock',
                    type: 'full',
                    fileHashes: { 'tracked.txt': hashContent(trackedContent) },
                    emptyDirs: []
                };

                const manager = await createCheckpointManager(workspaceRoot, storageRoot, [checkpoint], []);
                const acquireSpy = jest.spyOn(fileWriteLockManager, 'acquire');

                try {
                    // 预览是纯计算：不得 acquire 全局文件写锁（否则扫描/哈希期间阻塞全部写工具）
                    const preview = await manager.previewRestore(conversationId, checkpointId);
                    expect(preview.success).toBe(true);
                    expect(preview.restored).toBe(1);
                    expect(acquireSpy).not.toHaveBeenCalled();

                    // 对照：真正执行恢复仍必须取全局文件写锁
                    const restore = await manager.restoreCheckpoint(conversationId, checkpointId);
                    expect(restore.success).toBe(true);
                    expect(acquireSpy).toHaveBeenCalled();
                } finally {
                    acquireSpy.mockRestore();
                }
            } finally {
                await fs.rm(workspaceRoot, { recursive: true, force: true });
                await fs.rm(storageRoot, { recursive: true, force: true });
            }
        });
    });
    test('getCheckpoints withSize attaches backup dir sizes', async () => {
        const workspaceRoot = await createTempDirectory('limcode-checkpoint-workspace-');
        const storageRoot = await createTempDirectory('limcode-checkpoint-storage-');
        const conversationId = 'conv-with-size';
        const cp = makeRecord({ id: 'cp-size', conversationId, timestamp: 1000 });

        try {
            // 5 字节文件
            await writeFile(path.join(storageRoot, 'checkpoints', 'cp-size'), 'a.txt', 'hello');
            const manager = await createCheckpointManager(workspaceRoot, storageRoot, [cp], []);

            const withSize = await manager.getCheckpoints(conversationId, { withSize: true });
            expect(withSize).toHaveLength(1);
            expect(withSize[0].size).toBe(5);
            expect(withSize[0].id).toBe('cp-size');

            // 不带 withSize 时保持原结构，无 size 字段
            const plain = await manager.getCheckpoints(conversationId);
            expect(plain[0].size).toBeUndefined();
        } finally {
            await fs.rm(workspaceRoot, { recursive: true, force: true });
            await fs.rm(storageRoot, { recursive: true, force: true });
        }
    });

    test('restore returns unbackedPaths as display paths and keeps them untouched', async () => {
        const workspaceRoot = await createTempDirectory('limcode-checkpoint-workspace-');
        const storageRoot = await createTempDirectory('limcode-checkpoint-storage-');
        const conversationId = 'conv-unbacked';
        const checkpointId = 'cp-unbacked';
        const visibleContent = 'backed content\n';

        try {
            await writeFile(workspaceRoot, 'a.txt', 'workspace current\n');
            await writeFile(workspaceRoot, 'big.bin', 'huge content\n');

            const checkpoint: CheckpointRecord = {
                id: checkpointId,
                conversationId,
                messageIndex: 0,
                toolName: 'write_file',
                phase: 'after',
                timestamp: Date.now(),
                backupDir: checkpointId,
                fileCount: 1,
                contentHash: 'hash-unbacked',
                type: 'full',
                fileHashes: {
                    'a.txt': hashContent(visibleContent)
                },
                emptyDirs: [],
                unbackedPaths: ['big.bin']
            };

            const backupRoot = path.join(storageRoot, 'checkpoints', checkpointId);
            await writeFile(backupRoot, 'a.txt', visibleContent);

            const manager = await createCheckpointManager(workspaceRoot, storageRoot, [checkpoint], []);
            const result = await manager.restoreCheckpoint(conversationId, checkpointId);

            expect(result.success).toBe(true);
            expect(result.unbackedPaths).toEqual(['big.bin']);
            // 未备份文件受保护：恢复后仍存在
            await expect(pathExists(path.join(workspaceRoot, 'big.bin'))).resolves.toBe(true);
        } finally {
            await fs.rm(workspaceRoot, { recursive: true, force: true });
            await fs.rm(storageRoot, { recursive: true, force: true });
        }
    });

    test('previewRestore returns deletion lists without executing; confirmed restore deletes untracked files (CP-09)', async () => {
        const workspaceRoot = await createTempDirectory('limcode-checkpoint-workspace-');
        const storageRoot = await createTempDirectory('limcode-checkpoint-storage-');
        const conversationId = 'conv-preview';
        const checkpointId = 'cp-preview';
        const trackedContent = 'tracked v1\n';

        try {
            const backupRoot = path.join(storageRoot, 'checkpoints', checkpointId);
            await writeFile(backupRoot, 'tracked.txt', trackedContent);

            // 工作区：tracked.txt（内容已变化）+ untracked.txt（快照后新建）
            await writeFile(workspaceRoot, 'tracked.txt', 'current changed\n');
            await writeFile(workspaceRoot, 'untracked.txt', 'new file\n');

            const checkpoint: CheckpointRecord = {
                id: checkpointId,
                conversationId,
                messageIndex: 0,
                toolName: 'write_file',
                phase: 'after',
                timestamp: Date.now(),
                backupDir: checkpointId,
                fileCount: 1,
                contentHash: 'hash-preview',
                type: 'full',
                fileHashes: {
                    'tracked.txt': hashContent(trackedContent)
                },
                emptyDirs: []
            };

            const manager = await createCheckpointManager(workspaceRoot, storageRoot, [checkpoint], []);

            // 预览：tracked.txt 将修改（restored=1）；untracked.txt 是快照后新建 → untrackedPaths
            const preview = await manager.previewRestore(conversationId, checkpointId);
            expect(preview.success).toBe(true);
            expect(preview.restored).toBe(1);
            expect(preview.deletablePaths).toEqual([]);
            expect(preview.untrackedPaths).toEqual(['untracked.txt']);
            expect(preview.deleted).toBe(1);

            // 预览无副作用：文件都还在
            await expect(pathExists(path.join(workspaceRoot, 'tracked.txt'))).resolves.toBe(true);
            await expect(pathExists(path.join(workspaceRoot, 'untracked.txt'))).resolves.toBe(true);

            // 未确认（默认 deleteUntrackedFiles=false）：恢复后 untracked.txt 保留（#29 保护）
            const resultDefault = await manager.restoreCheckpoint(conversationId, checkpointId);
            expect(resultDefault.success).toBe(true);
            expect(resultDefault.deleted).toBe(0);
            await expect(pathExists(path.join(workspaceRoot, 'untracked.txt'))).resolves.toBe(true);

            // 确认删除快照后新建文件：untracked.txt 被删除
            const resultConfirmed = await manager.restoreCheckpoint(conversationId, checkpointId, { deleteUntrackedFiles: true });
            expect(resultConfirmed.success).toBe(true);
            expect(resultConfirmed.deleted).toBe(1);
            await expect(pathExists(path.join(workspaceRoot, 'untracked.txt'))).resolves.toBe(false);
        } finally {
            await fs.rm(workspaceRoot, { recursive: true, force: true });
            await fs.rm(storageRoot, { recursive: true, force: true });
        }
    });

    test('previewRestore prunes orphan backup dirs without any record references', async () => {
        const workspaceRoot = await createTempDirectory('limcode-checkpoint-workspace-');
        const storageRoot = await createTempDirectory('limcode-checkpoint-storage-');
        const conversationId = 'conv-orphan';
        const checkpointId = 'cp-orphan';
        const orphanDir = 'cp_orphan_residue';
        const visibleContent = 'hello\n';

        try {
            await writeFile(workspaceRoot, 'a.txt', 'workspace current\n');

            const checkpoint: CheckpointRecord = {
                id: checkpointId,
                conversationId,
                messageIndex: 0,
                toolName: 'write_file',
                phase: 'after',
                timestamp: Date.now(),
                backupDir: checkpointId,
                fileCount: 1,
                contentHash: 'hash-orphan',
                type: 'full',
                fileHashes: { 'a.txt': hashContent(visibleContent) },
                emptyDirs: []
            };

            const backupRoot = path.join(storageRoot, 'checkpoints', checkpointId);
            await writeFile(backupRoot, 'a.txt', visibleContent);
            // 构造孤儿目录（磁盘存在但无任何记录引用，如删除失败残留）
            await writeFile(path.join(storageRoot, 'checkpoints', orphanDir), 'junk.txt', 'junk');

            const manager = await createCheckpointManager(workspaceRoot, storageRoot, [checkpoint], []);
            await manager.previewRestore(conversationId, checkpointId);

            // 孤儿目录被清理，正常存档目录保留
            await expect(pathExists(path.join(storageRoot, 'checkpoints', orphanDir))).resolves.toBe(false);
            await expect(pathExists(path.join(storageRoot, 'checkpoints', checkpointId))).resolves.toBe(true);
        } finally {
            await fs.rm(workspaceRoot, { recursive: true, force: true });
            await fs.rm(storageRoot, { recursive: true, force: true });
        }
    });

    test('H-1: restore honors the four-layer exclusion model (default categories + storage root)', async () => {
        const workspaceRoot = await createTempDirectory('limcode-checkpoint-workspace-');
        // 存储根放在工作区内：同时验证强制排除绝对路径（存储根）在恢复侧生效
        const storageRoot = path.join(workspaceRoot, '.limcode');
        const conversationId = 'conv-h1';
        const checkpointId = 'cp-h1';
        const excludedDistContent = 'backup dist content\n';
        const excludedDataContent = 'backup data content\n';
        const visibleContent = 'visible content\n';

        try {
            // 当前工作区：dist/（buildArtifacts 类别）与 data/（datasets 类别）是当前明确排除路径
            await writeFile(workspaceRoot, 'dist/bundle.js', 'current dist\n');
            await writeFile(workspaceRoot, 'data/raw.csv', 'current data\n');
            await writeFile(workspaceRoot, 'visible.txt', 'current visible\n');

            const checkpoint: CheckpointRecord = {
                id: checkpointId,
                conversationId,
                messageIndex: 0,
                toolName: 'write_file',
                phase: 'after',
                timestamp: Date.now(),
                backupDir: checkpointId,
                fileCount: 3,
                contentHash: 'hash-h1',
                type: 'full',
                fileHashes: {
                    'dist/bundle.js': hashContent(excludedDistContent),
                    'data/raw.csv': hashContent(excludedDataContent),
                    'visible.txt': hashContent(visibleContent)
                },
                emptyDirs: []
            };

            const backupRoot = path.join(storageRoot, 'checkpoints', checkpointId);
            await writeFile(backupRoot, 'dist/bundle.js', excludedDistContent);
            await writeFile(backupRoot, 'data/raw.csv', excludedDataContent);
            await writeFile(backupRoot, 'visible.txt', visibleContent);

            const manager = await createCheckpointManager(workspaceRoot, storageRoot, [checkpoint], []);
            // 开启默认类别 buildArtifacts / datasets（其余关闭）——恢复必须服从当前四层排除模型
            ((manager as any).settingsManager.getCheckpointConfig as jest.Mock).mockReturnValue({
                enabled: true,
                beforeTools: [],
                afterTools: [],
                messageCheckpoint: { beforeMessages: [], afterMessages: [] },
                maxCheckpoints: -1,
                customIgnorePatterns: [],
                exclusion: {
                    enabledProfiles: {
                        buildArtifacts: true,
                        datasets: true,
                        logs: false,
                        aiModels: false,
                        caches: false,
                        pythonVenvs: false,
                        largeMedia: false,
                        archives: false
                    },
                    maxFileSizeBytes: 0,
                    customPatterns: []
                }
            });

            const result = await manager.restoreCheckpoint(conversationId, checkpointId);
            expect(result.success).toBe(true);
            // 只有 visible.txt 被恢复；dist/ 与 data/ 下的文件（当前明确排除）不得被写回或删除
            expect(result.restored).toBe(1);
            await expect(fs.readFile(path.join(workspaceRoot, 'visible.txt'), 'utf-8')).resolves.toBe(visibleContent);
            await expect(fs.readFile(path.join(workspaceRoot, 'dist/bundle.js'), 'utf-8')).resolves.toBe('current dist\n');
            await expect(fs.readFile(path.join(workspaceRoot, 'data/raw.csv'), 'utf-8')).resolves.toBe('current data\n');
        } finally {
            await fs.rm(workspaceRoot, { recursive: true, force: true });
        }
    });
});

describe('CheckpointManager path safety regressions', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    function makeRecord(overrides: Partial<CheckpointRecord> & { id: string }): CheckpointRecord {
        return {
            conversationId: 'conv',
            messageIndex: 0,
            toolName: 'write_file',
            phase: 'after',
            timestamp: 1000,
            backupDir: overrides.id,
            fileCount: 0,
            contentHash: 'h',
            type: 'full',
            ...overrides
        };
    }

    test('restore drops fileHashes entries with parent traversal segments', async () => {
        const workspaceRoot = await createTempDirectory('limcode-checkpoint-workspace-');
        const storageRoot = await createTempDirectory('limcode-checkpoint-storage-');
        const conversationId = 'conv-unsafe-hashes';
        const checkpointId = 'cp-unsafe-hashes';

        try {
            // 工作区外的目标文件：如果 fileHashes 里的 '../' 键被放行，
            // restore 会 path.join(workspaceRoot, '../evil.txt') 写穿工作区。
            const outsideDir = path.dirname(workspaceRoot);
            const outsideTarget = path.join(outsideDir, 'evil.txt');
            await writeFile(workspaceRoot, 'inside.txt', 'keep');
            await writeFile(outsideDir, 'evil.txt', 'outside original');

            const checkpoint: CheckpointRecord = {
                id: checkpointId,
                conversationId,
                messageIndex: 0,
                toolName: 'apply_diff',
                phase: 'after',
                timestamp: Date.now(),
                backupDir: checkpointId,
                fileCount: 2,
                contentHash: 'hash-unsafe',
                type: 'full',
                fileHashes: {
                    'inside.txt': hashContent('keep'),
                    '../evil.txt': hashContent('evil')
                },
                emptyDirs: ['../outside-dir']
            };

            const backupRoot = path.join(storageRoot, 'checkpoints', checkpointId);
            await writeFile(backupRoot, 'inside.txt', 'keep');
            await writeFile(backupRoot, '../evil.txt', 'evil');

            const manager = await createCheckpointManager(workspaceRoot, storageRoot, [checkpoint], []);

            const result = await manager.restoreCheckpoint(conversationId, checkpointId);
            expect(result.success).toBe(true);
            // 工作区外文件绝不能被写入或创建
            await expect(fs.readFile(outsideTarget, 'utf-8')).resolves.toBe('outside original');
            await expect(pathExists(path.join(outsideDir, 'outside-dir'))).resolves.toBe(false);
        } finally {
            await fs.rm(workspaceRoot, { recursive: true, force: true });
            await fs.rm(path.join(path.dirname(workspaceRoot), 'evil.txt'), { force: true });
            await fs.rm(storageRoot, { recursive: true, force: true });
        }
    });

    test('createCheckpoint keeps the snapshot complete when mtimeNs is unavailable', async () => {
        const workspaceRoot = await createTempDirectory('limcode-checkpoint-workspace-');
        const storageRoot = await createTempDirectory('limcode-checkpoint-storage-');
        const conversationId = 'conv-mtime-ns';

        try {
            await writeFile(workspaceRoot, 'a.txt', 'hello world\n');
            await writeFile(workspaceRoot, 'sub/b.txt', 'nested\n');

            const manager = await createCheckpointManager(workspaceRoot, storageRoot, [], []);
            // 启用 apply_diff 的 after 检查点，否则 createCheckpoint 会因配置为空直接返回 null
            (manager as any).settingsManager.getCheckpointConfig = jest.fn().mockReturnValue({
                enabled: true,
                beforeTools: [],
                afterTools: ['apply_diff'],
                messageCheckpoint: { beforeMessages: [], afterMessages: [] },
                maxCheckpoints: -1,
                customIgnorePatterns: []
            });
            // 覆盖 getCheckpoints，模拟「上一次检查点 fileStats 带 mtimeNs: undefined」的旧记录，
            // 走创建路径验证 stat 复用分支不会抛错导致文件被静默剔除。
            (manager as any).getCheckpoints = jest.fn().mockResolvedValue([{
                ...makeRecord({ id: 'cp-prev', conversationId, timestamp: 1 }),
                type: 'incremental',
                fileHashes: {
                    'a.txt': hashContent('hello world\n'),
                    'sub/b.txt': hashContent('nested\n')
                },
                fileStats: {
                    'a.txt': { mtimeMs: 123, size: 12, mtimeNs: undefined },
                    'sub/b.txt': { mtimeMs: 456, size: 7, mtimeNs: undefined }
                }
            }]);

            const created = await manager.createCheckpoint(conversationId, 0, 'apply_diff', 'after');
            expect(created).not.toBeNull();
            // 文件必须全部进入快照（之前 mtimeNs undefined 会抛 TypeError 被吞掉，文件整体漏出）；
            // 上游新格式 fileHashes 键为 scoped 布局（ws_xxx/ 前缀），按后缀匹配
            const hashKeys = Object.keys(created!.fileHashes || {});
            expect(hashKeys.some(k => k === 'a.txt' || k.endsWith('/a.txt'))).toBe(true);
            expect(hashKeys.some(k => k === 'sub/b.txt' || k.endsWith('/sub/b.txt'))).toBe(true);
            const aKey = hashKeys.find(k => k === 'a.txt' || k.endsWith('/a.txt'))!;
            expect(created!.fileHashes![aKey]).toBe(hashContent('hello world\n'));
        } finally {
            await fs.rm(workspaceRoot, { recursive: true, force: true });
            await fs.rm(storageRoot, { recursive: true, force: true });
        }
    });
});

    // ==================== BCP-01：createCheckpoint 关联 messageNodeId ====================

    describe('BCP-01: createCheckpoint messageNodeId 关联', () => {
        beforeEach(() => {
            jest.clearAllMocks();
        });

        test('options.messageNodeId 写入记录并透传到摘要（getCheckpoints 回读）', async () => {
            const workspaceRoot = await createTempDirectory('limcode-checkpoint-bcp01-');
            const storageRoot = await createTempDirectory('limcode-checkpoint-bcp01-storage-');
            try {
                const manager = await createCheckpointManager(workspaceRoot, storageRoot, [], []);
                // 把 write_file 加入 after 配置，否则 createCheckpoint 直接跳过
                ((manager as any).settingsManager.getCheckpointConfig as jest.Mock).mockReturnValue({
                    enabled: true,
                    beforeTools: ['write_file'],
                    afterTools: ['write_file'],
                    messageCheckpoint: { beforeMessages: [], afterMessages: [] },
                    maxCheckpoints: -1,
                    customIgnorePatterns: []
                });

                const cp = await manager.createCheckpoint('conv-bcp01', 3, 'write_file', 'after', {
                    messageNodeId: 'node-abc'
                });
                expect(cp).not.toBeNull();
                expect(cp!.messageNodeId).toBe('node-abc');
                expect(cp!.messageIndex).toBe(3); // index 定位语义不回退

                // 持久化后经查询服务回读：摘要同样透出 messageNodeId
                const summaries = await manager.getCheckpoints('conv-bcp01');
                expect(summaries).toHaveLength(1);
                expect(summaries[0].messageNodeId).toBe('node-abc');
                expect(summaries[0].messageIndex).toBe(3);
            } finally {
                await fs.rm(workspaceRoot, { recursive: true, force: true });
                await fs.rm(storageRoot, { recursive: true, force: true });
            }
        });

        test('不传 messageNodeId：记录与摘要无该字段（旧存档兼容）', async () => {
            const workspaceRoot = await createTempDirectory('limcode-checkpoint-bcp01-');
            const storageRoot = await createTempDirectory('limcode-checkpoint-bcp01-storage-');
            try {
                const manager = await createCheckpointManager(workspaceRoot, storageRoot, [], []);
                ((manager as any).settingsManager.getCheckpointConfig as jest.Mock).mockReturnValue({
                    enabled: true,
                    beforeTools: ['write_file'],
                    afterTools: ['write_file'],
                    messageCheckpoint: { beforeMessages: [], afterMessages: [] },
                    maxCheckpoints: -1,
                    customIgnorePatterns: []
                });

                const cp = await manager.createCheckpoint('conv-bcp01', 3, 'write_file', 'after');
                expect(cp).not.toBeNull();
                expect(cp!.messageNodeId).toBeUndefined();

                const summaries = await manager.getCheckpoints('conv-bcp01');
                expect(summaries).toHaveLength(1);
                expect(summaries[0].messageNodeId).toBeUndefined();
                expect(summaries[0].messageIndex).toBe(3);
            } finally {
                await fs.rm(workspaceRoot, { recursive: true, force: true });
                await fs.rm(storageRoot, { recursive: true, force: true });
            }
        });
    });
});
