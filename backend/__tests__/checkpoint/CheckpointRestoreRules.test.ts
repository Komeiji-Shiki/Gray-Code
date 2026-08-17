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

import '../__fixtures__/diffManagerMock';
import { createTempDirectory } from '../__fixtures__/checkpointFixtures';
import { createCheckpointManagerHarness } from '../__fixtures__/harnessFixtures';

import { CheckpointManager, type CheckpointRecord } from '../../modules/checkpoint';
import type { CheckpointManifest } from '../../modules/checkpoint';

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

describe('checkpoint restore rules (R5a)', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('M-1：createCheckpoint 无工作区根早退 → 操作以终态 failed 结束，不残留 scanning 死记录', async () => {
        const workspaceRoot = await createTempDirectory('limcode-g2-m1-workspace-');
        const storageRoot = await createTempDirectory('limcode-g2-m1-storage-');
        try {
            const harness = await createCheckpointManagerHarness(workspaceRoot, storageRoot);
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
            const harness = await createCheckpointManagerHarness(workspaceRoot, storageRoot);
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

    test('M-2b：旧 fileHashes-only 存档恢复时从备份目录补采文件尺寸并执行当前上限', async () => {
        const workspaceRoot = await createTempDirectory('limcode-g2-m2b-workspace-');
        const storageRoot = await createTempDirectory('limcode-g2-m2b-storage-');
        const checkpointId = 'cp-old-size-only';
        try {
            // 当前工作区文件小于上限，但旧存档中的备份副本超过当前上限。
            await writeFile(workspaceRoot, 'large.bin', 'current content');
            const checkpoint: CheckpointRecord = {
                id: checkpointId,
                conversationId: 'conv-m2b',
                messageIndex: 0,
                toolName: 'write_file',
                phase: 'after',
                timestamp: Date.now(),
                backupDir: checkpointId,
                fileCount: 1,
                contentHash: 'old-size-only',
                type: 'full',
                fileHashes: { 'large.bin': 'old-large-hash' }
                // 故意没有 fileStats / manifest 尺寸，模拟旧格式记录。
            };
            await writeFile(
                path.join(storageRoot, 'checkpoints', checkpointId),
                'large.bin',
                'x'.repeat(2048)
            );

            const harness = await createCheckpointManagerHarness(workspaceRoot, storageRoot, [checkpoint]);
            harness.setCheckpointConfig({
                exclusion: {
                    enabledProfiles: {},
                    maxFileSizeBytes: 1024,
                    customPatterns: []
                }
            });

            const result = await harness.manager.restoreCheckpoint('conv-m2b', checkpointId);
            expect(result.success).toBe(true);
            expect(result.restored).toBe(0);
            // 旧记录也不能绕过当前大小限制覆盖工作区文件。
            await expect(fs.readFile(path.join(workspaceRoot, 'large.bin'), 'utf-8'))
                .resolves.toBe('current content');
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

            const harness = await createCheckpointManagerHarness(workspaceRoot, storageRoot);
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
            const harness = await createCheckpointManagerHarness(workspaceRoot, storageRoot);

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
            const harness = await createCheckpointManagerHarness(workspaceRoot, storageRoot);
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

            const harness = await createCheckpointManagerHarness(workspaceRoot, storageRoot);
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

            const harness = await createCheckpointManagerHarness(workspaceRoot, storageRoot);
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