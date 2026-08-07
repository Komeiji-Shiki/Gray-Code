/**
 * 完整性检查工具单测（MIG-05）。
 *
 * 覆盖三类扫描：
 * - 历史：Σcount===totalMessages、段齐全、连续性、行数匹配、孤儿段、损坏 index、legacy 跳过
 * - 存档：backupDir 存在/合法、manifest 可解析/id 匹配/新格式缺失报错/旧格式警告、
 *   增量链 baseCheckpointId 引用完整、链环检测
 * - 分支：无图跳过、损坏 JSON、图结构（含 exportedRefs 悬空）、活跃路径与主历史 id 链
 *   一致/不一致、branchValidator（BranchService.validateActivePathMatchesHistory）复用路径
 * - 编排：runIntegrityCheck 全量汇总（byScope / errors / warnings / byCode）
 */

import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
    ConversationManager,
} from '../../modules/conversation/ConversationManager';
import {
    MemoryStorageAdapter,
} from '../../modules/conversation/storage';
import { BranchGraphRepository } from '../../modules/conversation/branch/BranchGraphRepository';
import { BranchService } from '../../modules/conversation/branch/BranchService';
import { createEmptyBranchGraph, importLinearHistory, insertNode } from '../../modules/conversation/branch/BranchGraph';
import type { ConversationBranchGraph, ConversationBranchNode } from '../../modules/conversation/branch/types';
import type { CheckpointRecord } from '../../modules/checkpoint/CheckpointManager';
import {
    checkBranchIntegrity,
    checkCheckpointIntegrity,
    checkHistoryIntegrity,
    listConversationIds,
    readCheckpointRecordsFromMeta,
    readHistoryIdsFromSegments,
    runIntegrityCheck,
} from '../../tools/maintenance/integrityCheck';

// ==================== 测试数据构建 ====================

/** 写入一个合法的 segmented index + 段文件（每条消息一个 id） */
async function writeSegmentedHistory(
    baseDir: string,
    conversationId: string,
    messageCount: number,
    options: {
        segmentSize?: number;
        /** 覆盖 index 的 totalMessages（制造不一致） */
        overrideTotalMessages?: number;
        /** 覆盖段 count（制造行数不一致） */
        overrideCounts?: number[];
        /** 额外写入的孤儿段文件 */
        orphanSegments?: string[];
    } = {}
): Promise<void> {
    const segmentSize = options.segmentSize ?? 200;
    const convDir = path.join(baseDir, 'conversations', conversationId);
    const historyDir = path.join(convDir, 'history');
    await fsp.mkdir(historyDir, { recursive: true });

    const segments: Array<{ file: string; startIndex: number; endIndex: number; count: number }> = [];
    for (let start = 0; start < messageCount; start += segmentSize) {
        const end = Math.min(start + segmentSize, messageCount);
        const file = `${String(segments.length).padStart(6, '0')}.ndjson`;
        const lines: string[] = [];
        for (let i = start; i < end; i++) {
            const role = i % 2 === 0 ? 'user' : 'model';
            lines.push(JSON.stringify({ id: `m${i}`, role, parts: [{ text: `msg-${i}` }], timestamp: 1000 + i }));
        }
        await fsp.writeFile(path.join(historyDir, file), lines.join('\n') + (lines.length > 0 ? '\n' : ''), 'utf8');
        segments.push({ file, startIndex: start, endIndex: end - 1, count: end - start });
    }
    if (messageCount === 0) {
        const file = '000000.ndjson';
        await fsp.writeFile(path.join(historyDir, file), '', 'utf8');
        segments.push({ file, startIndex: 0, endIndex: -1, count: 0 });
    }

    const index = {
        version: 1,
        segmentSize,
        totalMessages: options.overrideTotalMessages ?? messageCount,
        segments: segments.map((segment, i) => ({
            ...segment,
            count: options.overrideCounts?.[i] ?? segment.count,
        })),
    };
    await fsp.writeFile(path.join(convDir, 'history.index.json'), JSON.stringify(index, null, 2), 'utf8');

    for (const orphan of options.orphanSegments ?? []) {
        await fsp.writeFile(path.join(historyDir, orphan), JSON.stringify({ id: 'orphan', role: 'user', parts: [] }) + '\n', 'utf8');
    }
}

