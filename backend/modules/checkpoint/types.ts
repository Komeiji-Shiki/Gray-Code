/**
 * Checkpoint 模块共享类型契约
 *
 * 本文件是 Phase 2（存档排除功能）与 Phase 3（存档性能与元数据改造）并行实施的
 * 接口锚点：所有跨模块共享的类型（排除原因、排除条目、排除配置、规则快照、
 * manifest、轻量摘要）统一在此定义，避免并行开发时出现两套同构类型。
 *
 * 结构参照 checkpoint-history-branch-architecture.plan.md：
 * - 「第二部分」排除功能（CheckpointExcludeReason / CheckpointExcludedEntry /
 *   CheckpointExclusionSummary / CheckpointIgnoreSnapshot）
 * - 「第三部分」manifest 独立存储（CheckpointManifest / CheckpointSummary）
 */
import type { CheckpointWorkspaceRoot } from './CheckpointWorkspace';

/** 文件被排除的原因分类 */
export type CheckpointExcludeReason =
    | 'forced'        // 强制排除（.git / node_modules / 扩展自身存储，不可被 ! 否定）
    | 'default'       // 默认排除类别命中（日志、模型、缓存等，可在设置页关闭）
    | 'gitignore'     // 项目 .gitignore / 嵌套 .gitignore 命中
    | 'custom'        // 用户自定义排除模式命中
    | 'size'          // 超过单文件大小上限
    | 'unsupported_file_type' // 预留：不支持备份的文件类型
    | 'unreadable';   // 文件无法读取

/** 一条被排除路径的记录（恢复时用于解释「为什么没有备份」） */
export interface CheckpointExcludedEntry {
    /** 工作区作用域路径（`rootId/relative/path`） */
    path: string;
    reason: CheckpointExcludeReason;
    /** 命中的具体规则模式（如 `*.log`、`logs/`）；gitignore/自定义规则才有 */
    rule?: string;
    /** 规则来源说明（如 `logs` 类别名、`.gitignore` 路径、`custom`） */
    source?: string;
    /** 文件字节数（reason === 'size' 时存在） */
    size?: number;
}

/** 排除统计（按原因聚合 + 样本列表；样本必须限制数量，完整清单进 manifest） */
export interface CheckpointExclusionSummary {
    excludedCount: number;
    excludedBytes: number;
    byReason: Record<string, { count: number; bytes: number }>;
    samples: CheckpointExcludedEntry[];
}

/** 默认排除类别 ID（设置页可分别开关） */
export type CheckpointExclusionProfileId =
    | 'logs'           // 日志文件
    | 'aiModels'       // AI / ML 模型权重与分片
    | 'datasets'       // 数据集与大规模数据
    | 'caches'         // 缓存
    | 'pythonVenvs'    // Python 虚拟环境
    | 'buildArtifacts' // 构建产物
    | 'largeMedia'     // 大型媒体与设计源文件
    | 'archives';      // 压缩包与二进制产物

/** 排除功能配置（对应设置页，EX-08） */
export interface CheckpointExclusionConfig {
    /** profileId -> 是否启用（缺省按默认值处理） */
    enabledProfiles: Record<string, boolean>;
    /** 每类别自定义模式覆盖（profileId -> 模式清单；缺省/空数组 = 使用该类别默认清单） */
    profilePatterns?: Record<string, string[]>;
    /** 单文件大小上限（字节）；0 或负数 = 不限制 */
    maxFileSizeBytes: number;
    /** 用户自定义排除模式（支持 `!` 否定，但不能覆盖强制排除） */
    customPatterns: string[];
}

/** 存档创建时的排除规则快照（EX-10，随 manifest 保存） */
export interface CheckpointIgnoreSnapshot {
    version: number;
    forcedRulesVersion: number;
    defaultProfileVersion: number;
    enabledProfiles: Record<string, boolean>;
    /** 与 CheckpointExclusionConfig.profilePatterns 同构（快照保留编辑后的每类别模式） */
    profilePatterns?: Record<string, string[]>;
    maxFileSizeBytes: number;
    customPatterns: string[];
}

/** 单文件变更记录（增量链节点用） */
export interface CheckpointFileChange {
    path: string;
    type: 'added' | 'modified' | 'deleted';
    hash?: string;
}

