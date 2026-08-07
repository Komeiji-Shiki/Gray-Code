/**
 * FIX-G2（R5a 复查）回归测试：checkpoint 域恢复规则修复
 *
 * 覆盖：
 * - M-1: createCheckpoint 无工作区根早退 → 操作以终态 failed 结束，
 *   getOperationProgress()（不带 operationId）不再把死记录当“最近进行中操作”返回
 * - M-2: 恢复侧忽略解析器补传 profilePatterns（类别自定义模式覆盖参与目标过滤与当前状态收集）
 * - M-3: manifest.excluded（default/gitignore/custom）并入 protectedScopedPaths，
 *   用户放宽规则后恢复不得删除这些快照时已存在的文件（CP-09）
 * - M-3（R7b 补充）: 目录级排除条目（manifest.excluded 只记录目录自身）经引擎前缀匹配
 *   保护目录内文件；前缀匹配对文件级条目无副作用（无 `/` 边界不误伤同名前缀邻居）
 * - M-4: buildExcludedNote 的 rulesChanged 比较 profilePatterns
 */
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

jest.mock('../../tools/file/diffManager', () => ({
    getDiffManager: () => ({
        cancelAllPending: jest.fn().mockResolvedValue({ cancelled: [] })
    })
}));

import { CheckpointManager, type CheckpointRecord } from '../../modules/checkpoint/CheckpointManager';
import type { CheckpointManifest } from '../../modules/checkpoint/types';

async function createTempDirectory(prefix: string): Promise<string> {
    return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

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


interface Harness {
    manager: CheckpointManager;
    storageRoot: string;
    storedCheckpoints: () => CheckpointRecord[];
    setCheckpointConfig: (config: Record<string, unknown>) => void;
    readManifest: (checkpointId: string) => Promise<CheckpointManifest | null>;
}

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
        custom: { checkpoints: [] }
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
            // 空对象 = 全部默认类别按默认启用（全开）
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

    return {
        manager,
        storageRoot,
        storedCheckpoints,
        setCheckpointConfig: (config: Record<string, unknown>) => {
            configValue = { ...baseConfig, ...config };
        },
        readManifest
    };
}

/** 全部默认类别显式关闭 */
const ALL_PROFILES_DISABLED = {
    logs: false,
    aiModels: false,
    datasets: false,
    caches: false,
    pythonVenvs: false,
    buildArtifacts: false,
    largeMedia: false,
    archives: false
};

