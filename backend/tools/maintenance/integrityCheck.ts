/**
 * 完整性检查工具（MIG-05）。
 *
 * 纯只读一致性扫描，覆盖三类数据：
 * 1. 历史：segmented index（history.index.json）与段文件（history/*.ndjson）一致
 *    —— Σsegments.count === totalMessages、段齐全、连续无缺口、行数与 count 匹配、无孤儿段；
 * 2. 存档：CheckpointRecord 与备份目录 / manifest 对应
 *    —— backupDir 存在且为合法目录名、manifest.json 可解析且 checkpointId 匹配、
 *      增量链 baseCheckpointId 引用完整且无环；
 * 3. 分支：branches.json 可解析、图结构合法、活跃路径与主历史消息 id 链一致、
 *    exportedFrom / exportedRefs 引用存在（复用 BranchGraph.validate）。
 *
 * 分支-主历史对比的严重度说明（重要）：
 * - 图结构校验（BranchGraph.validate）问题保持 error——activeChildId 悬空、父引用缺失等
 *   说明 branches.json 本身损坏，必须人工介入；
 * - 活跃路径与主历史 id 链不一致降级为 warning——以下已知合法状态会使两者暂时/持续不一致，
 *   不代表数据损坏（R8e-FIX 2026-08-04 复核：TREE-06 已落地，原「切换只切图」条已移除）：
 *   ① appendHistoryToGraph 是 fire-and-forget 且失败仅告警（写锁不可重入，promise 链排队；
 *      历史可能暂时领先于图，图同步失败由下次读图/写图自校验兜底）；
 *   ② startReroll 图变更（写锁内）与主历史截断（锁外）非原子（中间窗由 finishReroll 回填兜底）；
 *   ③ 消息删除路径（deleteMessagesInRange）只删主历史、不同步删图节点——这是**有意保留**的
 *      （startReroll / 编辑分支截断用 deleteMessagesInRange，旧候选要保留进 sidecar）；
 *      deleteToMessage（经 ChatFlowService 接线）与 deleteMessage（单条删除）已同步软删图节点
 *      （决策 6：被删节点及后续子树标记 deleted + deletedAt，活跃尾回退）。
 *   保持降级为 warning 的决定不变（①②③ 仍存在）；下次复核时间点：TREE-13 流式互斥落地，
 *   或任何一次相关改动合入后。
 *
 * 设计约束：
 * - 只报告，不自动修复；输出结构化报告（每类问题计数 + 完整问题清单作示例）。
 * - 运行时不依赖 vscode / ConversationManager / CheckpointManager 实例：
 *   存档记录默认从 {baseDir}/conversations/{id}.meta.json 的 custom.checkpoints 读取
 *   （与 CheckpointQueryService 同一数据源），也可注入 getCheckpointRecords。
 * - 分支-主历史一致性默认走内置只读轻量比较（读分段文件消息 id）；也可注入
 *   branchValidator（即 BranchService.validateActivePathMatchesHistory）复用完整校验。
 *
 * 命令入口（后续接线）：在扩展注册一个 maintenance.runIntegrityCheck 命令，用
 * StoragePathManager.getEffectiveDataPath() 作为 baseDir、checkpointsDir 取
 * CheckpointManager 的 checkpointsDir，传入 BranchService 实例即可。
 */

import * as fsp from 'fs/promises';
import * as path from 'path';
import type { Dirent, Stats } from 'fs';
import { activePath, isFunctionResponseMessage, validate } from '../../modules/conversation/branch/BranchGraph';
import { BranchGraphRepository } from '../../modules/conversation/branch/BranchGraphRepository';
import type { BranchPathConsistencyResult } from '../../modules/conversation/branch/BranchService';
import type { ConversationBranchGraph } from '../../modules/conversation/branch/types';
import { isSafeCheckpointDirName } from '../../modules/checkpoint/CheckpointManifestRepository';
import type { CheckpointRecord } from '../../modules/checkpoint/CheckpointManager';

export type IntegrityScope = 'history' | 'checkpoint' | 'branch';