/**
 * manifest 轻量元数据视图（CPF-LAZY-1）。
 *
 * 不含 `files` 映射（全工作区哈希表，大工作区可达 10-20MB）：
 * - 新格式（schema version 2）下 `files` 独立存放于 `checkpoints/cp_xxx/files.json`，
 *   仅需要完整文件数据时按需懒加载（loadManifestWithFiles）；
 * - 列表摘要 / 排除清单 / 排除说明等读取路径只消费本视图，避免解析重量级文件映射。
 */
export interface CheckpointManifestMeta {
    version: number;
    checkpointId: string;
    workspaceRoots: CheckpointWorkspaceRoot[];
    emptyDirs: string[];
    changes: CheckpointFileChange[];
    /** 被排除路径的完整清单（样本之外的全部） */
    excluded: CheckpointExcludedEntry[];
    ignoreSnapshot: CheckpointIgnoreSnapshot;
    /**
     * files.json 配对版本号（schema version 2，每次提交随机生成，同时写入 manifest.json
     * 与 files.json）：读取时校验两个文件属于同一提交，崩溃窗口产生的混合配对被识别并拒绝。
     * 旧格式（v1 或未含该字段的 v2 历史数据）缺省 = 不校验（兼容读取）。
     */
    filesRevision?: string;
}

/**
 * 独立存档 manifest（CPF-01 / CPF-LAZY-1）。
 *
 * 从会话元数据迁出完整 fileHashes / fileStats / excluded / ignoreSnapshot，
 * 按存档 ID 独立存放于 `checkpoints/cp_xxx/manifest.json`。
 * schema version 1：`files` 内联在 manifest.json 中（旧格式，仍可读取）；
 * schema version 2：`files` 独立存放于同目录 `files.json`（懒加载读取路径）。
 */
export interface CheckpointManifest extends CheckpointManifestMeta {
    /** scopedPath -> 文件信息 */
    files: Record<string, {
        hash: string;
        size: number;
        mtimeMs: number;
        mtimeNs?: string;
        /** 增量节点中该文件实际备份所在的前置节点（缺省 = 本节点） */
        backupSourceCheckpointId?: string;
    }>;
}

/**
 * 轻量存档摘要（CPF-02/CPF-03）。
 *
 * 会话元数据只保留此摘要，前端列表也只接收此结构，不再下发完整哈希映射。
 */
export interface CheckpointSummary {
    id: string;
    conversationId: string;
    messageNodeId?: string;
    messageIndex: number;
    toolName: string;
    phase: 'before' | 'after';
    timestamp: number;
    type: 'full' | 'incremental';
    baseCheckpointId?: string;
    contentHash: string;
    fileCount: number;
    backupBytes: number;
    excludedCount: number;
    manifestVersion: number;
}

/** checkpoint.previewExclusions 的返回结构（EX-09） */
export interface CheckpointExclusionPreviewResult {
    summary: CheckpointExclusionSummary;
    /** 按默认类别聚合（gitignore/custom/size/forced 归入 `other`） */
    byProfile: Record<string, CheckpointExclusionSummary>;
    /** 本次预览使用的规则快照 */
    ignoreSnapshot: CheckpointIgnoreSnapshot;
    /** 扫描是否完成（false 表示命中目录级错误被截断） */
    complete: boolean;
}

/**
 * 进行中存档操作的进度状态（CPF-11，checkpoint.getOperationProgress 返回）。
 *
 * phase 为机器可读的阶段标识（不做本地化，由前端映射文案）：
 * - create: pending → scanning → copying → cleaning → done / cancelled / failed
 * - restore: pending → preparing → restoring → done / cancelled / failed
 * - delete: pending → deleting → done / cancelled / failed
 */
export interface CheckpointOperationProgress {
    /** 操作唯一 ID（checkpoint.cancelOperation 传入） */
    operationId: string;
    kind: 'create' | 'restore' | 'delete' | 'merge';
    conversationId?: string;
    checkpointId?: string;
    /** 当前阶段 */
    phase: string;
    /** 已处理数量 */
    processed: number;
    /** 总数量（0 表示未知/尚未开始） */
    total: number;
    /** 是否已被取消（cancelOperation 触发） */
    cancelled: boolean;
    startedAt: number;
    updatedAt: number;
    /** 可选的补充说明（如失败原因） */
    message?: string;
}