function checkpointRecord(overrides: Partial<CheckpointRecord>): CheckpointRecord {
    return {
        id: 'cp_1',
        conversationId: 'conv-1',
        messageIndex: 1,
        toolName: 'write_file',
        phase: 'before',
        timestamp: 1000,
        backupDir: 'cp_1',
        fileCount: 1,
        contentHash: 'abc',
        ...overrides,
    };
}

/** 在 checkpointsDir 下创建备份目录 + manifest */
async function writeCheckpointDir(
    checkpointsDir: string,
    id: string,
    manifest: { checkpointId?: string; files?: Record<string, unknown> } = {}
): Promise<void> {
    const dir = path.join(checkpointsDir, id);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(
        path.join(dir, 'manifest.json'),
        JSON.stringify({ version: 1, checkpointId: id, workspaceRoots: [], files: {}, ...manifest }, null, 2),
        'utf8'
    );
}

function branchNode(id: string, parentId: string | null, overrides: Partial<ConversationBranchNode> = {}): ConversationBranchNode {
    return {
        id,
        parentId,
        role: 'user',
        parts: [{ text: id }],
        kind: 'normal',
        createdAt: 1000,
        ...overrides,
    };
}

/** 写入一个分支图（与主历史 m0..mN 对齐：root=m0, child=m1, ...） */
async function writeBranchGraph(
    baseDir: string,
    conversationId: string,
    historyIds: string[],
    overrides: { extraExportedRefs?: boolean; corrupt?: boolean } = {}
): Promise<void> {
    const repo = new BranchGraphRepository(baseDir);
    let graph = createEmptyBranchGraph();
    historyIds.forEach((id, index) => {
        graph = insertNode(graph, branchNode(id, index === 0 ? null : historyIds[index - 1], {
            role: index % 2 === 0 ? 'user' : 'model',
            createdAt: index,
        }));
    });
    if (overrides.extraExportedRefs) {
        graph = {
            ...graph,
            exportedRefs: [
                { targetConversationId: 'conv-target', nodeId: 'missing-node', exportedAt: Date.now() },
            ],
        };
    }
    await repo.save(conversationId, graph);
    if (overrides.corrupt) {
        const filePath = repo.getBranchesFilePath(conversationId);
        await fsp.writeFile(filePath, '{ broken', 'utf8');
    }
}

// ==================== 历史 ====================