export interface IntegrityIssue {
    scope: IntegrityScope;
    /** error = 数据不一致/数据丢失风险；warning = 兼容性/清理提示 */
    severity: 'error' | 'warning';
    conversationId?: string;
    checkpointId?: string;
    /** 稳定机器码（如 HISTORY_SEGMENT_COUNT_MISMATCH），便于计数与自动化处理 */
    code: string;
    message: string;
    /** 附加结构化信息（如节点 id、期望/实际值） */
    detail?: Record<string, unknown>;
}

export interface IntegritySectionReport {
    /** 实际执行了检查的条目数（如含 segmented index 的会话数 / 存档记录数 / 含分支图的会话数） */
    checked: number;
    /** 按问题码计数（每类问题计数） */
    byCode: Record<string, number>;
    /** 问题清单（含 message 即为示例） */
    issues: IntegrityIssue[];
}

export interface IntegrityReport {
    generatedAt: number;
    baseDir: string;
    checkpointsDir: string;
    summary: {
        totalIssues: number;
        errors: number;
        warnings: number;
        byScope: Record<IntegrityScope, number>;
    };
    history: IntegritySectionReport;
    checkpoint: IntegritySectionReport;
    branch: IntegritySectionReport;
}

function issue(
    scope: IntegrityScope,
    severity: IntegrityIssue['severity'],
    code: string,
    message: string,
    extra: { conversationId?: string; checkpointId?: string; detail?: Record<string, unknown> } = {}
): IntegrityIssue {
    return { scope, severity, code, message, ...extra };
}

function toSectionReport(issues: IntegrityIssue[], checked: number): IntegritySectionReport {
    const byCode: Record<string, number> = {};
    for (const item of issues) {
        byCode[item.code] = (byCode[item.code] ?? 0) + 1;
    }
    return { checked, byCode, issues };
}

// ==================== 1. 历史：segmented index vs 段文件 ====================

interface SegmentIndexEntryLike {
    file?: unknown;
    startIndex?: unknown;
    endIndex?: unknown;
    count?: unknown;
}

interface SegmentIndexLike {
    version?: unknown;
    totalMessages?: unknown;
    segments?: SegmentIndexEntryLike[];
}

/**
 * 段文件名白名单校验（路径穿越防护）。
 * history.index.json 的 segment.file 来自磁盘索引，可能被手工编辑、损坏或恶意构造；
 * 在拼进 path.join(historyDir, file) 之前必须保证它是纯文件名，解析后必然落在
 * history/ 目录内（等价于「单层文件名」：非空、不含 / 和 \、不是 . / ..、
 * 不含绝对路径/盘符前缀）。合法段文件名为 `000000.ndjson` 这类纯数字+后缀。
 * 非法时调用方跳过该段（不读盘）并记 warning，与索引损坏的处理风格一致。
 */
function isSafeSegmentFileName(file: string): boolean {
    if (typeof file !== 'string' || file.length === 0) {
        return false;
    }
    if (file === '.' || file === '..' || file.includes('\0')) {
        return false;
    }
    // 拒绝路径分隔符（含 Windows 反斜杠）与绝对路径/盘符前缀
    if (file.includes('/') || file.includes('\\')) {
        return false;
    }
    if (path.isAbsolute(file) || /^[a-zA-Z]:/.test(file)) {
        return false;
    }
    return true;
}

/**
 * 检查单个会话的分段历史一致性。
 * 无 history.index.json（legacy 单文件 / 空会话）→ checked=0 且不报告（不属于 segmented 格式）。
 */
