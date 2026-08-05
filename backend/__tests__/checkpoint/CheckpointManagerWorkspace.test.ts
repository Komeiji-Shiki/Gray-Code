/**
 * CheckpointManager 工作区边界集成测试
 *
 * 覆盖 CP-01 / CP-02 / CP-07 / CP-14 的行为：
 * - 多根工作区创建：每个根的文件都进入快照（scoped 键 + scoped 备份布局）
 * - 多根工作区恢复：修改过的文件按根恢复
 * - 工作区身份校验：跨项目恢复被拒绝（workspaceMismatch）
 * - 存档自排除：存档目录位于工作区内时不被再次备份
 * - 多根下旧格式存档（相对路径键）明确拒绝恢复
 * - unbackedPaths 记录的文件恢复时不会被删除
 */
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

async function createTempDirectory(prefix: string): Promise<string> {
    return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writeFile(rootDir: string, relativePath: string, content: string = ''): Promise<void> {
    const fullPath = path.join(rootDir, relativePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content, 'utf-8');
}

function md5(content: string): string {
    return crypto.createHash('md5').update(content).digest('hex');
}

interface CreateManagerOptions {
    workspaceRoots: string[];
    storageRoot: string;
    checkpoints?: CheckpointRecord[];
    customIgnorePatterns?: string[];
    /** 多工作区并发支持：对话绑定的工作区 URI（测试只对指定对话返回该元数据） */
    boundWorkspaceUri?: string;
}

async function createCheckpointManager(options: CreateManagerOptions): Promise<CheckpointManager> {
    (vscode.workspace as any).workspaceFolders = options.workspaceRoots.map(fsPath => ({
        name: path.basename(fsPath),
        uri: { fsPath, scheme: 'file', path: fsPath }
    }));
    (vscode.workspace as any).textDocuments = [];
    (vscode as any).window = {
        setStatusBarMessage: jest.fn(),
        showTextDocument: jest.fn(),
        tabGroups: { all: [], close: jest.fn() }
    };
    (vscode.commands.executeCommand as jest.Mock).mockResolvedValue(undefined);

    const sharedMetadata = { custom: { checkpoints: [...(options.checkpoints ?? [])] } };

    const settingsManager = {
        getCheckpointConfig: jest.fn().mockReturnValue({
            enabled: true,
            beforeTools: [],
            afterTools: ['write_file'],
            messageCheckpoint: { beforeMessages: [], afterMessages: [] },
            maxCheckpoints: -1,
            customIgnorePatterns: options.customIgnorePatterns ?? []
        })
    };
    let metadataWriteChain: Promise<unknown> = Promise.resolve();
    const conversationManager = {
        getMetadata: jest.fn().mockImplementation(async (conversationId: string) => {
            // 多工作区并发支持：绑定工作区的对话返回其 workspaceUri，否则返回共享元数据（未绑定）
            if (options.boundWorkspaceUri) {
                return { workspaceUri: options.boundWorkspaceUri };
            }
            return sharedMetadata;
        }),
        getCustomMetadata: jest.fn().mockImplementation(async (conversationId: string, key: string) => {
            return (sharedMetadata.custom as Record<string, unknown>)[key];
        }),
        setCustomMetadata: jest.fn().mockImplementation(async (conversationId: string, key: string, value: unknown) => {
            (sharedMetadata.custom as Record<string, unknown>)[key] = value;
        }),
        updateCustomMetadata: jest.fn().mockImplementation(
            (conversationId: string, key: string, updater: (current: unknown) => unknown | Promise<unknown>) => {
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
        { globalStorageUri: { fsPath: options.storageRoot } } as any
    );
    await manager.initialize();
    return manager;
}

/** 切换当前窗口的工作区根（模拟打开另一个项目） */
function setWorkspaceFolders(workspaceRoots: string[]): void {
    (vscode.workspace as any).workspaceFolders = workspaceRoots.map(fsPath => ({
        name: path.basename(fsPath),
        uri: { fsPath, scheme: 'file', path: fsPath }
    }));
}

describe('CheckpointManager workspace boundaries (CP-01/CP-02/CP-07)', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('creates checkpoint across multiple workspace roots with scoped layout', async () => {
        const rootA = await createTempDirectory('limcode-cp-root-a-');
        const rootB = await createTempDirectory('limcode-cp-root-b-');
        const storageRoot = await createTempDirectory('limcode-cp-storage-');
        const conversationId = 'conv-multi-root-create';

        try {
            await writeFile(rootA, 'a.txt', 'a1\n');
            await writeFile(rootB, 'b.txt', 'b1\n');

            const manager = await createCheckpointManager({ workspaceRoots: [rootA, rootB], storageRoot });
            const cp = await manager.createCheckpoint(conversationId, 0, 'write_file', 'after');

            expect(cp).not.toBeNull();
            // 两个根的文件都进入 fileHashes（scoped 键）
            const keys = Object.keys(cp!.fileHashes!).sort();
            expect(keys).toHaveLength(2);
            const keyA = keys.find(k => k.endsWith('/a.txt'))!;
            const keyB = keys.find(k => k.endsWith('/b.txt'))!;
            expect(keyA).not.toBe(keyB);

            // 记录携带工作区身份元数据
            expect(cp!.workspaceRoots?.length).toBe(2);
            expect(cp!.workspaceFingerprint).toBeDefined();

            // 备份文件位于 scoped 布局：cp_xxx/ws_xxx/a.txt
            const backupRoot = path.join(storageRoot, 'checkpoints', cp!.backupDir);
            const [rootIdA] = keyA.split('/');
            const [rootIdB] = keyB.split('/');
            await expect(fs.access(path.join(backupRoot, rootIdA, 'a.txt'))).resolves.toBeUndefined();
            await expect(fs.access(path.join(backupRoot, rootIdB, 'b.txt'))).resolves.toBeUndefined();
        } finally {
            await fs.rm(rootA, { recursive: true, force: true });
            await fs.rm(rootB, { recursive: true, force: true });
            await fs.rm(storageRoot, { recursive: true, force: true });
        }
    });

    test('restores both workspace roots from the chain', async () => {
        const rootA = await createTempDirectory('limcode-cp-root-a-');
        const rootB = await createTempDirectory('limcode-cp-root-b-');
        const storageRoot = await createTempDirectory('limcode-cp-storage-');
        const conversationId = 'conv-multi-root-restore';

        try {
            await writeFile(rootA, 'a.txt', 'a1\n');
            await writeFile(rootB, 'b.txt', 'b1\n');

            const manager = await createCheckpointManager({ workspaceRoots: [rootA, rootB], storageRoot });
            const cp = await manager.createCheckpoint(conversationId, 0, 'write_file', 'after');
            expect(cp).not.toBeNull();

            // 两个根都被修改，然后恢复到存档点
            await writeFile(rootA, 'a.txt', 'a2\n');
            await writeFile(rootB, 'b.txt', 'b2\n');
            await manager.createCheckpoint(conversationId, 0, 'write_file', 'after');

            const result = await manager.restoreCheckpoint(conversationId, cp!.id);
            expect(result.success).toBe(true);
            await expect(fs.readFile(path.join(rootA, 'a.txt'), 'utf-8')).resolves.toBe('a1\n');
            await expect(fs.readFile(path.join(rootB, 'b.txt'), 'utf-8')).resolves.toBe('b1\n');
        } finally {
            await fs.rm(rootA, { recursive: true, force: true });
            await fs.rm(rootB, { recursive: true, force: true });
            await fs.rm(storageRoot, { recursive: true, force: true });
        }
    });

    test('refuses restore when current workspace does not match the checkpoint', async () => {
        const rootA = await createTempDirectory('limcode-cp-root-a-');
        const rootB = await createTempDirectory('limcode-cp-root-b-');
        const storageRoot = await createTempDirectory('limcode-cp-storage-');
        const conversationId = 'conv-workspace-mismatch';

        try {
            await writeFile(rootA, 'a.txt', 'a1\n');
            const manager = await createCheckpointManager({ workspaceRoots: [rootA], storageRoot });
            const cp = await manager.createCheckpoint(conversationId, 0, 'write_file', 'after');
            expect(cp).not.toBeNull();

            // 模拟打开另一个项目：工作区根从 rootA 变成 rootB
            setWorkspaceFolders([rootB]);
            const result = await manager.restoreCheckpoint(conversationId, cp!.id);

            expect(result.success).toBe(false);
            expect(result.error).toBeDefined();
            expect(result.restored).toBe(0);
            // rootB 不应被写入任何内容
            const entries = await fs.readdir(rootB);
            expect(entries).toHaveLength(0);
        } finally {
            await fs.rm(rootA, { recursive: true, force: true });
            await fs.rm(rootB, { recursive: true, force: true });
            await fs.rm(storageRoot, { recursive: true, force: true });
        }
    });

    test('does not back up its own checkpoint storage when inside the workspace', async () => {
        const workspaceRoot = await createTempDirectory('limcode-cp-self-exclude-');
        // 存档目录位于工作区内部
        const storageRoot = path.join(workspaceRoot, '.limcode-storage');
        const conversationId = 'conv-self-exclude';

        try {
            await writeFile(workspaceRoot, 'app.txt', 'app\n');
            // 扩展存储下的其他数据（memory 等）：同样绝不能进入存档
            await writeFile(storageRoot, 'memory/mem.json', 'memory data\n');
            const manager = await createCheckpointManager({ workspaceRoots: [workspaceRoot], storageRoot });
            const cp = await manager.createCheckpoint(conversationId, 0, 'write_file', 'after');

            expect(cp).not.toBeNull();
            const keys = Object.keys(cp!.fileHashes!);
            expect(keys.some(k => k.includes('.limcode-storage'))).toBe(false);
            expect(keys.some(k => k.endsWith('/app.txt'))).toBe(true);
        } finally {
            await fs.rm(workspaceRoot, { recursive: true, force: true });
        }
    });

    test('refuses legacy relative-path checkpoint in multi-root workspace', async () => {
        const rootA = await createTempDirectory('limcode-cp-root-a-');
        const rootB = await createTempDirectory('limcode-cp-root-b-');
        const storageRoot = await createTempDirectory('limcode-cp-storage-');
        const conversationId = 'conv-legacy-multi-root';

        try {
            // 旧格式记录：相对路径键 + 旧备份布局
            const legacyCp: CheckpointRecord = {
                id: 'cp-legacy',
                conversationId,
                messageIndex: 0,
                toolName: 'write_file',
                phase: 'after',
                timestamp: Date.now(),
                backupDir: 'cp-legacy',
                fileCount: 1,
                contentHash: 'h',
                type: 'full',
                fileHashes: { 'legacy.txt': md5('legacy\n') }
            };
            await writeFile(path.join(storageRoot, 'checkpoints', 'cp-legacy'), 'legacy.txt', 'legacy\n');

            const manager = await createCheckpointManager({
                workspaceRoots: [rootA, rootB],
                storageRoot,
                checkpoints: [legacyCp]
            });
            const result = await manager.restoreCheckpoint(conversationId, 'cp-legacy');

            expect(result.success).toBe(false);
            expect(result.error).toBeDefined();
        } finally {
            await fs.rm(rootA, { recursive: true, force: true });
            await fs.rm(rootB, { recursive: true, force: true });
            await fs.rm(storageRoot, { recursive: true, force: true });
        }
    });

    test('restore never deletes files recorded as unbacked', async () => {
        const workspaceRoot = await createTempDirectory('limcode-cp-unbacked-');
        const storageRoot = await createTempDirectory('limcode-cp-storage-');
        const conversationId = 'conv-unbacked';

        try {
            await writeFile(workspaceRoot, 'tracked.txt', 'current\n');
            await writeFile(workspaceRoot, 'unbacked.txt', 'keep me\n');

            // unbacked.txt 快照时可见但备份失败：既不在 fileHashes（正常流程），
            // 又被记录进 unbackedPaths —— 恢复时绝不能删除
            const cp: CheckpointRecord = {
                id: 'cp-unbacked',
                conversationId,
                messageIndex: 0,
                toolName: 'write_file',
                phase: 'after',
                timestamp: Date.now(),
                backupDir: 'cp-unbacked',
                fileCount: 1,
                contentHash: 'h',
                type: 'full',
                fileHashes: { 'tracked.txt': md5('target\n') },
                unbackedPaths: ['unbacked.txt']
            };
            await writeFile(path.join(storageRoot, 'checkpoints', 'cp-unbacked'), 'tracked.txt', 'target\n');

            const manager = await createCheckpointManager({
                workspaceRoots: [workspaceRoot],
                storageRoot,
                checkpoints: [cp]
            });
            const result = await manager.restoreCheckpoint(conversationId, 'cp-unbacked');

            expect(result.success).toBe(true);
            await expect(fs.readFile(path.join(workspaceRoot, 'tracked.txt'), 'utf-8')).resolves.toBe('target\n');
            await expect(fs.readFile(path.join(workspaceRoot, 'unbacked.txt'), 'utf-8')).resolves.toBe('keep me\n');
        } finally {
            await fs.rm(workspaceRoot, { recursive: true, force: true });
            await fs.rm(storageRoot, { recursive: true, force: true });
        }
    });

    test('new checkpoint after switching workspace starts a fresh full chain', async () => {
        const rootA = await createTempDirectory('limcode-cp-root-a-');
        const rootB = await createTempDirectory('limcode-cp-root-b-');
        const storageRoot = await createTempDirectory('limcode-cp-storage-');
        const conversationId = 'conv-chain-reset';

        try {
            await writeFile(rootA, 'a.txt', 'a1\n');
            const manager = await createCheckpointManager({ workspaceRoots: [rootA], storageRoot });
            const cp1 = await manager.createCheckpoint(conversationId, 0, 'write_file', 'after');
            expect(cp1).not.toBeNull();

            // 模拟打开另一个项目后继续对话
            await writeFile(rootB, 'b.txt', 'b1\n');
            setWorkspaceFolders([rootB]);
            const cp2 = await manager.createCheckpoint(conversationId, 0, 'write_file', 'after');

            expect(cp2).not.toBeNull();
            // 跨工作区：新的完整备份，不再串接旧增量链
            expect(cp2!.type).toBe('full');
            expect(cp2!.baseCheckpointId).toBeUndefined();
            const keys = Object.keys(cp2!.fileHashes!);
            expect(keys.some(k => k.endsWith('/b.txt'))).toBe(true);
            expect(keys.some(k => k.endsWith('/a.txt'))).toBe(false);
        } finally {
            await fs.rm(rootA, { recursive: true, force: true });
            await fs.rm(rootB, { recursive: true, force: true });
            await fs.rm(storageRoot, { recursive: true, force: true });
        }
    });

    test('refuses legacy checkpoint without fileHashes in multi-root workspace', async () => {
        const rootA = await createTempDirectory('limcode-cp-root-a-');
        const rootB = await createTempDirectory('limcode-cp-root-b-');
        const storageRoot = await createTempDirectory('limcode-cp-storage-');
        const conversationId = 'conv-legacy-nohash';

        try {
            const legacyCp: CheckpointRecord = {
                id: 'cp-legacy-nohash',
                conversationId,
                messageIndex: 0,
                toolName: 'write_file',
                phase: 'after',
                timestamp: Date.now(),
                backupDir: 'cp-legacy-nohash',
                fileCount: 0,
                contentHash: 'h',
                type: 'full'
            };
            const manager = await createCheckpointManager({
                workspaceRoots: [rootA, rootB],
                storageRoot,
                checkpoints: [legacyCp]
            });

            const result = await manager.restoreCheckpoint(conversationId, 'cp-legacy-nohash');
            expect(result.success).toBe(false);
            expect(result.error).toBeDefined();
        } finally {
            await fs.rm(rootA, { recursive: true, force: true });
            await fs.rm(rootB, { recursive: true, force: true });
            await fs.rm(storageRoot, { recursive: true, force: true });
        }
    });

    test('legacy restore never deletes current files not present in backup', async () => {
        const workspaceRoot = await createTempDirectory('limcode-cp-legacy-');
        const storageRoot = await createTempDirectory('limcode-cp-storage-');
        const conversationId = 'conv-legacy-keep';

        try {
            await writeFile(workspaceRoot, 'keep.txt', 'user file\n');

            // 旧记录没有 fileHashes，也没有“快照时可见”清单：
            // 备份里没有 keep.txt，恢复时绝不能删除它
            const legacyCp: CheckpointRecord = {
                id: 'cp-legacy-keep',
                conversationId,
                messageIndex: 0,
                toolName: 'write_file',
                phase: 'after',
                timestamp: Date.now(),
                backupDir: 'cp-legacy-keep',
                fileCount: 1,
                contentHash: 'h',
                type: 'full'
            };
            await writeFile(path.join(storageRoot, 'checkpoints', 'cp-legacy-keep'), 'restore.txt', 'restored\n');

            const manager = await createCheckpointManager({
                workspaceRoots: [workspaceRoot],
                storageRoot,
                checkpoints: [legacyCp]
            });
            const result = await manager.restoreCheckpoint(conversationId, 'cp-legacy-keep');

            expect(result.success).toBe(true);
            expect(result.deleted).toBe(0);
            await expect(fs.readFile(path.join(workspaceRoot, 'keep.txt'), 'utf-8')).resolves.toBe('user file\n');
            await expect(fs.readFile(path.join(workspaceRoot, 'restore.txt'), 'utf-8')).resolves.toBe('restored\n');
        } finally {
            await fs.rm(workspaceRoot, { recursive: true, force: true });
            await fs.rm(storageRoot, { recursive: true, force: true });
        }
    });

    test('partial restore failure returns an error summary', async () => {
        const workspaceRoot = await createTempDirectory('limcode-cp-partial-');
        const storageRoot = await createTempDirectory('limcode-cp-storage-');
        const conversationId = 'conv-partial';

        try {
            await writeFile(workspaceRoot, 'a.txt', 'current\n');

            // 备份内容与声明哈希不一致 → hash_mismatch
            const cp: CheckpointRecord = {
                id: 'cp-mismatch',
                conversationId,
                messageIndex: 0,
                toolName: 'write_file',
                phase: 'after',
                timestamp: Date.now(),
                backupDir: 'cp-mismatch',
                fileCount: 1,
                contentHash: 'h',
                type: 'full',
                fileHashes: { 'a.txt': md5('declared\n') }
            };
            await writeFile(path.join(storageRoot, 'checkpoints', 'cp-mismatch'), 'a.txt', 'actual\n');

            const manager = await createCheckpointManager({
                workspaceRoots: [workspaceRoot],
                storageRoot,
                checkpoints: [cp]
            });
            const result = await manager.restoreCheckpoint(conversationId, 'cp-mismatch');

            expect(result.success).toBe(false);
            expect(result.failures).toBeDefined();
            expect(result.failures!.length).toBeGreaterThan(0);
            expect(result.error).toBeDefined();
            expect(result.error!.length).toBeGreaterThan(0);
        } finally {
            await fs.rm(workspaceRoot, { recursive: true, force: true });
            await fs.rm(storageRoot, { recursive: true, force: true });
        }
    });

    test('scopes snapshot to the conversation bound workspace (multi-conversation concurrency)', async () => {
        const rootA = await createTempDirectory('limcode-cp-bound-a-');
        const rootB = await createTempDirectory('limcode-cp-bound-b-');
        const storageRoot = await createTempDirectory('limcode-cp-storage-');
        const conversationId = 'conv-bound-workspace';

        try {
            await writeFile(rootA, 'a.txt', 'a1\n');
            await writeFile(rootB, 'b.txt', 'b1\n');

            // 绑定 URI 与生产链路同构：folder.uri.toString() 的 file:// 形式
            const boundWorkspaceUri = 'file://' + rootA.replace(/\\/g, '/');

            const manager = await createCheckpointManager({
                workspaceRoots: [rootA, rootB],
                storageRoot,
                boundWorkspaceUri
            });
            const cp = await manager.createCheckpoint(conversationId, 0, 'write_file', 'after');

            expect(cp).not.toBeNull();
            // 清单只声明绑定的工作区根（rootA），rootB 不进入快照
            expect(cp!.workspaceRoots).toHaveLength(1);
            expect(cp!.workspaceRoots![0].uri.toLowerCase()).toBe(rootA.replace(/\\/g, '/').toLowerCase());

            const hashKeys = Object.keys(cp!.fileHashes ?? {});
            // scoped 键形如 ws_xxx/a.txt：绑定 rootA 时只含 rootA 的文件
            expect(hashKeys.some(k => k.replace(/\\/g, '/').endsWith('/a.txt'))).toBe(true);
            expect(hashKeys.some(k => k.replace(/\\/g, '/').endsWith('/b.txt'))).toBe(false);
        } finally {
            await fs.rm(rootA, { recursive: true, force: true });
            await fs.rm(rootB, { recursive: true, force: true });
            await fs.rm(storageRoot, { recursive: true, force: true });
        }
    });

    test('unbound conversation still snapshots all workspace roots', async () => {
        const rootA = await createTempDirectory('limcode-cp-unbound-a-');
        const rootB = await createTempDirectory('limcode-cp-unbound-b-');
        const storageRoot = await createTempDirectory('limcode-cp-storage-');
        const conversationId = 'conv-unbound-workspace';

        try {
            await writeFile(rootA, 'a.txt', 'a1\n');
            await writeFile(rootB, 'b.txt', 'b1\n');

            const manager = await createCheckpointManager({
                workspaceRoots: [rootA, rootB],
                storageRoot
            });
            const cp = await manager.createCheckpoint(conversationId, 0, 'write_file', 'after');

            expect(cp).not.toBeNull();
            expect(cp!.workspaceRoots).toHaveLength(2);

            const hashKeys = Object.keys(cp!.fileHashes ?? {}).map(k => k.replace(/\\/g, '/'));
            expect(hashKeys.some(k => k.endsWith('/a.txt'))).toBe(true);
            expect(hashKeys.some(k => k.endsWith('/b.txt'))).toBe(true);
        } finally {
            await fs.rm(rootA, { recursive: true, force: true });
            await fs.rm(rootB, { recursive: true, force: true });
            await fs.rm(storageRoot, { recursive: true, force: true });
        }
    });

    test('checkpoint file lock is scoped to the bound workspace root (no cross-workspace contention)', async () => {
        const rootA = await createTempDirectory('limcode-cp-lock-a-');
        const rootB = await createTempDirectory('limcode-cp-lock-b-');
        const storageRoot = await createTempDirectory('limcode-cp-storage-');
        const conversationId = 'conv-bound-lock';

        try {
            await writeFile(rootA, 'a.txt', 'a1\n');
            await writeFile(rootB, 'b.txt', 'b1\n');

            const boundWorkspaceUri = 'file://' + rootA.replace(/\\/g, '/');
            const manager = await createCheckpointManager({
                workspaceRoots: [rootA, rootB],
                storageRoot,
                boundWorkspaceUri
            });

            // 其他对话（绑定 rootB）正持有 rootB 内文件的写锁：
            // 若 checkpoint 文件锁仍是全局根锁，创建会轮询 60s 后超时；
            // 按工作区根加锁则立即成功，互不阻塞。
            const otherHolder = { kind: 'main' as const, id: 'conversation-other', label: 'other session' };
            fileWriteLockManager.tryAcquire([path.join(rootB, 'b.txt')], otherHolder);
            try {
                const cp = await manager.createCheckpoint(conversationId, 0, 'write_file', 'after');
                expect(cp).not.toBeNull();
            } finally {
                fileWriteLockManager.release([path.join(rootB, 'b.txt')], otherHolder);
            }
            expect(fileWriteLockManager.getLockCount()).toBe(0);
        } finally {
            await fs.rm(rootA, { recursive: true, force: true });
            await fs.rm(rootB, { recursive: true, force: true });
            await fs.rm(storageRoot, { recursive: true, force: true });
        }
    });
});