describe('checkHistoryIntegrity', () => {
    let tempDir: string;

    beforeEach(async () => {
        tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'integrity-history-'));
    });

    afterEach(async () => {
        await fsp.rm(tempDir, { recursive: true, force: true });
    });

    test('健康分段索引（200 条边界内）→ 无问题', async () => {
        await writeSegmentedHistory(tempDir, 'c1', 150);
        const report = await checkHistoryIntegrity(tempDir, 'c1');
        expect(report.checked).toBe(1);
        expect(report.issues).toEqual([]);
        expect(report.byCode).toEqual({});
    });

    test('多段（跨 200 条边界）且 Σcount === totalMessages → 无问题', async () => {
        await writeSegmentedHistory(tempDir, 'c1', 450);
        const report = await checkHistoryIntegrity(tempDir, 'c1');
        expect(report.checked).toBe(1);
        expect(report.issues).toEqual([]);
    });

    test('Σcount !== totalMessages → HISTORY_SEGMENT_COUNT_MISMATCH', async () => {
        await writeSegmentedHistory(tempDir, 'c1', 10, { overrideTotalMessages: 12 });
        const report = await checkHistoryIntegrity(tempDir, 'c1');
        expect(report.byCode.HISTORY_SEGMENT_COUNT_MISMATCH).toBe(1);
        expect(report.issues[0].severity).toBe('error');
    });

    test('索引引用缺失段文件 → HISTORY_SEGMENT_FILE_MISSING', async () => {
        await writeSegmentedHistory(tempDir, 'c1', 10, { segmentSize: 5 });
        // 删除第二个段文件
        await fsp.rm(path.join(tempDir, 'conversations', 'c1', 'history', '000001.ndjson'));
        const report = await checkHistoryIntegrity(tempDir, 'c1');
        expect(report.byCode.HISTORY_SEGMENT_FILE_MISSING).toBe(1);
    });

    test('段文件行数与 count 不一致 → HISTORY_SEGMENT_LINE_COUNT_MISMATCH', async () => {
        await writeSegmentedHistory(tempDir, 'c1', 10, { overrideCounts: [8] });
        const report = await checkHistoryIntegrity(tempDir, 'c1');
        expect(report.byCode.HISTORY_SEGMENT_LINE_COUNT_MISMATCH).toBe(1);
    });

    test('段起始索引不连续 → HISTORY_SEGMENT_GAP', async () => {
        const convDir = path.join(tempDir, 'conversations', 'c1');
        const historyDir = path.join(convDir, 'history');
        await fsp.mkdir(historyDir, { recursive: true });
        await fsp.writeFile(path.join(historyDir, '000000.ndjson'), '{"id":"m0","role":"user","parts":[]}\n', 'utf8');
        // 手工构造 gap：第二段 startIndex=5（期望 1）
        await fsp.writeFile(
            path.join(convDir, 'history.index.json'),
            JSON.stringify({
                version: 1,
                segmentSize: 200,
                totalMessages: 2,
                segments: [
                    { file: '000000.ndjson', startIndex: 0, endIndex: 0, count: 1 },
                    { file: '000001.ndjson', startIndex: 5, endIndex: 5, count: 1 },
                ],
            }),
            'utf8'
        );
        await fsp.writeFile(path.join(historyDir, '000001.ndjson'), '{"id":"m1","role":"model","parts":[]}\n', 'utf8');
        const report = await checkHistoryIntegrity(tempDir, 'c1');
        expect(report.byCode.HISTORY_SEGMENT_GAP).toBe(1);
        // Σcount(1+1)=2 === totalMessages(2)，故无 HISTORY_SEGMENT_COUNT_MISMATCH
        expect(report.byCode.HISTORY_SEGMENT_COUNT_MISMATCH).toBeUndefined();
    });

    test('孤儿段文件 → HISTORY_ORPHAN_SEGMENT（warning）', async () => {
        await writeSegmentedHistory(tempDir, 'c1', 10, { orphanSegments: ['999999.ndjson'] });
        const report = await checkHistoryIntegrity(tempDir, 'c1');
        expect(report.byCode.HISTORY_ORPHAN_SEGMENT).toBe(1);
        expect(report.issues.find(i => i.code === 'HISTORY_ORPHAN_SEGMENT')!.severity).toBe('warning');
    });

    test('history.index.json 损坏 → HISTORY_INDEX_CORRUPT', async () => {
        const convDir = path.join(tempDir, 'conversations', 'c1');
        await fsp.mkdir(convDir, { recursive: true });
        await fsp.writeFile(path.join(convDir, 'history.index.json'), '{ not json', 'utf8');
        const report = await checkHistoryIntegrity(tempDir, 'c1');
        expect(report.byCode.HISTORY_INDEX_CORRUPT).toBe(1);
        expect(report.checked).toBe(1);
    });

    test('无 segmented index（legacy / 空会话）→ checked=0 不报告', async () => {
        const report = await checkHistoryIntegrity(tempDir, 'c1');
        expect(report.checked).toBe(0);
        expect(report.issues).toEqual([]);
    });

    test('空历史（count=0, endIndex=-1）→ 无问题', async () => {
        await writeSegmentedHistory(tempDir, 'c1', 0);
        const report = await checkHistoryIntegrity(tempDir, 'c1');
        expect(report.issues).toEqual([]);
    });
});

// ==================== 存档 ====================

