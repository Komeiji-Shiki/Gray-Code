/**
 * MIG-09 基准 ①：大工作区 checkpoint 快照创建 / 恢复（2000 文件）。
 *
 * 覆盖生产模块：
 * - buildWorkspaceSnapshot（CheckpointSnapshotBuilder）：扫描 + stat + 流式哈希
 * - restoreWorkspaceSnapshot（CheckpointRestoreEngine）：增量链索引 + 恢复计划 +
 *   哈希校验 + 复制 + 删除
 *
 * 恢复测量（R8e-FIX F1 修正）：恢复目标 = 已漂移的工作区自身（非空目标目录），
 * 覆盖恢复引擎关键路径：
 * - 漂移删除的文件（当前缺失）→ plan.added → 从备份复制回来（restored）；
 * - 漂移修改的文件（哈希不同）→ plan.modified → 从备份回滚（restored）；
 * - 未变化文件 → plan.skipped（增量跳过）；
 * - 快照后新建文件 → 删除白名单（deletableScopedPaths）之外 → untrackedToDelete →
 *   默认保留（#29 语义，deleted=0）；不传白名单时按默认语义删除（对照段）；
 * - 备份内容哈希校验失败 → failures[hash_mismatch]（完整性路径，不落盘）。
 *
 * 全部数据落在 os.tmpdir() 临时目录，完成后清理，不触碰真实数据目录。
 *
 * 运行方式（仓库根目录；命令中的 glob 见 test/benchmark/README.md）：
 *   npx jest --config jest.backend.config.js --testMatch <glob> --runInBand --testTimeout 600000
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import { buildWorkspaceSnapshot } from '../../backend/modules/checkpoint/CheckpointSnapshotBuilder';
import { restoreWorkspaceSnapshot } from '../../backend/modules/checkpoint/CheckpointRestoreEngine';
import { createRuntimeWorkspaceRoots } from '../../backend/modules/checkpoint/CheckpointWorkspace';
import type { RuntimeWorkspaceRoot } from '../../backend/modules/checkpoint/CheckpointWorkspace';
import {
    countFilesAndBytes,
    makeTempDir,
    printHarnessBanner,
    printMetric,
    printSection,
    removeTempDir,
    withTiming,
} from './benchmarkHarness';

jest.setTimeout(600000);

const DIR_COUNT = 40;
const FILES_PER_DIR = 50;
const FILE_COUNT = DIR_COUNT * FILES_PER_DIR; // 2000
const LINES_PER_FILE = 200;
const BACKUP_DIR_NAME = 'cp_bench';

/** 生成 2000 个文件的临时工作区（40 目录 × 50 文件，每文件约 3KB）。 */
async function createWorkspace(dir: string): Promise<void> {
    const line = '// GrayCode benchmark fixture line with some padding content for hashing realism.';
    for (let d = 0; d < DIR_COUNT; d++) {
        const dirPath = path.join(dir, `src/module_${String(d).padStart(3, '0')}`);
        await fs.mkdir(dirPath, { recursive: true });
        for (let f = 0; f < FILES_PER_DIR; f++) {
            const lines: string[] = [];
            for (let i = 0; i < LINES_PER_FILE; i++) {
                lines.push(`${line} d=${d} f=${f} line=${i}`);
            }
            await fs.writeFile(path.join(dirPath, `file_${String(f).padStart(3, '0')}.ts`), lines.join('\n') + '\n', 'utf8');
        }
    }
}