export async function checkHistoryIntegrity(
    baseDir: string,
    conversationId: string
): Promise<IntegritySectionReport> {
    const convDir = path.join(baseDir, 'conversations', conversationId);
    const indexPath = path.join(convDir, 'history.index.json');
    const historyDir = path.join(convDir, 'history');
    const issues: IntegrityIssue[] = [];

    let raw: string;
    try {
        raw = await fsp.readFile(indexPath, 'utf8');
    } catch {
        return toSectionReport([], 0); // legacy / 无历史
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        issues.push(issue('history', 'error', 'HISTORY_INDEX_CORRUPT',
            `history.index.json 解析失败: ${(error as Error)?.message ?? String(error)}`, { conversationId }));
        return toSectionReport(issues, 1);
    }
    const index = parsed as SegmentIndexLike;
    if (typeof index.totalMessages !== 'number' || !Array.isArray(index.segments)) {
        issues.push(issue('history', 'error', 'HISTORY_INDEX_INVALID_SHAPE',
            'history.index.json 缺少 totalMessages 或 segments 字段', { conversationId }));
        return toSectionReport(issues, 1);
    }

    // Σcount === totalMessages
    const sumCount = index.segments.reduce(
        (sum, segment) => sum + (typeof segment.count === 'number' ? segment.count : 0),
        0
    );
    if (sumCount !== index.totalMessages) {
        issues.push(issue('history', 'error', 'HISTORY_SEGMENT_COUNT_MISMATCH',
            `Σsegments.count (${sumCount}) !== totalMessages (${index.totalMessages})`, { conversationId }));
    }

    // 段齐全 + 连续性 + 行数
    let expectedStart = 0;
    const indexedFiles = new Set<string>();
    for (let i = 0; i < index.segments.length; i++) {
        const segment = index.segments[i];
        const file = typeof segment.file === 'string' ? segment.file : '';
        if (!file) {
            issues.push(issue('history', 'error', 'HISTORY_SEGMENT_MISSING_FILE',
                `segments[${i}] 缺少 file 字段`, { conversationId }));
            continue;
        }
        // 路径穿越防护：非法段文件名（含路径分隔符/绝对路径等）不拼路径、不读盘，跳过该段
        if (!isSafeSegmentFileName(file)) {
            issues.push(issue('history', 'warning', 'HISTORY_SEGMENT_UNSAFE_FILE',
                `段文件名非法（疑似路径穿越），已跳过: ${file}`, { conversationId, detail: { file } }));
            continue;
        }
        indexedFiles.add(file);
        if (
            typeof segment.startIndex !== 'number' ||
            typeof segment.endIndex !== 'number' ||
            typeof segment.count !== 'number'
        ) {
            issues.push(issue('history', 'error', 'HISTORY_SEGMENT_INVALID_ENTRY',
                `段 ${file} 缺少 startIndex/endIndex/count`, { conversationId, detail: { file } }));
            continue;
        }
        if (segment.startIndex !== expectedStart) {
            issues.push(issue('history', 'error', 'HISTORY_SEGMENT_GAP',
                `段 ${file} 起始索引 ${segment.startIndex} 与上一段期望 ${expectedStart} 不连续`,
                { conversationId, detail: { file, startIndex: segment.startIndex, expectedStart } }));
        }
        if (segment.endIndex !== segment.startIndex + segment.count - 1) {
            issues.push(issue('history', 'error', 'HISTORY_SEGMENT_RANGE_INCONSISTENT',
                `段 ${file} endIndex(${segment.endIndex}) !== startIndex+count-1(${segment.startIndex + segment.count - 1})`,
                { conversationId, detail: { file, startIndex: segment.startIndex, endIndex: segment.endIndex, count: segment.count } }));
        }
        expectedStart = segment.endIndex + 1;

        const segmentPath = path.join(historyDir, file);
        let content: string;
        try {
            content = await fsp.readFile(segmentPath, 'utf8');
        } catch {
            issues.push(issue('history', 'error', 'HISTORY_SEGMENT_FILE_MISSING',
                `索引引用的段文件不存在: ${file}`, { conversationId, detail: { file } }));
            continue;
        }
        const lineCount = content.split('\n').filter(line => line.trim().length > 0).length;
        if (lineCount !== segment.count) {
            issues.push(issue('history', 'error', 'HISTORY_SEGMENT_LINE_COUNT_MISMATCH',
                `段 ${file} 实际行数 ${lineCount} !== count ${segment.count}`,
                { conversationId, detail: { file, lineCount, count: segment.count } }));
        }
    }

    // 孤儿段文件（磁盘存在但索引未引用）
    let filesOnDisk: string[] = [];
    try {
        filesOnDisk = (await fsp.readdir(historyDir)).filter(file => file.endsWith('.ndjson'));
    } catch {
        // 目录不存在：段文件缺失已由上面的 HISTORY_SEGMENT_FILE_MISSING 报告
    }
    for (const file of filesOnDisk) {
        if (!indexedFiles.has(file)) {
            issues.push(issue('history', 'warning', 'HISTORY_ORPHAN_SEGMENT',
                `磁盘存在但索引未引用的段文件: ${file}`, { conversationId, detail: { file } }));
        }
    }

    return toSectionReport(issues, 1);
}