describe('checkCheckpointIntegrity', () => {
    let tempDir: string;
    let checkpointsDir: string;

    beforeEach(async () => {
        tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'integrity-cp-'));
        checkpointsDir = path.join(tempDir, 'checkpoints');
        await fsp.mkdir(checkpointsDir, { recursive: true });
    });

    afterEach(async () => {
        await fsp.rm(tempDir, { recursive: true, force: true });
    });

    test('健康：backupDir 存在 + manifest 可解析 + 增量链 base 存在 → 无问题', async () => {
        await writeCheckpointDir(checkpointsDir, 'cp_full');
        await writeCheckpointDir(checkpointsDir, 'cp_inc');
        const records = [
            checkpointRecord({ id: 'cp_full', backupDir: 'cp_full', type: 'full' }),
            checkpointRecord({
                id: 'cp_inc',
                backupDir: 'cp_inc',
                type: 'incremental',
                baseCheckpointId: 'cp_full',
                manifestVersion: 1,
            }),
        ];
        const report = await checkCheckpointIntegrity(checkpointsDir, records);
        expect(report.checked).toBe(2);
        expect(report.issues).toEqual([]);
    });

    test('backupDir 不存在 → CHECKPOINT_BACKUP_DIR_MISSING', async () => {
        const report = await checkCheckpointIntegrity(checkpointsDir, [checkpointRecord({ id: 'cp_x', backupDir: 'cp_x' })]);
        expect(report.byCode.CHECKPOINT_BACKUP_DIR_MISSING).toBe(1);
        expect(report.issues[0].severity).toBe('error');
    });

    test('backupDir 非法（路径穿越）→ CHECKPOINT_BACKUP_DIR_UNSAFE 且不再继续', async () => {
        const records = [checkpointRecord({ id: 'cp_bad', backupDir: '../escape' })];
        const report = await checkCheckpointIntegrity(checkpointsDir, records);
        expect(report.byCode.CHECKPOINT_BACKUP_DIR_UNSAFE).toBe(1);
        expect(report.byCode.CHECKPOINT_BACKUP_DIR_MISSING).toBeUndefined();
    });

    test('新格式记录（manifestVersion）但 manifest 缺失 → CHECKPOINT_MANIFEST_MISSING（error）', async () => {
        await fsp.mkdir(path.join(checkpointsDir, 'cp_new'), { recursive: true });
        const report = await checkCheckpointIntegrity(checkpointsDir, [
            checkpointRecord({ id: 'cp_new', backupDir: 'cp_new', manifestVersion: 1 }),
        ]);
        expect(report.byCode.CHECKPOINT_MANIFEST_MISSING).toBe(1);
        expect(report.issues[0].severity).toBe('error');
    });

    test('旧格式记录无 manifest → CHECKPOINT_MANIFEST_MISSING_LEGACY（warning）', async () => {
        await fsp.mkdir(path.join(checkpointsDir, 'cp_legacy'), { recursive: true });
        const report = await checkCheckpointIntegrity(checkpointsDir, [
            checkpointRecord({ id: 'cp_legacy', backupDir: 'cp_legacy' }),
        ]);
        expect(report.byCode.CHECKPOINT_MANIFEST_MISSING_LEGACY).toBe(1);
        expect(report.issues[0].severity).toBe('warning');
    });

    test('manifest 损坏 → CHECKPOINT_MANIFEST_CORRUPT', async () => {
        const dir = path.join(checkpointsDir, 'cp_bad');
        await fsp.mkdir(dir, { recursive: true });
        await fsp.writeFile(path.join(dir, 'manifest.json'), '{ broken', 'utf8');
        const report = await checkCheckpointIntegrity(checkpointsDir, [
            checkpointRecord({ id: 'cp_bad', backupDir: 'cp_bad', manifestVersion: 1 }),
        ]);
        expect(report.byCode.CHECKPOINT_MANIFEST_CORRUPT).toBe(1);
    });

    test('manifest.checkpointId 与记录不一致 → CHECKPOINT_MANIFEST_ID_MISMATCH', async () => {
        await writeCheckpointDir(checkpointsDir, 'cp_a', { checkpointId: 'cp_OTHER' });
        const report = await checkCheckpointIntegrity(checkpointsDir, [
            checkpointRecord({ id: 'cp_a', backupDir: 'cp_a', manifestVersion: 1 }),
        ]);
        expect(report.byCode.CHECKPOINT_MANIFEST_ID_MISMATCH).toBe(1);
    });

    test('增量链 baseCheckpointId 悬空 → CHECKPOINT_BASE_MISSING', async () => {
        await writeCheckpointDir(checkpointsDir, 'cp_inc');
        const report = await checkCheckpointIntegrity(checkpointsDir, [
            checkpointRecord({ id: 'cp_inc', backupDir: 'cp_inc', type: 'incremental', baseCheckpointId: 'cp_ghost' }),
        ]);
        expect(report.byCode.CHECKPOINT_BASE_MISSING).toBe(1);
    });

    test('增量链成环 → CHECKPOINT_CHAIN_CYCLE', async () => {
        await writeCheckpointDir(checkpointsDir, 'cp_a');
        await writeCheckpointDir(checkpointsDir, 'cp_b');
        const records = [
            checkpointRecord({ id: 'cp_a', backupDir: 'cp_a', type: 'incremental', baseCheckpointId: 'cp_b' }),
            checkpointRecord({ id: 'cp_b', backupDir: 'cp_b', type: 'incremental', baseCheckpointId: 'cp_a' }),
        ];
        const report = await checkCheckpointIntegrity(checkpointsDir, records);
        // 两个记录各自沿链检测都会发现环
        expect(report.byCode.CHECKPOINT_CHAIN_CYCLE).toBeGreaterThanOrEqual(1);
    });

    // ==================== CPF-LAZY-1：v2 拆分格式（manifest.json 轻量 + files.json 重量映射） ====================

    /** 写入 v2 拆分布局：manifest.json（无 files）+ files.json（重量映射） */
    async function writeSplitCheckpointDir(
        id: string,
        filesPayload: { checkpointId?: string; files?: unknown } = {}
    ): Promise<void> {
        const dir = path.join(checkpointsDir, id);
        await fsp.mkdir(dir, { recursive: true });
        await fsp.writeFile(
            path.join(dir, 'manifest.json'),
            JSON.stringify({ version: 2, checkpointId: id, workspaceRoots: [], emptyDirs: [], changes: [], excluded: [] }, null, 2),
            'utf8'
        );
        await fsp.writeFile(
            path.join(dir, 'files.json'),
            JSON.stringify({ checkpointId: id, files: { 'ws_a/a.txt': { hash: 'h', size: 1, mtimeMs: 1 } }, ...filesPayload }, null, 2),
            'utf8'
        );
    }

    test('v2 拆分格式健康：manifest.json（轻量）+ files.json 齐全 → 无问题', async () => {
        await writeSplitCheckpointDir('cp_split');
        const report = await checkCheckpointIntegrity(checkpointsDir, [
            checkpointRecord({ id: 'cp_split', backupDir: 'cp_split', manifestVersion: 2 }),
        ]);
        expect(report.issues).toEqual([]);
    });

    test('v2 拆分格式缺 files.json → CHECKPOINT_MANIFEST_FILES_MISSING（error）', async () => {
        const dir = path.join(checkpointsDir, 'cp_missing');
        await fsp.mkdir(dir, { recursive: true });
        await fsp.writeFile(
            path.join(dir, 'manifest.json'),
            JSON.stringify({ version: 2, checkpointId: 'cp_missing', workspaceRoots: [], emptyDirs: [], changes: [], excluded: [] }, null, 2),
            'utf8'
        );
        const report = await checkCheckpointIntegrity(checkpointsDir, [
            checkpointRecord({ id: 'cp_missing', backupDir: 'cp_missing', manifestVersion: 2 }),
        ]);
        expect(report.byCode.CHECKPOINT_MANIFEST_FILES_MISSING).toBe(1);
        expect(report.issues[0].severity).toBe('error');
    });

    test('v2 拆分格式 files.json 损坏 → CHECKPOINT_MANIFEST_FILES_CORRUPT', async () => {
        const dir = path.join(checkpointsDir, 'cp_corrupt');
        await fsp.mkdir(dir, { recursive: true });
        await fsp.writeFile(
            path.join(dir, 'manifest.json'),
            JSON.stringify({ version: 2, checkpointId: 'cp_corrupt', workspaceRoots: [], emptyDirs: [], changes: [], excluded: [] }, null, 2),
            'utf8'
        );
        await fsp.writeFile(path.join(dir, 'files.json'), '{ broken', 'utf8');
        const report = await checkCheckpointIntegrity(checkpointsDir, [
            checkpointRecord({ id: 'cp_corrupt', backupDir: 'cp_corrupt', manifestVersion: 2 }),
        ]);
        expect(report.byCode.CHECKPOINT_MANIFEST_FILES_CORRUPT).toBe(1);
    });

    test('v2 拆分格式 files.json.checkpointId 与记录不一致 → CHECKPOINT_MANIFEST_FILES_ID_MISMATCH', async () => {
        await writeSplitCheckpointDir('cp_idmismatch', { checkpointId: 'cp_OTHER' });
        const report = await checkCheckpointIntegrity(checkpointsDir, [
            checkpointRecord({ id: 'cp_idmismatch', backupDir: 'cp_idmismatch', manifestVersion: 2 }),
        ]);
        expect(report.byCode.CHECKPOINT_MANIFEST_FILES_ID_MISMATCH).toBe(1);
    });

    test('v2 拆分格式 files.json 缺少合法 files 映射 → CHECKPOINT_MANIFEST_FILES_INVALID_SHAPE', async () => {
        await writeSplitCheckpointDir('cp_shape', { files: 'not-a-map' });
        const report = await checkCheckpointIntegrity(checkpointsDir, [
            checkpointRecord({ id: 'cp_shape', backupDir: 'cp_shape', manifestVersion: 2 }),
        ]);
        expect(report.byCode.CHECKPOINT_MANIFEST_FILES_INVALID_SHAPE).toBe(1);
    });

    test('v1 布局（version=1）但缺内联 files → CHECKPOINT_MANIFEST_INVALID_SHAPE', async () => {
        const dir = path.join(checkpointsDir, 'cp_v1_bad');
        await fsp.mkdir(dir, { recursive: true });
        await fsp.writeFile(
            path.join(dir, 'manifest.json'),
            JSON.stringify({ version: 1, checkpointId: 'cp_v1_bad', workspaceRoots: [] }, null, 2),
            'utf8'
        );
        const report = await checkCheckpointIntegrity(checkpointsDir, [
            checkpointRecord({ id: 'cp_v1_bad', backupDir: 'cp_v1_bad', manifestVersion: 1 }),
        ]);
        expect(report.byCode.CHECKPOINT_MANIFEST_INVALID_SHAPE).toBe(1);
    });
});