describe('FIX-G2: checkpoint restore rules (R5a)', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('M-1：createCheckpoint 无工作区根早退 → 操作以终态 failed 结束，不残留 scanning 死记录', async () => {
        const workspaceRoot = await createTempDirectory('limcode-g2-m1-workspace-');
        const storageRoot = await createTempDirectory('limcode-g2-m1-storage-');
        try {
            const harness = await createHarness(workspaceRoot, storageRoot);
            // 清空工作区根：createCheckpoint 应在注册操作后早退
            (vscode.workspace as any).workspaceFolders = [];

            const phases: string[] = [];
            let operationId: string | undefined;
            const cp = await harness.manager.createCheckpoint('conv-m1', 0, 'write_file', 'after', {
                progress: progress => {
                    operationId = progress.operationId;
                    phases.push(progress.phase);
                }
            });
            expect(cp).toBeNull();

            // 进度回调收到终态 failed（修复前停留在 scanning，永远收不到终态）
            expect(phases.length).toBeGreaterThan(0);
            expect(phases[phases.length - 1]).toBe('failed');

            // 带 operationId 查询：能看到失败原因
            const explicit = harness.manager.getOperationProgress(operationId!);
            expect(explicit).not.toBeNull();
            expect(explicit!.phase).toBe('failed');
            expect(explicit!.cancelled).toBe(false);
            expect(explicit!.message).toBe('No workspace root');

            // 不带 operationId 查询：不得把早退操作当“最近进行中操作”返回（修复前为 scanning 死记录）
            expect(harness.manager.getOperationProgress()).toBeNull();
        } finally {
            await fs.rm(workspaceRoot, { recursive: true, force: true });
            await fs.rm(storageRoot, { recursive: true, force: true });
        }
    });

    test('M-2：恢复侧过滤应用类别自定义模式覆盖（profilePatterns）', async () => {
        const workspaceRoot = await createTempDirectory('limcode-g2-m2-workspace-');
        const storageRoot = await createTempDirectory('limcode-g2-m2-storage-');
        try {
            // 快照时未配置类别覆盖 → data.bin 按默认 largeMedia 清单（不含 *.bin）被备份
            await writeFile(workspaceRoot, 'data.bin', 'v1');
            const harness = await createHarness(workspaceRoot, storageRoot);
            const cp = await harness.manager.createCheckpoint('conv-m2', 0, 'write_file', 'after');
            expect(cp).not.toBeNull();
            const manifest = await harness.readManifest(cp!.id);
            expect(Object.keys(manifest!.files).some(key => key.includes('data.bin'))).toBe(true);

            // 恢复前：data.bin 内容变化 + 启用类别覆盖 ['*.bin']（默认 largeMedia 模式不含 *.bin）
            await writeFile(workspaceRoot, 'data.bin', 'v2');
            harness.setCheckpointConfig({
                exclusion: {
                    enabledProfiles: {},
                    maxFileSizeBytes: 1024,
                    customPatterns: [],
                    profilePatterns: { largeMedia: ['*.bin'] }
                }
            });

            // 修复前：恢复侧回退默认模式 → data.bin 仍视为可见 → 被恢复覆盖为 v1；
            // 修复后：data.bin 被当前规则排除 → 不恢复、不删除、不进入 currentHashes
            const result = await harness.manager.restoreCheckpoint('conv-m2', cp!.id);
            expect(result.success).toBe(true);
            expect(result.restored).toBe(0);
            expect(result.deleted).toBe(0);
            const content = await fs.readFile(path.join(workspaceRoot, 'data.bin'), 'utf-8');
            expect(content).toBe('v2');
        } finally {
            await fs.rm(workspaceRoot, { recursive: true, force: true });
            await fs.rm(storageRoot, { recursive: true, force: true });
        }
    });

    test('M-3：manifest.excluded（default/gitignore/custom）受保护，放宽规则后恢复不删除', async () => {
        const workspaceRoot = await createTempDirectory('limcode-g2-m3-workspace-');
        const storageRoot = await createTempDirectory('limcode-g2-m3-storage-');
        try {
            await writeFile(workspaceRoot, 'keep.txt', 'keep');
            await writeFile(workspaceRoot, 'secret.log', 'custom-excluded');
            await writeFile(workspaceRoot, 'movie.mp4', 'default-excluded');
            await writeFile(workspaceRoot, '.gitignore', 'gitignored.tmp\n');
            await writeFile(workspaceRoot, 'gitignored.tmp', 'gitignore-excluded');

            const harness = await createHarness(workspaceRoot, storageRoot);
            // 快照规则：custom 模式 *.log + 默认类别全开（largeMedia 命中 *.mp4）+ .gitignore
            harness.setCheckpointConfig({ customIgnorePatterns: ['*.log'] });
            const cp = await harness.manager.createCheckpoint('conv-m3', 0, 'write_file', 'after');
            expect(cp).not.toBeNull();

            // 三个文件都在 manifest.excluded 中（reason 分别为 custom/default/gitignore）
            const manifest = await harness.readManifest(cp!.id);
            const excludedReasons: Record<string, string> = {};
            for (const entry of manifest!.excluded) {
                const name = entry.path.split('/').pop();
                if (name === 'secret.log' || name === 'movie.mp4' || name === 'gitignored.tmp') {
                    excludedReasons[name] = entry.reason;
                }
            }
            expect(excludedReasons['secret.log']).toBe('custom');
            expect(excludedReasons['movie.mp4']).toBe('default');
            expect(excludedReasons['gitignored.tmp']).toBe('gitignore');

            // 用户放宽规则：删自定义模式、关闭全部默认类别、删除 .gitignore
            await fs.rm(path.join(workspaceRoot, '.gitignore'));
            harness.setCheckpointConfig({
                customIgnorePatterns: [],
                exclusion: {
                    enabledProfiles: ALL_PROFILES_DISABLED,
                    maxFileSizeBytes: 1024,
                    customPatterns: []
                }
            });

            // 预览：被排除文件不得出现在 untrackedPaths（修复前会进入 untrackedToDelete）
            const preview = await harness.manager.previewRestore('conv-m3', cp!.id);
            expect(preview.success).toBe(true);
            expect(preview.untrackedPaths).toEqual(
                expect.not.arrayContaining(['secret.log', 'movie.mp4', 'gitignored.tmp'])
            );

            // 确认删除快照后新建文件：这三个快照时已存在的文件仍必须保留（CP-09）
            const result = await harness.manager.restoreCheckpoint('conv-m3', cp!.id, { deleteUntrackedFiles: true });
            expect(result.success).toBe(true);
            await expect(pathExists(path.join(workspaceRoot, 'secret.log'))).resolves.toBe(true);
            await expect(pathExists(path.join(workspaceRoot, 'movie.mp4'))).resolves.toBe(true);
            await expect(pathExists(path.join(workspaceRoot, 'gitignored.tmp'))).resolves.toBe(true);
        } finally {
            await fs.rm(workspaceRoot, { recursive: true, force: true });
            await fs.rm(storageRoot, { recursive: true, force: true });
        }
    });

    test('M-4：buildExcludedNote 的 rulesChanged 比较 profilePatterns', async () => {
        const workspaceRoot = await createTempDirectory('limcode-g2-m4-workspace-');
        const storageRoot = await createTempDirectory('limcode-g2-m4-storage-');
        try {
            await writeFile(workspaceRoot, 'a.txt', 'hello');
            await writeFile(workspaceRoot, 'app.log', 'log'); // 触发 logs 类别排除 → excludedCount > 0
            const harness = await createHarness(workspaceRoot, storageRoot);

            // 快照规则：logs 类别使用自定义覆盖 ['*.log']
            harness.setCheckpointConfig({
                exclusion: {
                    enabledProfiles: {},
                    maxFileSizeBytes: 1024,
                    customPatterns: [],
                    profilePatterns: { logs: ['*.log'] }
                }
            });
            const cp = await harness.manager.createCheckpoint('conv-m4', 0, 'write_file', 'after');
            expect(cp).not.toBeNull();
            const manifest = await harness.readManifest(cp!.id);
            expect(manifest!.excluded.length).toBeGreaterThan(0);
            expect(manifest!.ignoreSnapshot.profilePatterns).toEqual({ logs: ['*.log'] });

            // 当前规则与快照一致 → rulesChanged=false
            const restore1 = await harness.manager.restoreCheckpoint('conv-m4', cp!.id);
            expect(restore1.success).toBe(true);
            expect(restore1.excludedNote).toBeDefined();
            expect(restore1.excludedNote!.rulesChanged).toBe(false);

            // 仅 profilePatterns 变化（其余规则不变）→ rulesChanged=true（修复前漏比较返回 false）
            harness.setCheckpointConfig({
                exclusion: {
                    enabledProfiles: {},
                    maxFileSizeBytes: 1024,
                    customPatterns: [],
                    profilePatterns: { logs: ['*.log', '*.trace'] }
                }
            });
            const restore2 = await harness.manager.restoreCheckpoint('conv-m4', cp!.id);
            expect(restore2.success).toBe(true);
            expect(restore2.excludedNote).toBeDefined();
            expect(restore2.excludedNote!.rulesChanged).toBe(true);
        } finally {
            await fs.rm(workspaceRoot, { recursive: true, force: true });
            await fs.rm(storageRoot, { recursive: true, force: true });
        }
    });

    test('L-2：showRestoreResultMessage 生成状态栏消息（新格式恢复路径共用）', async () => {
        const workspaceRoot = await createTempDirectory('limcode-g2-l2-workspace-');
        const storageRoot = await createTempDirectory('limcode-g2-l2-storage-');
        try {
            await writeFile(workspaceRoot, 'a.txt', 'v1');
            const harness = await createHarness(workspaceRoot, storageRoot);
            const cp = await harness.manager.createCheckpoint('conv-l2', 0, 'write_file', 'after');
            expect(cp).not.toBeNull();

            const result = await harness.manager.restoreCheckpoint('conv-l2', cp!.id);
            expect(result.success).toBe(true);
            // L-2: 新格式恢复路径经 showRestoreResultMessage 写状态栏
            const statusBarCalls = (vscode.window.setStatusBarMessage as jest.Mock).mock.calls;
            const lastCall = statusBarCalls[statusBarCalls.length - 1];
            expect(lastCall).toBeDefined();
            expect(lastCall[0]).toContain('$(check)');
            expect(lastCall[0]).toContain('已恢复');
            expect(lastCall[1]).toBe(5000);
        } finally {
            await fs.rm(workspaceRoot, { recursive: true, force: true });
            await fs.rm(storageRoot, { recursive: true, force: true });
        }
    });

    test('M-3 目录级：整目录被排除后放宽规则，恢复不误删目录内文件（前缀保护）', async () => {
        const workspaceRoot = await createTempDirectory('limcode-g2-m3dir-workspace-');
        const storageRoot = await createTempDirectory('limcode-g2-m3dir-storage-');
        try {
            await writeFile(workspaceRoot, 'src/main.ts', 'v1');
            await writeFile(workspaceRoot, 'dist/app.js', 'build');
            await writeFile(workspaceRoot, 'dist/sub/deep.js', 'build');

            const harness = await createHarness(workspaceRoot, storageRoot);
            // 默认类别全开：dist/ 命中 buildArtifacts → 整目录排除
            const cp = await harness.manager.createCheckpoint('conv-m3dir', 0, 'write_file', 'after');
            expect(cp).not.toBeNull();

            // manifest.excluded 只记录目录自身一条（不递归记录内部文件）
            const manifest = await harness.readManifest(cp!.id);
            const dirEntries = manifest!.excluded.filter(entry => entry.path.endsWith('/dist'));
            expect(dirEntries.length).toBe(1);
            expect(dirEntries[0].reason).toBe('default');
            expect(manifest!.excluded.some(entry => entry.path.includes('dist/app.js'))).toBe(false);
            expect(manifest!.excluded.some(entry => entry.path.includes('dist/sub/deep.js'))).toBe(false);
            // src/main.ts 正常备份
            expect(Object.keys(manifest!.files).some(key => key.includes('src/main.ts'))).toBe(true);

            // 放宽规则：关闭全部默认类别 + 快照后新建 new.txt
            harness.setCheckpointConfig({
                customIgnorePatterns: [],
                exclusion: {
                    enabledProfiles: ALL_PROFILES_DISABLED,
                    maxFileSizeBytes: 1024,
                    customPatterns: []
                }
            });
            await writeFile(workspaceRoot, 'new.txt', 'after-snapshot');

            // 预览：dist/ 内文件不得出现在 untrackedPaths（修复前会进入 untrackedToDelete）；
            // 真正快照后新建的 new.txt 仍应出现在清单中
            const preview = await harness.manager.previewRestore('conv-m3dir', cp!.id);
            expect(preview.success).toBe(true);
            expect(preview.untrackedPaths).toEqual(
                expect.not.arrayContaining(['dist/app.js', 'dist/sub/deep.js'])
            );
            expect(preview.untrackedPaths).toContain('new.txt');

            // 确认删除快照后新建文件：dist/ 内快照时已存在的文件必须保留（CP-09 + 前缀保护），
            // 快照后新建的 new.txt 正常删除
            const result = await harness.manager.restoreCheckpoint('conv-m3dir', cp!.id, { deleteUntrackedFiles: true });
            expect(result.success).toBe(true);
            await expect(pathExists(path.join(workspaceRoot, 'dist/app.js'))).resolves.toBe(true);
            await expect(pathExists(path.join(workspaceRoot, 'dist/sub/deep.js'))).resolves.toBe(true);
            await expect(pathExists(path.join(workspaceRoot, 'new.txt'))).resolves.toBe(false);
        } finally {
            await fs.rm(workspaceRoot, { recursive: true, force: true });
            await fs.rm(storageRoot, { recursive: true, force: true });
        }
    });

    test('M-3 文件级：前缀匹配对文件级条目无副作用（只保护精确命中的文件）', async () => {
        const workspaceRoot = await createTempDirectory('limcode-g2-m3file-workspace-');
        const storageRoot = await createTempDirectory('limcode-g2-m3file-storage-');
        try {
            // 快照时 custom 模式 *.log 只排除 keep.log；keep.log.bak 快照时尚不存在
            await writeFile(workspaceRoot, 'keep.log', 'excluded-at-snapshot');
            await writeFile(workspaceRoot, 'src/main.ts', 'v1');

            const harness = await createHarness(workspaceRoot, storageRoot);
            harness.setCheckpointConfig({ customIgnorePatterns: ['*.log'] });
            const cp = await harness.manager.createCheckpoint('conv-m3file', 0, 'write_file', 'after');
            expect(cp).not.toBeNull();

            const manifest = await harness.readManifest(cp!.id);
            expect(manifest!.excluded.some(entry => entry.path.endsWith('keep.log') && entry.reason === 'custom')).toBe(true);
            expect(manifest!.excluded.some(entry => entry.path.endsWith('keep.log.bak'))).toBe(false);

            // 放宽规则（删自定义模式）+ 快照后新建 keep.log.bak（与受保护文件仅差后缀、无 `/` 边界）
            harness.setCheckpointConfig({
                customIgnorePatterns: [],
                exclusion: {
                    enabledProfiles: ALL_PROFILES_DISABLED,
                    maxFileSizeBytes: 1024,
                    customPatterns: []
                }
            });
            await writeFile(workspaceRoot, 'keep.log.bak', 'after-snapshot');

            // 预览：keep.log（快照时被排除）受保护不进 untrackedPaths；keep.log.bak 是快照后新建，应出现
            const preview = await harness.manager.previewRestore('conv-m3file', cp!.id);
            expect(preview.success).toBe(true);
            expect(preview.untrackedPaths).toEqual(expect.not.arrayContaining(['keep.log']));
            expect(preview.untrackedPaths).toContain('keep.log.bak');

            // 恢复（确认删除 untracked）：keep.log 保留、keep.log.bak 被删——
            // 文件级保护不做无边界前缀匹配，不会误伤同名字邻居
            const result = await harness.manager.restoreCheckpoint('conv-m3file', cp!.id, { deleteUntrackedFiles: true });
            expect(result.success).toBe(true);
            await expect(pathExists(path.join(workspaceRoot, 'keep.log'))).resolves.toBe(true);
            await expect(pathExists(path.join(workspaceRoot, 'keep.log.bak'))).resolves.toBe(false);
        } finally {
            await fs.rm(workspaceRoot, { recursive: true, force: true });
            await fs.rm(storageRoot, { recursive: true, force: true });
        }
    });
});