/* ======================================================================== */
/* 以下为 L-11（R4 复查）从 CheckpointManager / CheckpointRestoreService 迁入的  */
/* 公共类型：本文件成为这些类型的单一真源，两侧实现模块从此处导入并 re-export。 */
/* ======================================================================== */

/** 文件变更记录 */
export interface FileChange {
    /** 相对路径 */
    path: string;
    /** 变更类型 */
    type: 'added' | 'modified' | 'deleted';
    /** 文件哈希（仅 added/modified） */
    hash?: string;
}

/** 恢复失败原因 */
export type RestoreFailureReason = 'missing_in_chain' | 'hash_mismatch' | 'copy_failed' | 'delete_failed';

/** 单个文件的恢复失败记录 */
export interface RestoreFailure {
    /** 相对路径 */
    path: string;
    /** 失败原因 */
    reason: RestoreFailureReason;
}

/**
 * EX-11: 恢复时的排除说明（区分「快照规则」与「当前规则」）。
 *
 * - 快照规则来自 manifest.ignoreSnapshot（该存档创建时的排除配置）；
 * - 当前规则来自 settingsManager 的实时配置；
 * - 恢复仍然严格按当前规则过滤目标（filterRestoreTargetScoped），
 *   不会因为旧规则更宽而覆盖当前明确忽略的文件。
 */
export interface CheckpointExcludedNote {
    /** 该存档创建时按当时规则排除的文件数（来自 manifest.excluded） */
    excludedCount: number;
    /** 快照规则与当前规则是否不一致（大小上限 / 自定义模式等） */
    rulesChanged: boolean;
    /** 可直接展示的说明文本（中文；前端可自行本地化） */
    message: string;
    /** 快照时的排除规则 */
    snapshotRules?: CheckpointIgnoreSnapshot;
    /** 当前排除规则 */
    currentRules?: CheckpointIgnoreSnapshot;
}

/** 恢复结果 */
export interface RestoreResult {
    success: boolean;
    restored: number;
    deleted: number;
    skipped: number;
    error?: string;
    missingBackupDirs?: string[];
    autoPrunedCheckpointCount?: number;
    /** 未能恢复/删除的文件清单（存在时 success 必为 false） */
    failures?: RestoreFailure[];
    /**
     * 快照时未备份的文件（大小超限/不可读/复制失败）：恢复时受保护不会被删除。
     * 值为对用户友好的相对路径（scoped 键解析失败时保留原值）。
     */
    unbackedPaths?: string[];
    /** EX-11: 恢复时解释「该存档创建时按当时规则排除了哪些文件」（规则来自 manifest 快照） */
    excludedNote?: CheckpointExcludedNote;
}

/**
 * 恢复预览结果（CP-09）：执行恢复前先计算计划，供前端展示待删除文件清单并确认。
 */
export interface RestorePreviewResult {
    success: boolean;
    /** 将恢复（新增 + 修改）的文件数；legacy 存档为 -1（无法预知，以备份目录内容为准） */
    restored: number;
    /**
     * 确认删除快照后新建文件时（restoreCheckpoint 传 deleteUntrackedFiles=true）将删除的文件数
     * （快照记录过的路径 + 快照后新建文件）。
     * CP-PREV-1: 与 deletedIfUnconfirmed 区分，避免“预览与执行严格一致”契约被误读。
     */
    deleted: number;
    /**
     * 未确认删除 untracked 文件时（默认 deleteUntrackedFiles=false）将删除的文件数，
     * 仅含快照记录过的路径（untracked 默认保留，不参与该计数）。
     * CP-PREV-1: 预览展示“将删除”时若调用方未确认 untracked 删除，应以本字段为准。
     */
    deletedIfUnconfirmed: number;
    /** 与目标一致、无需操作的文件数；legacy 存档为 -1 */
    skipped: number;
    /** 将被删除的文件显示路径（快照记录过、按 #29 白名单删除；旧版存档无删除语义时为空） */
    deletablePaths: string[];
    /** 快照后新建的文件/空目录显示路径：默认保留，需用户确认后才删除（CP-09） */
    untrackedPaths: string[];
    /** 旧版存档（无 fileHashes）：预览无法给出精确数量，以恢复执行结果为准 */
    legacy?: boolean;
    error?: string;
    /** 预检失败（链断裂等）时携带 */
    failures?: RestoreFailure[];
    missingBackupDirs?: string[];
    autoPrunedCheckpointCount?: number;
    unbackedPaths?: string[];
    /** EX-11: 恢复预览同样携带排除说明（与 restoreCheckpoint 一致） */
    excludedNote?: CheckpointExcludedNote;
}

