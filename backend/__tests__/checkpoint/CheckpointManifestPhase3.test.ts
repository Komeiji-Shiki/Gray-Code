/**
 * CheckpointManager Phase 3 集成测试（CPF-01/02/03/09/10/11 + EX-10/EX-11）
 *
 * 覆盖：
 * - createCheckpoint 元数据精简（不含 fileHashes/fileStats）+ manifest 落盘 + backupBytes
 * - 增量创建基于 manifest 回填的上一个检查点
 * - getCheckpoints 返回轻量 CheckpointSummary
 * - getCheckpoints(withSize) 旧记录懒扫描 + 写回摘要缓存
 * - restore 走 manifest 回填路径（新格式存档）
 * - EX-11 excludedNote（快照规则 vs 当前规则）
 * - CPF-11 进度回调与取消
 * - CPF-10 getAllConversationsWithCheckpoints 摘要聚合（不扫描磁盘）
 */
import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import '../__fixtures__/diffManagerMock';
import { createTempDirectory } from '../__fixtures__/checkpointFixtures';
import { createCheckpointManagerHarness } from '../__fixtures__/harnessFixtures';

import { CheckpointManager, type CheckpointRecord } from '../../modules/checkpoint';
import { CHECKPOINT_MANIFEST_VERSION } from '../../modules/checkpoint';
import type { CheckpointManifest } from '../../modules/checkpoint';
import { createWorkspaceRootId, createWorkspaceSnapshot } from '../../modules/checkpoint';

async function writeFile(rootDir: string, relativePath: string, content: string = ''): Promise<void> {
    const fullPath = path.join(rootDir, relativePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content, 'utf-8');
}

function md5(content: string): string {
    return crypto.createHash('md5').update(content).digest('hex');
}