// ==================== 2. 存档：记录 vs 备份目录 / manifest / 增量链 ====================

/**
 * 检查一批存档记录（同一对话）的备份目录 / manifest / 增量链一致性。
 */
export async function checkCheckpointIntegrity(
    checkpointsDir: string,
    records: CheckpointRecord[]
): Promise<IntegritySectionReport> {
    const issues: IntegrityIssue[] = [];
    const recordIds = new Set(records.map(record => record.id));
    const byId = new Map(records.map(record => [record.id, record]));

    for (const record of records) {
        const conversationId = record.conversationId;
        const checkpointId = record.id;

        if (!isSafeCheckpointDirName(record.backupDir)) {
            issues.push(issue('checkpoint', 'error', 'CHECKPOINT_BACKUP_DIR_UNSAFE',
                `backupDir 不是合法存档目录名: ${record.backupDir}`,
                { conversationId, checkpointId, detail: { backupDir: record.backupDir } }));
            continue;
        }

        const backupPath = path.join(checkpointsDir, record.backupDir);
        let backupStat: Stats | null = null;
        try {
            backupStat = await fsp.stat(backupPath);
        } catch {
            issues.push(issue('checkpoint', 'error', 'CHECKPOINT_BACKUP_DIR_MISSING',
                `备份目录不存在: ${record.backupDir}`,
                { conversationId, checkpointId, detail: { backupDir: record.backupDir } }));
            continue;
        }
        if (!backupStat.isDirectory()) {
            issues.push(issue('checkpoint', 'error', 'CHECKPOINT_BACKUP_DIR_NOT_DIR',
                `backupDir 存在但不是目录: ${record.backupDir}`,
                { conversationId, checkpointId, detail: { backupDir: record.backupDir } }));
        }

        // manifest 可解析且 checkpointId 匹配
        const manifestPath = path.join(backupPath, 'manifest.json');
        let manifestRaw: string | null = null;
        try {
            manifestRaw = await fsp.readFile(manifestPath, 'utf8');
        } catch {
            manifestRaw = null;
        }
        if (manifestRaw === null) {
            if (record.manifestVersion !== undefined) {
                // 新格式记录（元数据不含 fileHashes）但 manifest 缺失 → 存档数据丢失
                issues.push(issue('checkpoint', 'error', 'CHECKPOINT_MANIFEST_MISSING',
                    `新格式存档缺少 manifest.json（记录声明 manifestVersion=${record.manifestVersion}，文件数据丢失）`,
                    { conversationId, checkpointId, detail: { backupDir: record.backupDir } }));
            } else {
                // 旧格式记录：无 manifest 属预期（可由记录 fileHashes 回退生成，MIG-02 懒迁移）
                issues.push(issue('checkpoint', 'warning', 'CHECKPOINT_MANIFEST_MISSING_LEGACY',
                    `旧格式存档无 manifest.json（首次恢复时由记录回退生成）`,
                    { conversationId, checkpointId, detail: { backupDir: record.backupDir } }));
            }
        } else {
            let manifest: { checkpointId?: unknown; files?: unknown } | null = null;
            try {
                manifest = JSON.parse(manifestRaw) as { checkpointId?: unknown; files?: unknown };
            } catch (error) {
                issues.push(issue('checkpoint', 'error', 'CHECKPOINT_MANIFEST_CORRUPT',
                    `manifest.json 解析失败: ${(error as Error)?.message ?? String(error)}`,
                    { conversationId, checkpointId, detail: { backupDir: record.backupDir } }));
            }
            if (manifest) {
                if (manifest.checkpointId !== checkpointId) {
                    issues.push(issue('checkpoint', 'error', 'CHECKPOINT_MANIFEST_ID_MISMATCH',
                        `manifest.checkpointId (${String(manifest.checkpointId)}) !== 记录 id (${checkpointId})`,
                        { conversationId, checkpointId, detail: { backupDir: record.backupDir } }));
                }
                if (typeof manifest.files !== 'object' || manifest.files === null || Array.isArray(manifest.files)) {
                    issues.push(issue('checkpoint', 'error', 'CHECKPOINT_MANIFEST_INVALID_SHAPE',
                        'manifest.json 缺少合法的 files 映射', { conversationId, checkpointId }));
                }
            }
        }

        // 增量链：baseCheckpointId 引用完整 + 无环
        if (record.type === 'incremental' && record.baseCheckpointId) {
            const baseId = record.baseCheckpointId;
            if (!recordIds.has(baseId)) {
                issues.push(issue('checkpoint', 'error', 'CHECKPOINT_BASE_MISSING',
                    `增量存档 baseCheckpointId ${baseId} 不在本对话记录中`,
                    { conversationId, checkpointId, detail: { baseCheckpointId: baseId } }));
            } else {
                // 沿 baseCheckpointId 链向上，检测环（步数上限 = 记录数，防无限循环）
                const seen = new Set<string>();
                let cursor: string | undefined = baseId;
                let steps = 0;
                while (cursor) {
                    if (seen.has(cursor)) {
                        issues.push(issue('checkpoint', 'error', 'CHECKPOINT_CHAIN_CYCLE',
                            `增量链存在环（重复经过 ${cursor}）`,
                            { conversationId, checkpointId, detail: { baseCheckpointId: baseId, cycleAt: cursor } }));
                        break;
                    }
                    seen.add(cursor);
                    const current = byId.get(cursor);
                    if (!current || !current.baseCheckpointId) {
                        break; // 链到 full 基准或尽头
                    }
                    cursor = current.baseCheckpointId;
                    steps++;
                    if (steps > records.length) {
                        issues.push(issue('checkpoint', 'error', 'CHECKPOINT_CHAIN_CYCLE',
                            `增量链步数超过记录总数（疑似环）`,
                            { conversationId, checkpointId, detail: { baseCheckpointId: baseId } }));
                        break;
                    }
                }
            }
        }
    }

    return toSectionReport(issues, records.length);
}

