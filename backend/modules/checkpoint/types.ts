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
 * 独立存档 manifest（CPF-01）。
 *
 * 从会话元数据迁出完整 fileHashes / fileStats / excluded / ignoreSnapshot，
 * 按存档 ID 独立存放于 `checkpoints/cp_xxx/manifest.json`。
 */
export interface CheckpointManifest {
    version: number;
    checkpointId: string;
    workspaceRoots: CheckpointWorkspaceRoot[];
    /** scopedPath -> 文件信息 */
    files: Record<string, {
        hash: string;
        size: number;
        mtimeMs: number;
        mtimeNs?: string;
        /** 增量节点中该文件实际备份所在的前置节点（缺省 = 本节点） */
        backupSourceCheckpointId?: string;
    }>;
    emptyDirs: string[];
    changes: CheckpointFileChange[];
    /** 被排除路径的完整清单（样本之外的全部） */
    excluded: CheckpointExcludedEntry[];
    ignoreSnapshot: CheckpointIgnoreSnapshot;
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