describe('CheckpointManager Phase 3 (manifest / summary / progress)', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('createCheckpoint：元数据精简（无 fileHashes/fileStats）+ manifest 落盘 + backupBytes（CPF-01/02/09）', async () => {
        const workspaceRoot = await createTempDirectory('limcode-cp3-workspace-');
        const storageRoot = await createTempDirectory('limcode-cp3-storage-');
        try {
            await writeFile(workspaceRoot, 'a.txt', 'hello');
            await writeFile(workspaceRoot, 'b.txt', 'world');

            const harness = await createCheckpointManagerHarness(workspaceRoot, storageRoot);
            const cp = await harness.manager.createCheckpoint('conv-1', 0, 'write_file', 'after');
            expect(cp).not.toBeNull();

            // 返回记录带 fileHashes（兼容调用方）
            expect(cp!.fileHashes).toBeDefined();
            expect(Object.keys(cp!.fileHashes!)).toHaveLength(2);

            // 元数据记录已精简
            const stored = harness.storedCheckpoints();
            expect(stored).toHaveLength(1);
            expect(stored[0].fileHashes).toBeUndefined();
            expect(stored[0].fileStats).toBeUndefined();
            expect(stored[0].backupBytes).toBeGreaterThan(0);
            expect(stored[0].manifestVersion).toBe(CHECKPOINT_MANIFEST_VERSION);

            // manifest 落盘：files 完整、excluded 为空、ignoreSnapshot 携带规则
            const manifest = await harness.readManifest(cp!.id);
            expect(manifest).not.toBeNull();
            expect(Object.keys(manifest!.files)).toHaveLength(2);
            expect(manifest!.files[Object.keys(manifest!.files)[0]].hash).toMatch(/^[a-f0-9]{32}$/);
            expect(manifest!.excluded).toEqual([]);
            expect(manifest!.ignoreSnapshot.maxFileSizeBytes).toBe(1024);
            // buildIgnoreSnapshot 总是展开默认类别（A 的实现语义）
            expect(manifest!.ignoreSnapshot.enabledProfiles.logs).toBe(true);
        } finally {
            await fs.rm(workspaceRoot, { recursive: true, force: true });
            await fs.rm(storageRoot, { recursive: true, force: true });
        }
    });

    test('增量创建基于 manifest 回填的上一个检查点（CPF-01）', async () => {
        const workspaceRoot = await createTempDirectory('limcode-cp3-workspace-');
        const storageRoot = await createTempDirectory('limcode-cp3-storage-');
        try {
            await writeFile(workspaceRoot, 'a.txt', 'v1');
            const harness = await createCheckpointManagerHarness(workspaceRoot, storageRoot);

            const cp1 = await harness.manager.createCheckpoint('conv-1', 0, 'write_file', 'after');
            expect(cp1).not.toBeNull();
            expect(cp1!.type).toBe('full');

            await writeFile(workspaceRoot, 'a.txt', 'v2');
            await writeFile(workspaceRoot, 'b.txt', 'new');
            const cp2 = await harness.manager.createCheckpoint('conv-1', 0, 'write_file', 'after');
            expect(cp2).not.toBeNull();

            // 元数据里上一个记录没有 fileHashes，但增量仍应基于 manifest 回填正确计算
            expect(cp2!.type).toBe('incremental');
            expect(cp2!.baseCheckpointId).toBe(cp1!.id);
            const manifest2 = await harness.readManifest(cp2!.id);
            // 精确断言：changes 含 a.txt(modified) + b.txt(added)，scoped 键
            const changePaths = manifest2!.changes.map(c => c.path);
            expect(changePaths).toHaveLength(2);
            expect(changePaths.some(p => p.endsWith('/a.txt'))).toBe(true);
            expect(changePaths.some(p => p.endsWith('/b.txt'))).toBe(true);
            const types = manifest2!.changes.map(c => c.type).sort();
            expect(types).toEqual(['added', 'modified']);

            // 恢复链可用（manifest 回填 chainEntries 后 restore 正常）
            const restore = await harness.manager.restoreCheckpoint('conv-1', cp1!.id);
            expect(restore.success).toBe(true);
            await expect(fs.readFile(path.join(workspaceRoot, 'a.txt'), 'utf-8')).resolves.toBe('v1');
            // b.txt 在 cp1 快照中不存在（#29 保护）：未确认删除清单时不被删除
            await expect(fs.access(path.join(workspaceRoot, 'b.txt'))).resolves.toBeUndefined();
        } finally {
            await fs.rm(workspaceRoot, { recursive: true, force: true });
            await fs.rm(storageRoot, { recursive: true, force: true });
        }
    });

    test('getCheckpoints 返回轻量 summary；withSize 对旧记录懒扫描并写回（CPF-03/09）', async () => {
        const workspaceRoot = await createTempDirectory('limcode-cp3-workspace-');
        const storageRoot = await createTempDirectory('limcode-cp3-storage-');
        try {
            await writeFile(workspaceRoot, 'a.txt', 'hello');

            // 旧格式记录：带 fileHashes、无 backupBytes
            const legacy: CheckpointRecord = {
                id: 'cp-legacy-size',
                conversationId: 'conv-1',
                messageIndex: 0,
                toolName: 'write_file',
                phase: 'after',
                timestamp: Date.now(),
                backupDir: 'cp-legacy-size',
                fileCount: 1,
                contentHash: 'hash',
                type: 'full',
                fileHashes: { [`ws_${'a'.repeat(16)}/a.txt`]: md5('hello') },
                emptyDirs: []
            };
            await writeFile(path.join(storageRoot, 'checkpoints', 'cp-legacy-size'), 'a.txt', 'hello');

            const harness = await createCheckpointManagerHarness(workspaceRoot, storageRoot, [legacy]);

            const plain = await harness.manager.getCheckpoints('conv-1');
            expect(plain).toHaveLength(1);
            const summary = plain[0];
            expect(summary.id).toBe('cp-legacy-size');
            expect(summary.fileCount).toBe(1);
            expect(summary.excludedCount).toBe(0);
            expect(summary.manifestVersion).toBe(0);
            expect((summary as any).fileHashes).toBeUndefined();
            expect((summary as any).size).toBeUndefined();

            const withSize = await harness.manager.getCheckpoints('conv-1', { withSize: true });
            expect(withSize[0].backupBytes).toBe(5);
            expect(withSize[0].size).toBe(5);

            // 懒扫描结果已写回摘要缓存
            const stored = harness.storedCheckpoints();
            expect(stored[0].backupBytes).toBe(5);
        } finally {
            await fs.rm(workspaceRoot, { recursive: true, force: true });
            await fs.rm(storageRoot, { recursive: true, force: true });
        }
    });

    test('EX-11：restore 返回 excludedNote（快照规则 vs 当前规则）', async () => {
        const workspaceRoot = await createTempDirectory('limcode-cp3-workspace-');
        const storageRoot = await createTempDirectory('limcode-cp3-storage-');
        try {
            await writeFile(workspaceRoot, 'a.txt', 'hello');
            await writeFile(workspaceRoot, 'big.bin', 'x'.repeat(5000)); // 超过 1024 上限

            const harness = await createCheckpointManagerHarness(workspaceRoot, storageRoot);
            const cp = await harness.manager.createCheckpoint('conv-1', 0, 'write_file', 'after');
            expect(cp).not.toBeNull();

            const manifest = await harness.readManifest(cp!.id);
            expect(manifest!.excluded).toHaveLength(1);
            expect(manifest!.excluded[0].reason).toBe('size');

            // M-3: 记录补写 excludedCount / excludedBytes / ignoreSnapshot（与快照构建同一口径）
            const stored = harness.storedCheckpoints();
            expect(stored).toHaveLength(1);
            expect(stored[0].excludedCount).toBe(1);
            expect(stored[0].excludedBytes).toBe(5000);
            expect(stored[0].ignoreSnapshot).toBeDefined();
            expect(stored[0].ignoreSnapshot!.maxFileSizeBytes).toBe(1024);
            expect(stored[0].ignoreSnapshot!.customPatterns).toEqual([]);

            // 当前规则与快照一致 → rulesChanged=false
            const restore1 = await harness.manager.restoreCheckpoint('conv-1', cp!.id);
            expect(restore1.success).toBe(true);
            expect(restore1.excludedNote).toBeDefined();
            expect(restore1.excludedNote!.excludedCount).toBe(1);
            expect(restore1.excludedNote!.rulesChanged).toBe(false);

            // 当前规则变化（自定义模式不同）→ rulesChanged=true，仍按当前规则过滤
            harness.setCheckpointConfig({ customIgnorePatterns: ['*.tmp'] });
            const restore2 = await harness.manager.restoreCheckpoint('conv-1', cp!.id);
            expect(restore2.success).toBe(true);
            expect(restore2.excludedNote!.rulesChanged).toBe(true);

            // M-4: 仅 enabledProfiles 变化（自定义模式不变）→ rulesChanged=true
            harness.setCheckpointConfig({
                customIgnorePatterns: ['*.tmp'],
                exclusion: {
                    enabledProfiles: {
                        logs: true,
                        aiModels: false,
                        datasets: false,
                        caches: false,
                        pythonVenvs: false,
                        buildArtifacts: false,
                        largeMedia: false,
                        archives: false
                    },
                    maxFileSizeBytes: 1024,
                    customPatterns: []
                }
            });
            const restore3 = await harness.manager.restoreCheckpoint('conv-1', cp!.id);
            expect(restore3.success).toBe(true);
            expect(restore3.excludedNote!.rulesChanged).toBe(true);
        } finally {
            await fs.rm(workspaceRoot, { recursive: true, force: true });
            await fs.rm(storageRoot, { recursive: true, force: true });
        }
    });

    test('CPF-11：createCheckpoint 进度回调收到阶段更新，取消后返回 null 且进度标记 cancelled', async () => {
        const workspaceRoot = await createTempDirectory('limcode-cp3-workspace-');
        const storageRoot = await createTempDirectory('limcode-cp3-storage-');
        try {
            for (let i = 0; i < 50; i++) {
                await writeFile(workspaceRoot, `f${i}.txt`, `content-${i}`);
            }

            const harness = await createCheckpointManagerHarness(workspaceRoot, storageRoot);

            // 进度回调：记录收到的 progress；复制进行中触发一次取消
            const phases: string[] = [];
            let operationId: string | undefined;
            let cancelled = false;
            const cp = await harness.manager.createCheckpoint('conv-1', 0, 'write_file', 'after', {
                progress: progress => {
                    phases.push(progress.phase);
                    operationId = progress.operationId;
                    if (progress.phase === 'copying' && progress.processed >= 3 && !cancelled) {
                        cancelled = true;
                        harness.manager.cancelOperation(progress.operationId);
                    }
                }
            });

            // 取消发生在复制中途 → 返回 null、进度 cancelled
            expect(cp).toBeNull();
            expect(operationId).toBeDefined();
            const finalProgress = harness.manager.getOperationProgress(operationId!);
            expect(finalProgress).not.toBeNull();
            expect(finalProgress!.cancelled).toBe(true);
            expect(finalProgress!.phase).toBe('cancelled');
            // 备份目录被回收
            const checkpointsDir = path.join(storageRoot, 'checkpoints');
            const dirs = (await fs.readdir(checkpointsDir)).filter(name => name.startsWith('cp_'));
            expect(dirs).toHaveLength(0);
            void phases;
        } finally {
            await fs.rm(workspaceRoot, { recursive: true, force: true });
            await fs.rm(storageRoot, { recursive: true, force: true });
        }
    });

    test('CPF-11：getOperationProgress / cancelOperation 对未知 ID 返回 null/false', async () => {
        const workspaceRoot = await createTempDirectory('limcode-cp3-workspace-');
        const storageRoot = await createTempDirectory('limcode-cp3-storage-');
        try {
            const harness = await createCheckpointManagerHarness(workspaceRoot, storageRoot);
            expect(harness.manager.getOperationProgress('op-nonexistent')).toBeNull();
            expect(harness.manager.cancelOperation('op-nonexistent')).toBe(false);
        } finally {
            await fs.rm(workspaceRoot, { recursive: true, force: true });
            await fs.rm(storageRoot, { recursive: true, force: true });
        }
    });

    test('CPF-10：getAllConversationsWithCheckpoints 基于摘要聚合，不扫描磁盘', async () => {
        const workspaceRoot = await createTempDirectory('limcode-cp3-workspace-');
        const storageRoot = await createTempDirectory('limcode-cp3-storage-');
        try {
            const withBytes: CheckpointRecord = {
                id: 'cp-a',
                conversationId: 'conv-1',
                messageIndex: 0,
                toolName: 'write_file',
                phase: 'after',
                timestamp: 1000,
                backupDir: 'cp-a',
                fileCount: 1,
                contentHash: 'h',
                type: 'full',
                backupBytes: 100,
                manifestVersion: 1
            };
            const withoutBytes: CheckpointRecord = {
                id: 'cp-b',
                conversationId: 'conv-1',
                messageIndex: 1,
                toolName: 'write_file',
                phase: 'after',
                timestamp: 2000,
                backupDir: 'cp-b',
                fileCount: 1,
                contentHash: 'h2',
                type: 'incremental',
                baseCheckpointId: 'cp-a'
            };

            const harness = await createCheckpointManagerHarness(workspaceRoot, storageRoot, [withBytes, withoutBytes]);
            // mock listConversations 返回该对话
            (harness.manager as any).conversationManager.listConversations.mockResolvedValue(['conv-1']);
            (harness.manager as any).conversationManager.getMetadata.mockResolvedValue({
                title: 'Test Conv',
                createdAt: 1000,
                updatedAt: 2000,
                custom: { checkpoints: [withBytes, withoutBytes] }
            });

            const result = await harness.manager.getAllConversationsWithCheckpoints();
            expect(result).toHaveLength(1);
            expect(result[0].conversationId).toBe('conv-1');
            expect(result[0].title).toBe('Test Conv');
            expect(result[0].checkpointCount).toBe(2);
            expect(result[0].totalSize).toBe(100); // 只聚合已知 backupBytes
            expect(result[0].sizeIncomplete).toBe(true);
        } finally {
            await fs.rm(workspaceRoot, { recursive: true, force: true });
            await fs.rm(storageRoot, { recursive: true, force: true });
        }
    });

    test('getManifest 按 checkpointId 返回 manifest（CPF-03）', async () => {
        const workspaceRoot = await createTempDirectory('limcode-cp3-workspace-');
        const storageRoot = await createTempDirectory('limcode-cp3-storage-');
        try {
            await writeFile(workspaceRoot, 'a.txt', 'hello');
            const harness = await createCheckpointManagerHarness(workspaceRoot, storageRoot);
            const cp = await harness.manager.createCheckpoint('conv-1', 0, 'write_file', 'after');
            expect(cp).not.toBeNull();

            const manifest = await harness.manager.getManifest(cp!.id);
            expect(manifest).not.toBeNull();
            expect(manifest!.checkpointId).toBe(cp!.id);
            // CPF-LAZY-1: getManifest 返回轻量元数据视图（排除清单/规则快照），
            // 不再携带重量级 files 映射经 IPC 下发
            expect((manifest as CheckpointManifest & { files?: unknown }).files).toBeUndefined();
            expect(Array.isArray(manifest!.excluded)).toBe(true);

            expect(await harness.manager.getManifest('cp-nonexistent')).toBeNull();
        } finally {
            await fs.rm(workspaceRoot, { recursive: true, force: true });
            await fs.rm(storageRoot, { recursive: true, force: true });
        }
    });

    test('H1（CP-SKIP 修订）：内容无变化不产生空增量节点，恢复漂移文件成功', async () => {
        const workspaceRoot = await createTempDirectory('limcode-cp3-workspace-');
        const storageRoot = await createTempDirectory('limcode-cp3-storage-');
        try {
            await writeFile(workspaceRoot, 'a.txt', 'v1');
            const harness = await createCheckpointManagerHarness(workspaceRoot, storageRoot);

            // cp1 = 完整备份（a.txt=v1）
            const cp1 = await harness.manager.createCheckpoint('conv-1', 0, 'write_file', 'after');
            expect(cp1).not.toBeNull();
            expect(cp1!.type).toBe('full');

            // 工作区无变化 → CP-SKIP 跳过（旧行为：cp2 = 空增量节点 changes=[]；
            // 修订后：空节点与 cp1 记录的恢复状态完全相同，属冗余，直接跳过）
            const cp2 = await harness.manager.createCheckpoint('conv-1', 0, 'write_file', 'after');
            expect(cp2).toBeNull();

            // 工作区漂移：a.txt 改为 v2（与 cp1 快照不一致）
            await writeFile(workspaceRoot, 'a.txt', 'v2');

            // 恢复 cp1：链 = [cp1(full)]；a.txt 由 cp1 提供，恢复漂移文件成功
            const restore = await harness.manager.restoreCheckpoint('conv-1', cp1!.id);
            expect(restore.success).toBe(true);
            expect(restore.failures).toBeUndefined();
            await expect(fs.readFile(path.join(workspaceRoot, 'a.txt'), 'utf-8')).resolves.toBe('v1');
        } finally {
            await fs.rm(workspaceRoot, { recursive: true, force: true });
            await fs.rm(storageRoot, { recursive: true, force: true });
        }
    });

    test('M6：legacy 被清理节点并入新格式后继（跨格式布局重写），恢复后继成功', async () => {
        const workspaceRoot = await createTempDirectory('limcode-cp3-workspace-');
        const storageRoot = await createTempDirectory('limcode-cp3-storage-');
        try {
            // 与 getRuntimeWorkspaceRoots 的 mock 口径一致：folder.uri 无 authority → uriString 退化为 fsPath
            const uri = workspaceRoot;
            const rootId = createWorkspaceRootId(uri);
            const scoped = (relative: string) => `${rootId}/${relative}`;

            // 工作区当前内容（恢复目标对应的快照内容）
            await writeFile(workspaceRoot, 'a.txt', 'v2');
            await writeFile(workspaceRoot, 'b.txt', 'new');
            await writeFile(workspaceRoot, 'legacy.txt', 'legacy content');

            // legacy 完整节点 M（旧格式：相对路径布局 cp_M/relative，fileHashes 相对键）
            const legacyM: CheckpointRecord = {
                id: 'cp_M',
                conversationId: 'conv-1',
                messageIndex: 0,
                toolName: 'write_file',
                phase: 'after',
                timestamp: 1000,
                backupDir: 'cp_M',
                fileCount: 2,
                contentHash: 'm',
                type: 'full',
                fileHashes: {
                    'a.txt': md5('v1'),
                    'legacy.txt': md5('legacy content')
                },
                emptyDirs: []
            };
            const checkpointsDir = path.join(storageRoot, 'checkpoints');
            // legacy 备份目录：cp_M/a.txt(v1)、cp_M/legacy.txt（相对路径布局）
            await writeFile(checkpointsDir, 'cp_M/a.txt', 'v1');
            await writeFile(checkpointsDir, 'cp_M/legacy.txt', 'legacy content');

            // 新格式后继 B（增量 on M）：manifest scoped 布局，备份目录 cp_B/ws_xxx/...
            const manifestB: CheckpointManifest = {
                version: CHECKPOINT_MANIFEST_VERSION,
                checkpointId: 'cp_B',
                workspaceRoots: [{ id: rootId, name: 'root', uri }],
                files: {
                    [scoped('a.txt')]: { hash: md5('v2'), size: 2, mtimeMs: 0 },
                    [scoped('b.txt')]: { hash: md5('new'), size: 3, mtimeMs: 0 },
                    [scoped('legacy.txt')]: { hash: md5('legacy content'), size: 14, mtimeMs: 0 }
                },
                emptyDirs: [],
                changes: [
                    { path: scoped('a.txt'), type: 'modified' },
                    { path: scoped('b.txt'), type: 'added' }
                ],
                excluded: [],
                ignoreSnapshot: {
                    version: 1,
                    forcedRulesVersion: 1,
                    defaultProfileVersion: 1,
                    enabledProfiles: {},
                    maxFileSizeBytes: 1024,
                    customPatterns: []
                }
            };
            const recordB: CheckpointRecord = {
                id: 'cp_B',
                conversationId: 'conv-1',
                messageIndex: 1,
                toolName: 'write_file',
                phase: 'after',
                timestamp: 2000,
                backupDir: 'cp_B',
                fileCount: 2,
                contentHash: 'b',
                type: 'incremental',
                baseCheckpointId: 'cp_M',
                changes: [
                    { path: scoped('a.txt'), type: 'modified', hash: md5('v2') },
                    { path: scoped('b.txt'), type: 'added', hash: md5('new') }
                ],
                emptyDirs: [],
                workspaceRoots: [{ id: rootId, name: 'root', uri }],
                workspaceFingerprint: createWorkspaceSnapshot([{ id: rootId, name: 'root', uri } as any]).workspaceFingerprint,
                manifestVersion: CHECKPOINT_MANIFEST_VERSION
            };
            // B 的备份目录：只保存自身变更（cp_B/ws_xxx/a.txt(v2)、cp_B/ws_xxx/b.txt）
            await writeFile(checkpointsDir, `cp_B/${scoped('a.txt')}`, 'v2');
            await writeFile(checkpointsDir, `cp_B/${scoped('b.txt')}`, 'new');
            await writeFile(checkpointsDir, 'cp_B/manifest.json', JSON.stringify(manifestB, null, 2));

            const harness = await createCheckpointManagerHarness(workspaceRoot, storageRoot, [legacyM, recordB]);
            // 容量=2：创建 C 后触发 cleanup，把最旧的 legacy M 合并进 B 再删除
            harness.setCheckpointConfig({ maxCheckpoints: 2 });
            const cpC = await harness.manager.createCheckpoint('conv-1', 2, 'write_file', 'after');
            expect(cpC).not.toBeNull();

            // M 已被删除、B 重挂链（base 清空）、合并文件以 scoped 键进入 B.changes
            const stored = harness.storedCheckpoints();
            expect(stored.map(cp => cp.id)).not.toContain('cp_M');
            const storedB = stored.find(cp => cp.id === 'cp_B');
            expect(storedB).toBeDefined();
            expect(storedB!.baseCheckpointId).toBeUndefined();
            expect(storedB!.changes!.some(c => c.path === scoped('legacy.txt'))).toBe(true);

            // 工作区漂移：删掉 legacy.txt 和 b.txt，改 a.txt
            await fs.rm(path.join(workspaceRoot, 'legacy.txt'));
            await fs.rm(path.join(workspaceRoot, 'b.txt'));
            await writeFile(workspaceRoot, 'a.txt', 'v3');

            // 恢复 B：legacy.txt 必须由「跨格式布局重写后合并进 cp_B/ws_xxx/」的文件提供。
            // 修复前：fs.cp 把 legacy 文件复制到 cp_B/relative（无 ws_xxx 前缀）且 B.changes
            // 不含该路径 → 恢复 legacy.txt 报 missing_in_chain
            const restore = await harness.manager.restoreCheckpoint('conv-1', 'cp_B');
            expect(restore.success).toBe(true);
            expect(restore.failures).toBeUndefined();
            await expect(fs.readFile(path.join(workspaceRoot, 'a.txt'), 'utf-8')).resolves.toBe('v2');
            await expect(fs.readFile(path.join(workspaceRoot, 'legacy.txt'), 'utf-8')).resolves.toBe('legacy content');
            await expect(fs.readFile(path.join(workspaceRoot, 'b.txt'), 'utf-8')).resolves.toBe('new');
        } finally {
            await fs.rm(workspaceRoot, { recursive: true, force: true });
            await fs.rm(storageRoot, { recursive: true, force: true });
        }
    });

    test('L5：manifest 缺失的新格式记录恢复给出显式错误（不再“空 manifest”假成功）', async () => {
        const workspaceRoot = await createTempDirectory('limcode-cp3-workspace-');
        const storageRoot = await createTempDirectory('limcode-cp3-storage-');
        try {
            await writeFile(workspaceRoot, 'a.txt', 'hello');
            // 与 getRuntimeWorkspaceRoots 的 mock 口径一致：folder.uri 无 authority → uriString 退化为 fsPath
            const uri = workspaceRoot;
            const rootId = createWorkspaceRootId(uri);

            // 新格式记录：无 fileHashes、带 manifestVersion/workspaceRoots，但磁盘无 manifest
            const orphan: CheckpointRecord = {
                id: 'cp-orphan',
                conversationId: 'conv-1',
                messageIndex: 0,
                toolName: 'write_file',
                phase: 'after',
                timestamp: Date.now(),
                backupDir: 'cp-orphan',
                fileCount: 1,
                contentHash: 'h',
                type: 'full',
                emptyDirs: [],
                workspaceRoots: [{ id: rootId, name: 'root', uri }],
                workspaceFingerprint: createWorkspaceSnapshot([{ id: rootId, name: 'root', uri } as any]).workspaceFingerprint,
                manifestVersion: CHECKPOINT_MANIFEST_VERSION
            };
            // 备份目录存在但无 manifest.json
            await fs.mkdir(path.join(storageRoot, 'checkpoints', 'cp-orphan'), { recursive: true });

            const harness = await createCheckpointManagerHarness(workspaceRoot, storageRoot, [orphan]);
            const restore = await harness.manager.restoreCheckpoint('conv-1', 'cp-orphan');
            expect(restore.success).toBe(false);
            // CP-I18N-1: 错误串统一走 t()，文案随语言包变化，这里只断言“给出显式错误”
            expect(restore.error).toBeDefined();
            expect(restore.error!.length).toBeGreaterThan(0);
            expect(restore.restored).toBe(0);
        } finally {
            await fs.rm(workspaceRoot, { recursive: true, force: true });
            await fs.rm(storageRoot, { recursive: true, force: true });
        }
    });
});