// ==================== 3. 分支：branches.json 与主历史 ====================

export interface BranchCheckOptions {
    baseDir: string;
    conversationId: string;
    /**
     * 主历史消息 id 链（不含 functionResponse，与 BranchService 口径一致）。
     * 提供 branchValidator 时忽略（validator 内部会取历史）。
     */
    historyIds?: string[];
    /**
     * 复用 BranchService.validateActivePathMatchesHistory 的完整校验
     * （含图结构 validate + 主历史 id 链 vs 活跃路径逐位比较）。
     * 提供时跳过内置轻量比较，避免重复报告。
     */
    branchValidator?: (conversationId: string) => Promise<BranchPathConsistencyResult>;
}

/**
 * 检查单个会话的分支 sidecar 一致性。
 * 无 branches.json（线性模式）→ checked=0 且不报告。
 */
export async function checkBranchIntegrity(options: BranchCheckOptions): Promise<IntegritySectionReport> {
    const { baseDir, conversationId } = options;
    const issues: IntegrityIssue[] = [];
    const repository = new BranchGraphRepository(baseDir);
    const loaded = await repository.load(conversationId);

    if (loaded.errorCode === 'BRANCH_STORAGE_CORRUPT') {
        issues.push(issue('branch', 'error', 'BRANCH_JSON_CORRUPT',
            `branches.json 损坏: ${loaded.errorMessage ?? 'unknown error'}`, { conversationId }));
        return toSectionReport(issues, 1);
    }
    if (!loaded.graph) {
        return toSectionReport([], 0); // 线性模式：无分支图
    }
    const graph = loaded.graph;

    if (options.branchValidator) {
        // 复用 BranchService.validateActivePathMatchesHistory（内部含图 validate + 活跃路径比较）。
        // 该 validator 返回纯字符串问题清单，其中图结构问题带 "graph[CODE]: " 前缀；
        // 结构问题保持 error，活跃路径比较问题降级为 warning（原因见本文件头注释）。
        const result = await options.branchValidator(conversationId);
        for (const message of result.issues) {
            const structuralMatch = /^graph\[([^\]]+)\]: /.exec(message);
            if (structuralMatch) {
                issues.push(issue('branch', 'error', `BRANCH_${structuralMatch[1]}`, message, { conversationId }));
            } else {
                issues.push(issue('branch', 'warning', 'BRANCH_ACTIVE_PATH_MISMATCH', message, { conversationId }));
            }
        }
        return toSectionReport(issues, 1);
    }

    // 内置校验：图结构（含 exportedFrom / exportedRefs 引用存在性）+ 活跃路径 vs 历史 id 链
    const validation = validate(graph);
    for (const validationIssue of validation.issues) {
        issues.push(issue('branch', 'error', `BRANCH_${validationIssue.code}`, validationIssue.message,
            { conversationId, detail: validationIssue.nodeId ? { nodeId: validationIssue.nodeId } : undefined }));
    }

    if (options.historyIds) {
        let pathIds: string[] = [];
        try {
            pathIds = activePath(graph);
        } catch (error) {
            issues.push(issue('branch', 'error', 'BRANCH_ACTIVE_PATH_UNRESOLVABLE',
                `活跃路径解析失败: ${(error as Error)?.message ?? String(error)}`, { conversationId }));
        }
        if (pathIds.length > 0 || options.historyIds.length > 0) {
            // 活跃路径 vs 主历史不一致降级为 warning：TREE-06 已落地（切换会重写主历史），
            // 但 append 异步并入/失败仅告警、reroll 非原子窗口、消息删除不同步图节点等
            // 已知合法状态仍会触发，不代表数据损坏（原因见本文件头注释）。
            // 图结构 validate 问题仍保持 error（见上方）。
            if (options.historyIds.length !== pathIds.length) {
                issues.push(issue('branch', 'warning', 'BRANCH_ACTIVE_PATH_LENGTH_MISMATCH',
                    `主历史 ${options.historyIds.length} 条 vs 图活跃路径 ${pathIds.length} 个节点`,
                    { conversationId, detail: { historyLength: options.historyIds.length, pathLength: pathIds.length } }));
            }
            const commonLength = Math.min(options.historyIds.length, pathIds.length);
            for (let i = 0; i < commonLength; i++) {
                if (options.historyIds[i] !== pathIds[i]) {
                    issues.push(issue('branch', 'warning', 'BRANCH_ACTIVE_PATH_ID_MISMATCH',
                        `位置 ${i} id 不一致: 主历史 ${options.historyIds[i] ?? '(缺失)'} vs 图 ${pathIds[i] ?? '(缺失)'}`,
                        { conversationId, detail: { position: i, historyId: options.historyIds[i] ?? null, graphId: pathIds[i] ?? null } }));
                }
            }
        }
    }

    return toSectionReport(issues, 1);
}

