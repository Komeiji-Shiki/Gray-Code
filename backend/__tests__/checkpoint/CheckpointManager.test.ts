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
    customIgnorePatterns: string[] = []
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

    const metadata = { custom: { checkpoints: [...checkpoints] } };
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
    const conversationManager = {
        getMetadata: jest.fn().mockResolvedValue(metadata),
        setCustomMetadata: jest.fn().mockImplementation(async (_conversationId: string, key: string, value: unknown) => {
            (metadata.custom as Record<string, unknown>)[key] = value;
        }),
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
});