/** 检查点记录 */
export interface CheckpointRecord {
    /** 唯一标识 */
    id: string;
    /** 关联的对话 ID */
    conversationId: string;
    /** 关联的消息索引 */
    messageIndex: number;
    /** 触发检查点的工具名称 */
    toolName: string;
    /** 检查点阶段 */
    phase: 'before' | 'after';
    /** 创建时间戳 */
    timestamp: number;
    /** 备份目录名 */
    backupDir: string;
    /** 备份的文件数量 */
    fileCount: number;
    /** 内容签名（用于比较两个检查点是否内容一致） */
    contentHash: string;
    /** 可选描述 */
    description?: string;
    /** 备份类型：full=完整备份，incremental=增量备份 */
    type?: 'full' | 'incremental';
    /** 增量备份基于的检查点 ID（仅增量备份有效） */
    baseCheckpointId?: string;
    /** 变更的文件列表（仅增量备份有效） */
    changes?: FileChange[];
    /** 所有文件的哈希映射（用于增量比较）。只包含真正备份成功的文件 */
    fileHashes?: Record<string, string>;
    /** 快照时的文件 stat 信息（用于增量哈希复用；旧记录无此字段时回退全量哈希） */
    fileStats?: Record<string, { mtimeMs: number; size: number; mtimeNs?: string }>;
    /** 快照时的自定义忽略模式（restore 据此判断“快照时该路径是否可见”） */
    ignorePatterns?: string[];
    /** 快照时被排除的文件/目录数（EX-10；恢复时解释“为什么没有备份”） */
    excludedCount?: number;
    /** 快照时被排除路径的合计字节数（EX-10；size 排除等） */
    excludedBytes?: number;
    /** 快照时的排除规则快照（EX-10；恢复时与当前规则对比，解释规则差异） */
    ignoreSnapshot?: CheckpointIgnoreSnapshot;
    /** 快照时可见但备份复制失败的文件（restore 绝不能删除这些文件） */
    unbackedPaths?: string[];
    /** 空目录列表（相对路径） */
    emptyDirs?: string[];
    /** 存档时的工作区根目录集合（CP-01：恢复前校验当前工作区身份；旧存档无此字段） */
    workspaceRoots?: CheckpointWorkspaceRoot[];
    /** 工作区身份指纹（roots 集合的哈希，用于恢复前快速校验） */
    workspaceFingerprint?: string;
    /** 关联的消息节点 ID（树状分支扩展预留，与 CheckpointSummary 对齐） */
    messageNodeId?: string;
    /** CPF-09: 创建时记录的备份目录磁盘占用（字节）；旧存档缺失时按需懒扫描并写回 */
    backupBytes?: number;
    /** CPF-01: 本存档 manifest 的 schema 版本（写入 manifest.json 时记录） */
    manifestVersion?: number;
}

/** 批量删除检查点的请求项 */
export interface BatchCheckpointDeleteItem {
    /** 关联的对话 ID */
    conversationId: string;
    /**
     * 要删除的检查点 ID 列表
     * 空数组表示删除该对话的全部检查点
     */
    checkpointIds: string[];
}

/** 批量删除检查点的单个对话处理结果 */
export interface BatchCheckpointDeleteResult {
    /** 关联的对话 ID */
    conversationId: string;
    /** 实际删除的检查点 ID */
    deletedIds: string[];
    /** 因被其他保留的检查点引用为基快照而被拒绝删除的 ID（保护增量链完整性） */
    rejectedIds: string[];
    /** 该对话的处理是否成功 */
    success: boolean;
}