// ==================== 4. 编排：全量扫描 ====================

/** 枚举 conversations 目录下的会话（子目录即会话目录） */
export async function listConversationIds(baseDir: string): Promise<string[]> {
    const conversationsDir = path.join(baseDir, 'conversations');
    let entries: Dirent[];
    try {
        entries = await fsp.readdir(conversationsDir, { withFileTypes: true });
    } catch {
        return [];
    }
    return entries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
}

/** 从会话元数据读取存档记录（与 CheckpointQueryService 同一数据源；只读） */
export async function readCheckpointRecordsFromMeta(
    baseDir: string,
    conversationId: string
): Promise<CheckpointRecord[]> {
    const metaPath = path.join(baseDir, 'conversations', `${conversationId}.meta.json`);
    let raw: string;
    try {
        raw = await fsp.readFile(metaPath, 'utf8');
    } catch {
        return [];
    }
    try {
        const meta = JSON.parse(raw) as { custom?: { checkpoints?: unknown } };
        return Array.isArray(meta?.custom?.checkpoints) ? (meta.custom.checkpoints as CheckpointRecord[]) : [];
    } catch {
        return [];
    }
}

/**
 * 从分段历史读取主历史消息 id 链（不含 functionResponse；只读，用于内置分支比较）。
 * 段内容解析失败的行跳过（损坏已在 checkHistoryIntegrity 中报告）。
 */