describe('基准 ① 大工作区 checkpoint', () => {
    let rootDir: string;
    let wsDir: string;
    let checkpointsDir: string;
    let roots: RuntimeWorkspaceRoot[];

    beforeEach(async () => {
        rootDir = await makeTempDir('checkpoint');
        wsDir = path.join(rootDir, 'workspace');
        checkpointsDir = path.join(rootDir, 'checkpoints');
        await fs.mkdir(wsDir, { recursive: true });
        await fs.mkdir(checkpointsDir, { recursive: true });
        roots = createRuntimeWorkspaceRoots([{ name: 'main', uri: `file://${wsDir}`, fsPath: wsDir }]);
    });

    afterEach(async () => {
        await removeTempDir(rootDir);
    });

    test('2000 文件：快照创建与「增量恢复到已漂移工作区」', async () => {
        printHarnessBanner();
        printSection('MIG-09 基准 ① 大工作区 checkpoint（2000 文件，临时目录）');
        const wsStats = await countFilesAndBytes(wsDir);
        printMetric({
            label: '准备：空工作区基线',
            ms: 0,
            heapDeltaMB: 0,
            data: { files: wsStats.files, bytes: wsStats.bytes },
        });

        // ---- 准备 2000 文件工作区 ----
        const prepared = await withTiming(() => createWorkspace(wsDir));
        const afterCreate = await countFilesAndBytes(wsDir);
        printMetric({
            label: '准备：写入 2000 文件（不计入基准）',
            ms: prepared.ms,
            heapDeltaMB: prepared.heapDeltaMB,
            data: { files: afterCreate.files, bytes: afterCreate.bytes },
        });

        // ---- 0. JIT 预热（F8 同款思路）：主测量前先对一个小工作区（10 文件）跑一次
        // 完整 buildWorkspaceSnapshot，把扫描/stat/流式哈希链路的 JIT 编译与冷缓存开销
        // 移出主测量，使打印数字更接近稳态性能（预热结果丢弃）----
        const warmDir = path.join(rootDir, 'warmup');
        await fs.mkdir(warmDir, { recursive: true });
        for (let i = 0; i < 10; i++) {
            await fs.writeFile(path.join(warmDir, `warm_${i}.ts`), `// warmup file ${i}\n`, 'utf8');
        }
        await buildWorkspaceSnapshot({
            roots: createRuntimeWorkspaceRoots([{ name: 'warm', uri: `file://${warmDir}`, fsPath: warmDir }]),
            concurrency: 8,
        });

        // ---- 1. 快照创建：buildWorkspaceSnapshot ----
        // R8e-FIX F2：checkpointsDir 位于扫描根（wsDir）之外，excludeAbsolutePaths 传它也
        // 永不命中，属无效配置——不再传排除项（若要排除应把目录移入 wsDir 内再排除）。
        const build = await withTiming(() => buildWorkspaceSnapshot({
            roots,
            concurrency: 8,
        }));
        const snapshot = build.result;
        expect(Object.keys(snapshot.fileHashes).length).toBe(FILE_COUNT);
        printMetric({
            label: '创建：buildWorkspaceSnapshot（扫描+stat+哈希）',
            ms: build.ms,
            heapDeltaMB: build.heapDeltaMB,
            data: { files: Object.keys(snapshot.fileHashes).length, emptyDirs: snapshot.emptyDirs.length },
        });

        // ---- 2. 创建阶段落盘备份（把文件复制到存档目录，模拟 createCheckpoint 的备份步骤）----
        // 2000 文件逐文件串行 copyFile 是纯 IO 等待：改为 8 并发 worker 池（共享游标取任务，
        // 无重复无遗漏；mkdir recursive 幂等，并发创建父目录安全），与快照构建的 concurrency: 8 对齐。
        const BACKUP_CONCURRENCY = 8;
        const backupRoot = path.join(checkpointsDir, BACKUP_DIR_NAME);
        const backup = await withTiming(async () => {
            const keys = Object.keys(snapshot.fileHashes);
            let next = 0;
            // 任一 worker 复制失败后置中止标志：其余 worker 在下一轮循环检查到标志后提前退出，
            // 不再继续领取新任务后台复制（避免与 afterEach 的 removeTempDir 产生竞态）
            let failed = false;
            const workers = Array.from({ length: BACKUP_CONCURRENCY }, async () => {
                while (next < keys.length && !failed) {
                    const scopedKey = keys[next++];
                    const relative = scopedKey.slice(roots[0].id.length + 1); // 去掉 "<rootId>/" 前缀
                    const src = path.join(wsDir, relative);
                    const dest = path.join(backupRoot, scopedKey);
                    try {
                        await fs.mkdir(path.dirname(dest), { recursive: true });
                        await fs.copyFile(src, dest);
                    } catch (err) {
                        failed = true; // 首个失败即中止其余 worker；异常由下方 allSettled 收拢后统一抛出
                        throw err;
                    }
                }
            });
            // 失败路径（与 afterEach removeTempDir 的残余竞态）：Promise.all 在首个 worker
            // reject 时立即向上抛，其余 worker 的在途 copyFile 仍在后台进行——测试失败后
            // afterEach 开始删除临时目录时可能仍有 worker 在写文件。改用 Promise.allSettled
            // 等待全部 worker 退出（含在途 IO 完成）后再统一抛首个错误，清理前不再有在途写。
            const results = await Promise.allSettled(workers);
            const firstRejected = results.find((r) => r.status === 'rejected');
            if (firstRejected) throw firstRejected.reason;
        });
        printMetric({
            label: '创建：文件备份到存档目录（copy）',
            ms: backup.ms,
            heapDeltaMB: backup.heapDeltaMB,
            data: { files: Object.keys(snapshot.fileHashes).length },
        });

        // ---- 3. 工作区漂移：删除部分文件 + 修改部分文件 + 新建文件 ----
        const drift = await withTiming(async () => {
            const keys = Object.keys(snapshot.fileHashes);
            const deleted = keys.filter((_, i) => i % 7 === 0);
            const modified = keys.filter((_, i) => i % 11 === 0);
            for (const scopedKey of deleted) {
                await fs.rm(path.join(wsDir, scopedKey.slice(roots[0].id.length + 1)), { force: true });
            }
            for (const scopedKey of modified) {
                await fs.appendFile(path.join(wsDir, scopedKey.slice(roots[0].id.length + 1)), '\n// drift\n', 'utf8');
            }
            await fs.writeFile(path.join(wsDir, 'untracked_new.txt'), 'new file after snapshot', 'utf8');
            return { deleted: deleted.length, modified: modified.length };
        });
        printMetric({
            label: '准备：制造工作区漂移（删除/修改/新建）',
            ms: drift.ms,
            heapDeltaMB: drift.heapDeltaMB,
            data: { deletedOps: drift.result.deleted, modifiedOps: drift.result.modified },
        });

        // ---- 4. 重扫漂移后工作区状态（恢复输入 currentHashes / currentEmptyDirs）----
        // 注：i%7 与 i%11 重叠的文件（i%77）先被删除、再由 appendFile 重建为漂移内容，
        // 因此「漂移删除操作数」≠「当前缺失文件数」；期望值一律以重扫结果为准（与恢复计划一致）。
        const rescanned = await withTiming(() => buildWorkspaceSnapshot({ roots, concurrency: 8 }));
        const driftedHashes = rescanned.result.fileHashes;
        let expectedAdded = 0;
        let expectedModified = 0;
        let expectedSkipped = 0;
        for (const [key, hash] of Object.entries(snapshot.fileHashes)) {
            if (!(key in driftedHashes)) {
                expectedAdded++;
            } else if (driftedHashes[key] !== hash) {
                expectedModified++;
            } else {
                expectedSkipped++;
            }
        }
        printMetric({
            label: '准备：重扫漂移后状态（恢复输入）',
            ms: rescanned.ms,
            heapDeltaMB: rescanned.heapDeltaMB,
            data: { files: Object.keys(driftedHashes).length, added: expectedAdded, modified: expectedModified, skipped: expectedSkipped },
        });

        // ---- 5. 恢复（主测量）：增量恢复到已漂移工作区自身 ----
        // 恢复目标 = 已漂移的 wsDir（同一工作区身份 roots）；删除白名单 = 快照清单，
        // 使「快照后新建文件」落入 untrackedToDelete（默认保留 → deleted=0），即 #29 保留语义。
        // 漂移删除的文件不在当前状态 → plan.added → 从备份复制（restored）；
        // 漂移修改的文件哈希不同 → plan.modified → 从备份回滚（restored）；
        // 未变化文件 → plan.skipped。断言均与恢复计划一致。
        const restore = await withTiming(() => restoreWorkspaceSnapshot(
            {
                checkpointsDir,
                roots,
                concurrency: 8,
                deletableScopedPaths: new Set(Object.keys(snapshot.fileHashes)),
            },
            [{ checkpointId: BACKUP_DIR_NAME, backupDir: BACKUP_DIR_NAME, fileHashes: snapshot.fileHashes }],
            { fileHashes: snapshot.fileHashes, emptyDirs: snapshot.emptyDirs },
            driftedHashes,
            rescanned.result.emptyDirs
        ));
        const restoreResult = restore.result;
        expect(restoreResult.success).toBe(true);
        expect(restoreResult.restored).toBe(expectedAdded + expectedModified); // 漂移删除→复制回来 + 漂移修改→回滚
        expect(restoreResult.skipped).toBe(expectedSkipped);
        expect(restoreResult.deleted).toBe(0); // 与恢复计划一致：untracked 保留（白名单外，deleted=0）
        expect(restoreResult.failures).toEqual([]);
        // untracked 保留判定：快照后新建文件未被删除
        await expect(fs.stat(path.join(wsDir, 'untracked_new.txt'))).resolves.toMatchObject({
            size: Buffer.byteLength('new file after snapshot')
        });
        printMetric({
            label: '恢复（增量，目标=已漂移工作区）',
            ms: restore.ms,
            heapDeltaMB: restore.heapDeltaMB,
            data: {
                added: expectedAdded,
                modified: expectedModified,
                skipped: restoreResult.skipped,
                deleted: restoreResult.deleted,
                untrackedPreserved: 1,
                perFileMs: +(restore.ms / (expectedAdded + expectedModified)).toFixed(3),
            },
        });

        // ---- 恢复正确性验证：工作区回到快照状态（2000 文件哈希一致）+ untracked 保留 ----
        const verified = await buildWorkspaceSnapshot({ roots, concurrency: 8 });
        let mismatch = 0;
        for (const [key, hash] of Object.entries(snapshot.fileHashes)) {
            if (verified.fileHashes[key] !== hash) {
                mismatch++;
            }
        }
        expect(mismatch).toBe(0);
        expect(Object.keys(verified.fileHashes).length).toBe(FILE_COUNT + 1);

        // ---- 6. 恢复（删除路径对照）：不传删除白名单 → 未跟踪文件按默认语义删除 ----
        await fs.writeFile(path.join(wsDir, 'untracked_new2.txt'), 'another untracked file', 'utf8');
        // 重建当前状态快照（含新建的 untracked_new2.txt），与主测量一致地作为恢复输入
        const defaultState = await buildWorkspaceSnapshot({ roots, concurrency: 8 });
        const restoreDefault = await withTiming(() => restoreWorkspaceSnapshot(
            { checkpointsDir, roots, concurrency: 8 },
            [{ checkpointId: BACKUP_DIR_NAME, backupDir: BACKUP_DIR_NAME, fileHashes: snapshot.fileHashes }],
            { fileHashes: snapshot.fileHashes, emptyDirs: snapshot.emptyDirs },
            defaultState.fileHashes,
            defaultState.emptyDirs
        ));
        const defaultResult = restoreDefault.result;
        expect(defaultResult.success).toBe(true);
        expect(defaultResult.deleted).toBe(2); // untracked_new.txt + untracked_new2.txt（默认语义可删）
        expect(defaultResult.restored).toBe(0);
        const afterDefault = await countFilesAndBytes(wsDir);
        expect(afterDefault.files).toBe(FILE_COUNT);
        printMetric({
            label: '恢复（删除路径对照：无白名单）',
            ms: restoreDefault.ms,
            heapDeltaMB: restoreDefault.heapDeltaMB,
            data: { deleted: defaultResult.deleted, restored: defaultResult.restored, skipped: defaultResult.skipped },
        });

        // ---- 7. 恢复完整性：备份内容哈希校验失败（损坏备份）----
        // 触发 engine 的 hashFileStreaming(backup) vs indexEntry.hash 校验失败路径：
        // 删除目标文件（进 plan.added）并破坏其备份内容 → 恢复应失败且不落盘。
        const targetKey = Object.keys(snapshot.fileHashes)[0];
        const targetRel = targetKey.slice(roots[0].id.length + 1);
        await fs.rm(path.join(wsDir, targetRel), { force: true });
        await fs.writeFile(path.join(backupRoot, targetKey), 'corrupted backup content', 'utf8');
        const currentHashes = { ...snapshot.fileHashes };
        delete currentHashes[targetKey];
        const corruptRestore = await withTiming(() => restoreWorkspaceSnapshot(
            {
                checkpointsDir,
                roots,
                concurrency: 8,
                deletableScopedPaths: new Set(Object.keys(snapshot.fileHashes)),
            },
            [{ checkpointId: BACKUP_DIR_NAME, backupDir: BACKUP_DIR_NAME, fileHashes: snapshot.fileHashes }],
            { fileHashes: snapshot.fileHashes, emptyDirs: snapshot.emptyDirs },
            currentHashes,
            snapshot.emptyDirs
        ));
        const corruptResult = corruptRestore.result;
        expect(corruptResult.success).toBe(false);
        expect(corruptResult.failures.some(f => f.path === targetKey && f.reason === 'hash_mismatch')).toBe(true);
        expect(corruptResult.restored).toBe(0); // 哈希校验失败不落盘
        await expect(fs.stat(path.join(wsDir, targetRel))).rejects.toMatchObject({ code: 'ENOENT' });
        printMetric({
            label: '恢复（完整性：备份哈希校验失败）',
            ms: corruptRestore.ms,
            heapDeltaMB: corruptRestore.heapDeltaMB,
            data: { failures: corruptResult.failures.length, restored: corruptResult.restored, deleted: corruptResult.deleted },
        });

        // ---- smoke 断言（校准：2026-08-04 R8e-FIX 实测 build ~0.3s / 备份 ~2s /
        //      增量恢复 < 1s；上限 15s ≈ 15-75×，防 CI 慢机误报）----
        expect(build.ms).toBeLessThan(15_000);
        expect(backup.ms).toBeLessThan(15_000);
        expect(restore.ms).toBeLessThan(15_000);
        expect(restoreDefault.ms).toBeLessThan(15_000);
        expect(corruptRestore.ms).toBeLessThan(15_000);

        console.log(
            `\n  [smoke] checkpoint build ${build.ms.toFixed(1)}ms / 备份 ${backup.ms.toFixed(1)}ms / 增量恢复 ${restore.ms.toFixed(1)}ms（上限 15000ms）→ OK`
        );
    });
});