// ==================== 分支 ====================

describe('checkBranchIntegrity', () => {
    let tempDir: string;

    beforeEach(async () => {
        tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'integrity-branch-'));
    });

    afterEach(async () => {
        await fsp.rm(tempDir, { recursive: true, force: true });
    });

    test('无 branches.json（线性模式）→ checked=0 不报告', async () => {
        const report = await checkBranchIntegrity({ baseDir: tempDir, conversationId: 'c1' });
        expect(report.checked).toBe(0);
        expect(report.issues).toEqual([]);
    });

    test('branches.json 损坏 → BRANCH_JSON_CORRUPT', async () => {
        await writeBranchGraph(tempDir, 'c1', ['m0', 'm1'], { corrupt: true });
        const report = await checkBranchIntegrity({ baseDir: tempDir, conversationId: 'c1' });
        expect(report.byCode.BRANCH_JSON_CORRUPT).toBe(1);
        expect(report.checked).toBe(1);
    });

    test('图合法且活跃路径与主历史 id 链一致 → 无问题', async () => {
        await writeBranchGraph(tempDir, 'c1', ['m0', 'm1', 'm2']);
        const report = await checkBranchIntegrity({
            baseDir: tempDir,
            conversationId: 'c1',
            historyIds: ['m0', 'm1', 'm2'],
        });
        expect(report.issues).toEqual([]);
    });

    test('活跃路径长度与主历史不一致 → BRANCH_ACTIVE_PATH_LENGTH_MISMATCH（warning：已知合法不一致）', async () => {
        await writeBranchGraph(tempDir, 'c1', ['m0', 'm1', 'm2']);
        const report = await checkBranchIntegrity({
            baseDir: tempDir,
            conversationId: 'c1',
            historyIds: ['m0', 'm1'], // 主历史只有 2 条
        });
        expect(report.byCode.BRANCH_ACTIVE_PATH_LENGTH_MISMATCH).toBe(1);
        // 降级为 warning：候选切换未重写主历史（TREE-06 未落地）/ append 异步并入等已知状态
        expect(report.issues[0].severity).toBe('warning');
    });

    test('活跃路径 id 与主历史逐位不一致 → BRANCH_ACTIVE_PATH_ID_MISMATCH（warning：已知合法不一致）', async () => {
        await writeBranchGraph(tempDir, 'c1', ['m0', 'm1']);
        const report = await checkBranchIntegrity({
            baseDir: tempDir,
            conversationId: 'c1',
            historyIds: ['m0', 'm9'], // m9 与图活跃路径 m1 不一致
        });
        expect(report.byCode.BRANCH_ACTIVE_PATH_ID_MISMATCH).toBe(1);
        expect(report.issues[0].severity).toBe('warning');
    });

    test('exportedRefs 引用缺失节点 → 图 validate 报告（BRANCH_BRANCH_STORAGE_CORRUPT）', async () => {
        await writeBranchGraph(tempDir, 'c1', ['m0', 'm1'], { extraExportedRefs: true });
        const report = await checkBranchIntegrity({
            baseDir: tempDir,
            conversationId: 'c1',
            historyIds: ['m0', 'm1'],
        });
        const issue = report.issues.find(item => item.code === 'BRANCH_BRANCH_STORAGE_CORRUPT');
        expect(issue).toBeTruthy();
        expect(issue!.message).toContain('exportedRefs');
    });

    test('branchValidator 复用路径：BranchService.validateActivePathMatchesHistory 校验通过 → 无问题', async () => {
        // 用真实 ConversationManager(MemoryStorageAdapter) + BranchService 构造一致状态
        const manager = new ConversationManager(new MemoryStorageAdapter());
        const repo = new BranchGraphRepository(tempDir);
        const service = new BranchService(manager, repo);
        const conversationId = 'c-branch-validator';

        await manager.createConversation(conversationId, 'T');
        await manager.addBatch(conversationId, [
            { role: 'user', parts: [{ text: 'q1' }], timestamp: 100 },
            { role: 'model', parts: [{ text: 'a1' }], timestamp: 200 },
        ]);
        const history = await manager.getMessagesRaw(conversationId);
        const graph = importLinearHistory(history);
        await service.saveBranchGraph(conversationId, graph);

        const report = await checkBranchIntegrity({
            baseDir: tempDir,
            conversationId,
            branchValidator: id => service.validateActivePathMatchesHistory(id),
        });
        expect(report.checked).toBe(1);
        expect(report.issues).toEqual([]);
    });

    test('branchValidator 复用路径：主历史与图不一致 → 报告问题', async () => {
        const manager = new ConversationManager(new MemoryStorageAdapter());
        const repo = new BranchGraphRepository(tempDir);
        const service = new BranchService(manager, repo);
        const conversationId = 'c-branch-validator-bad';

        await manager.createConversation(conversationId, 'T');
        await manager.addBatch(conversationId, [
            { role: 'user', parts: [{ text: 'q1' }], timestamp: 100 },
            { role: 'model', parts: [{ text: 'a1' }], timestamp: 200 },
        ]);
        // 写入与主历史不一致的图（root 不同 id）
        const history = await manager.getMessagesRaw(conversationId);
        let graph = createEmptyBranchGraph();
        graph = insertNode(graph, branchNode('not-the-root', null, { role: 'user', createdAt: 1 }));
        graph = insertNode(graph, branchNode('other', 'not-the-root', { role: 'model', createdAt: 2 }));
        await service.saveBranchGraph(conversationId, graph);

        const report = await checkBranchIntegrity({
            baseDir: tempDir,
            conversationId,
            branchValidator: id => service.validateActivePathMatchesHistory(id),
        });
        expect(report.byCode.BRANCH_ACTIVE_PATH_MISMATCH).toBeGreaterThanOrEqual(1);
        // 活跃路径比较问题降级为 warning（图结构 validate 问题仍为 error）
        expect(report.issues.every(item => item.severity === 'warning')).toBe(true);
        void history;
    });
});