export async function readHistoryIdsFromSegments(baseDir: string, conversationId: string): Promise<string[]> {
    const indexPath = path.join(baseDir, 'conversations', conversationId, 'history.index.json');
    const historyDir = path.join(baseDir, 'conversations', conversationId, 'history');
    let raw: string;
    try {
        raw = await fsp.readFile(indexPath, 'utf8');
    } catch {
        return [];
    }
    let index: SegmentIndexLike;
    try {
        index = JSON.parse(raw) as SegmentIndexLike;
    } catch {
        return [];
    }
    if (!Array.isArray(index.segments)) {
        return [];
    }
    const ids: string[] = [];
    for (const segment of index.segments) {
        if (typeof segment.file !== 'string') {
            continue;
        }
        // 路径穿越防护：非法段文件名不拼路径、不读盘（违规由 checkHistoryIntegrity 报告）
        if (!isSafeSegmentFileName(segment.file)) {
            continue;
        }
        let content: string;
        try {
            content = await fsp.readFile(path.join(historyDir, segment.file), 'utf8');
        } catch {
            continue;
        }
        for (const line of content.split('\n')) {
            if (!line.trim()) {
                continue;
            }
            try {
                const message = JSON.parse(line);
                if (isFunctionResponseMessage(message)) {
                    continue; // 决策 8：functionResponse 不独立成节点
                }
                if (typeof message?.id === 'string' && message.id.length > 0) {
                    ids.push(message.id);
                }
            } catch {
                // 段行损坏：由历史完整性检查报告
            }
        }
    }
    return ids;
}

export interface RunIntegrityCheckOptions {
    baseDir: string;
    checkpointsDir: string;
    /** 限定扫描的会话；缺省扫描 conversations 目录下全部会话目录 */
    conversationIds?: string[];
    /** 存档记录提供者；缺省读 {baseDir}/conversations/{id}.meta.json */
    getCheckpointRecords?: (conversationId: string) => Promise<CheckpointRecord[]>;
    /** 分支-主历史校验提供者（推荐传 BranchService.validateActivePathMatchesHistory 的包装） */
    branchValidator?: (conversationId: string) => Promise<BranchPathConsistencyResult>;
}

/**
 * 执行完整性检查并输出结构化报告（只报告，不修复）。
 */
export async function runIntegrityCheck(options: RunIntegrityCheckOptions): Promise<IntegrityReport> {
    const conversationIds = options.conversationIds ?? (await listConversationIds(options.baseDir));

    const historyIssues: IntegrityIssue[] = [];
    const checkpointIssues: IntegrityIssue[] = [];
    const branchIssues: IntegrityIssue[] = [];
    let historyChecked = 0;
    let checkpointChecked = 0;
    let branchChecked = 0;

    for (const conversationId of conversationIds) {
        const historyResult = await checkHistoryIntegrity(options.baseDir, conversationId);
        historyChecked += historyResult.checked;
        historyIssues.push(...historyResult.issues);

        const records = options.getCheckpointRecords
            ? await options.getCheckpointRecords(conversationId)
            : await readCheckpointRecordsFromMeta(options.baseDir, conversationId);
        if (records.length > 0) {
            const checkpointResult = await checkCheckpointIntegrity(options.checkpointsDir, records);
            checkpointChecked += checkpointResult.checked;
            checkpointIssues.push(...checkpointResult.issues);
        }

        const branchResult = await checkBranchIntegrity({
            baseDir: options.baseDir,
            conversationId,
            branchValidator: options.branchValidator,
            historyIds: options.branchValidator ? undefined : await readHistoryIdsFromSegments(options.baseDir, conversationId),
        });
        branchChecked += branchResult.checked;
        branchIssues.push(...branchResult.issues);
    }

    const allIssues = [...historyIssues, ...checkpointIssues, ...branchIssues];
    return {
        generatedAt: Date.now(),
        baseDir: options.baseDir,
        checkpointsDir: options.checkpointsDir,
        summary: {
            totalIssues: allIssues.length,
            errors: allIssues.filter(item => item.severity === 'error').length,
            warnings: allIssues.filter(item => item.severity === 'warning').length,
            byScope: {
                history: historyIssues.length,
                checkpoint: checkpointIssues.length,
                branch: branchIssues.length,
            },
        },
        history: toSectionReport(historyIssues, historyChecked),
        checkpoint: toSectionReport(checkpointIssues, checkpointChecked),
        branch: toSectionReport(branchIssues, branchChecked),
    };
}