// ==================== 编排 ====================

describe('runIntegrityCheck / 辅助函数', () => {
    let tempDir: string;
    let checkpointsDir: string;

    beforeEach(async () => {
        tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'integrity-run-'));
        checkpointsDir = path.join(tempDir, 'checkpoints');
        await fsp.mkdir(checkpointsDir, { recursive: true });
    });

    afterEach(async () => {
        await fsp.rm(tempDir, { recursive: true, force: true });
    });

    test('listConversationIds 只返回目录（会话目录）', async () => {
        await fsp.mkdir(path.join(tempDir, 'conversations', 'c1'), { recursive: true });
        await fsp.writeFile(path.join(tempDir, 'conversations', 'c1.meta.json'), '{}', 'utf8');
        expect(await listConversationIds(tempDir)).toEqual(['c1']);
    });

    test('readCheckpointRecordsFromMeta / readHistoryIdsFromSegments 只读解析', async () => {
        const records = [checkpointRecord({ id: 'cp_1', backupDir: 'cp_1' })];
        await fsp.mkdir(path.join(tempDir, 'conversations', 'c1'), { recursive: true });
        await fsp.writeFile(
            path.join(tempDir, 'conversations', 'c1.meta.json'),
            JSON.stringify({ id: 'c1', title: 'T', custom: { checkpoints: records } }),
            'utf8'
        );
        await writeSegmentedHistory(tempDir, 'c1', 4);
        expect(await readCheckpointRecordsFromMeta(tempDir, 'c1')).toEqual(records);
        expect(await readHistoryIdsFromSegments(tempDir, 'c1')).toEqual(['m0', 'm1', 'm2', 'm3']);
    });

    test('全量扫描：健康会话无问题、损坏会话按 scope 汇总', async () => {
        // 会话 A：历史健康 + 存档健康 + 分支一致
        await writeSegmentedHistory(tempDir, 'conv-a', 2);
        await writeCheckpointDir(checkpointsDir, 'cp_a');
        await fsp.mkdir(path.join(tempDir, 'conversations'), { recursive: true });
        await fsp.writeFile(
            path.join(tempDir, 'conversations', 'conv-a.meta.json'),
            JSON.stringify({
                id: 'conv-a',
                custom: { checkpoints: [checkpointRecord({ id: 'cp_a', backupDir: 'cp_a', conversationId: 'conv-a' })] },
            }),
            'utf8'
        );
        await writeBranchGraph(tempDir, 'conv-a', ['m0', 'm1']);

        // 会话 B：历史 Σcount 不一致 + 存档 backupDir 缺失 + 分支损坏
        await writeSegmentedHistory(tempDir, 'conv-b', 3, { overrideTotalMessages: 5 });
        await fsp.writeFile(
            path.join(tempDir, 'conversations', 'conv-b.meta.json'),
            JSON.stringify({
                id: 'conv-b',
                custom: { checkpoints: [checkpointRecord({ id: 'cp_b', backupDir: 'cp_b', conversationId: 'conv-b' })] },
            }),
            'utf8'
        );
        await writeBranchGraph(tempDir, 'conv-b', ['m0', 'm1'], { corrupt: true });

        const report = await runIntegrityCheck({ baseDir: tempDir, checkpointsDir });

        expect(report.summary.byScope.history).toBe(1); // 仅 conv-b 的 Σcount 问题
        expect(report.summary.byScope.checkpoint).toBe(1); // conv-b 的 backupDir 缺失
        expect(report.summary.byScope.branch).toBe(1); // conv-b 的 branches.json 损坏
        expect(report.summary.errors).toBe(3);
        expect(report.summary.totalIssues).toBe(3);
        expect(report.history.byCode.HISTORY_SEGMENT_COUNT_MISMATCH).toBe(1);
        expect(report.checkpoint.byCode.CHECKPOINT_BACKUP_DIR_MISSING).toBe(1);
        expect(report.branch.byCode.BRANCH_JSON_CORRUPT).toBe(1);
        expect(report.history.checked).toBe(2);
        expect(report.checkpoint.checked).toBe(2);
        expect(report.branch.checked).toBe(2);
    });

    test('conversationIds 限定扫描范围', async () => {
        await writeSegmentedHistory(tempDir, 'conv-a', 10);
        await writeSegmentedHistory(tempDir, 'conv-b', 10, { overrideTotalMessages: 99 });
        const report = await runIntegrityCheck({ baseDir: tempDir, checkpointsDir, conversationIds: ['conv-a'] });
        expect(report.summary.byScope.history).toBe(0);
        expect(report.history.checked).toBe(1);
    });

    test('getCheckpointRecords 提供者注入生效', async () => {
        await writeSegmentedHistory(tempDir, 'conv-a', 2);
        await writeCheckpointDir(checkpointsDir, 'cp_a');
        await fsp.writeFile(
            path.join(tempDir, 'conversations', 'conv-a.meta.json'),
            JSON.stringify({ id: 'conv-a', custom: {} }), // meta 里没有 checkpoints
            'utf8'
        );
        const report = await runIntegrityCheck({
            baseDir: tempDir,
            checkpointsDir,
            getCheckpointRecords: async () => [
                checkpointRecord({ id: 'cp_a', backupDir: 'cp_a', conversationId: 'conv-a' }),
            ],
        });
        expect(report.checkpoint.checked).toBe(1);
        expect(report.checkpoint.issues).toEqual([]);
    });
});
