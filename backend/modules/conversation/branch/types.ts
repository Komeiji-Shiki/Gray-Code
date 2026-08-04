/**
 * 树状分支数据模型（第五阶段 BR-03：BranchGraph 建模）。
 *
 * 设计约束（主人已确认，必须遵守）：
 * 1. functionResponse 不独立成 BranchGraph 节点，依附所属 model 节点（节点 parts 引用
 *    conversation/types.ts 的 ContentPart，functionResponse 是 parts 的一种）。
 * 2. 节点 kind 含 'exported'：跨对话「复制为新对话」要建模进图，新对话记录来源节点与导出关系
 *    （exportedFrom: conversationId + nodeId）。
 * 3. 单 parentId 索引、不存 childrenIds（子列表运行时用 childrenIndex 建立索引）；
 *    每个节点只保留 activeChildId 指针。
 * 4. sidecar 文件 conversations/{id}/branches.json 单文件 JSON，内含 version、rootNodeId、
 *    activeTailNodeId、nodes、activeChildId（根节点指针镜像）、候选摘要（candidateSummaries）。
 *
 * 参考：checkpoint-history-branch-architecture.plan.md 第五部分 L1369–1448、
 * 第六部分 L1619–1630（workspaceState）、第七部分 L1703–1711（错误码）。
 */

import type { ContentPart, UsageMetadata } from '../types';

/** branches.json 当前结构版本（MIG-04 版本迁移状态机的基线） */
export const BRANCH_GRAPH_VERSION = 1;

/**
 * TREE-09：软删分支默认保留期（天）。
 * 后端配置项：BranchService 构造时可通过 options.retentionDays 覆盖；
 * 持久化配置见 BranchGraphRepository.loadBranchRetentionConfig（数据目录 branches.config.json）。
 * 0 表示不自动清理（永不过期）。
 */
export const DEFAULT_BRANCH_RETENTION_DAYS = 30;

/** 分支保留期配置（branches.config.json / BranchService 构造选项共用） */
export interface BranchRetentionConfig {
    /** 软删节点保留天数；0 = 不自动清理 */
    retentionDays: number;
}

/**
 * 分支节点类型。
 * - normal：常规消息节点
 * - reroll：重新生成（同一父节点下的新候选，旧候选保留）
 * - edit：编辑用户消息创建的分支（保留旧子树）
 * - continue：从非尾候选继续对话产生的新节点
 * - imported：旧线性历史首次建图导入的节点（MIG-01）
 * - exported：跨对话「复制为新对话」的导出节点（记录 exportedFrom 来源）
 */
export type BranchNodeKind = 'normal' | 'reroll' | 'edit' | 'continue' | 'imported' | 'exported';

/**
 * 分支节点绑定的工作区状态（BCP 阶段填充）。
 * - unchanged：无写工具执行，工作区未变化
 * - checkpointed：已绑定工作区存档（workspaceCheckpointId）
 * - unavailable：工作区状态不可用 / 无法安全恢复
 * - unknown：尚未评估（缺省）
 */
export type WorkspaceState = 'unchanged' | 'checkpointed' | 'unavailable' | 'unknown';

/** 分支操作错误码（规划 L1703–1711） */
export type BranchErrorCode =
    | 'BRANCH_BUSY'
    | 'NODE_NOT_FOUND'
    | 'INVALID_BRANCH_RELATION'
    | 'BRANCH_STORAGE_CORRUPT'
    | 'WORKSPACE_STATE_UNAVAILABLE'
    | 'WORKSPACE_CHECKPOINT_BROKEN'
    | 'BRANCH_OPERATION_CONFLICT'
    // L-6（R4 复查）：未知/未映射异常的统一内部错误码。
    // 旧实现把非 BranchError 一律兜底为 BRANCH_OPERATION_CONFLICT，会误导前端重试；
    // 现在兜底为 INTERNAL_ERROR 并透出原始错误信息，便于定位服务端缺陷。
    | 'INTERNAL_ERROR';

/** 跨对话「复制为新对话」的导出来源：来源对话 + 来源节点 */
export interface BranchExportSource {
    conversationId: string;
    nodeId: string;
}

/**
 * 跨对话「复制为新对话」的导出记录（BR-09 源头对话侧标注，exportedRefs 条目）。
 * 记录「本对话的哪个节点被导出到了哪个新对话」，不新增节点、不影响活跃路径。
 */
export interface BranchExportRecord {
    /** 目标（新）对话 ID */
    targetConversationId: string;
    /** 被导出的来源节点 ID（本对话中） */
    nodeId: string;
    /** 导出时间（毫秒时间戳） */
    exportedAt: number;
}

/**
 * 分支图节点。
 *
 * functionResponse 不独立成节点：所属 model 节点的 parts 中已包含 functionResponse 配对，
 * 因此一个节点对应「一条消息 + 其配对的函数响应」。
 */
export interface ConversationBranchNode {
    /** 稳定节点 ID（与 Content.id 同源，BR-01） */
    id: string;
    /** 父节点 ID；根节点为 null（单根不变量） */
    parentId: string | null;
    /** 消息角色（与 Content.role 对齐） */
    role: 'user' | 'model' | 'system';
    /** 消息内容（引用 conversation 现有 ContentPart 类型） */
    parts: ContentPart[];
    /** 节点类型 */
    kind: BranchNodeKind;
    /** 节点创建时间（毫秒时间戳，用于候选排序） */
    createdAt: number;
    /** 消息时间戳（毫秒，同 Content.timestamp） */
    timestamp?: number;
    /** 模型版本（仅 model 消息） */
    modelVersion?: string;
    /** Token 使用统计（仅 model 消息） */
    usageMetadata?: UsageMetadata;
    /**
     * 用量统计是否不完整（R8b-M2）。
     * 流被中断/取消时 usageMetadata 只覆盖已收到的 chunk（截断的半截数据），
     * 统计端（usageStats.extractMessageTokens）据此回退按文本长度估算，
     * 避免中断 reroll 候选按截断原值计入导致低估。与 Content.usageMetadataPartial 同语义。
     */
    usageMetadataPartial?: boolean;
    /**
     * 当前选中的子分支指针（唯一真源）。
     * 不存 childrenIds；子列表运行时用 childrenIndex 建立索引。
     */
    activeChildId?: string | null;
    /** 分支标签（TREE-09 重命名） */
    label?: string;
    /** 软删除标记（TREE-09；删除的分支不参与活跃路径） */
    deleted?: boolean;
    /** 软删除时间（毫秒时间戳，TREE-09；prune 依据 deletedAt + 保留期判定过期） */
    deletedAt?: number;
    /**
     * 绑定的工作区存档 ID（BCP-02）。
     * 语义：该节点路径上最近一次成功创建的工作区存档头节点（工具执行 before/after
     * 存档点 fire-and-forget 绑定；同节点重复绑定直接覆盖为最新）。
     * 同一存档可被多个节点引用（BCP-06 引用计数据此回收）。
     */
    workspaceCheckpointId?: string;
    /** 工作区状态（BCP；缺省等价 'unknown'；绑定成功后为 'checkpointed'） */
    workspaceState?: WorkspaceState;
    /** 跨对话导出来源（kind === 'exported' 时存在） */
    exportedFrom?: BranchExportSource;
}

/** 候选摘要（sidecar 内嵌，供 getCandidateSummaries 免读主历史） */
export interface BranchCandidateSummary {
    /** 候选节点 ID */
    nodeId: string;
    /** 父节点 ID */
    parentId: string | null;
    /** 候选类型 */
    kind: BranchNodeKind;
    /** 创建时间（毫秒时间戳） */
    createdAt: number;
    /** 消息时间戳（毫秒） */
    timestamp?: number;
    /** 模型版本 */
    modelVersion?: string;
    /** 分支标签 */
    label?: string;
    /** 摘要文本（首段文本/工具名，由写入方生成） */
    preview: string;
    /** 软删除标记 */
    deleted?: boolean;
    /** 软删除时间（毫秒时间戳，TREE-09；与节点 deletedAt 同步维护） */
    deletedAt?: number;
}

/**
 * 分支图（sidecar 文件 conversations/{id}/branches.json 的根结构）。
 *
 * - rootNodeId：根节点（主历史的第一条消息）
 * - activeTailNodeId：当前活跃路径的尾节点
 * - nodes：全量节点（活跃路径节点 + 非活跃分支节点）
 * - activeChildId：根节点 activeChildId 的镜像指针（决策 4：sidecar 内含 activeChildId）；
 *   唯一真源是 rootNode.activeChildId，纯函数同步维护，validate 校验一致性
 * - candidateSummaries：候选摘要（免读主历史）
 */
export interface ConversationBranchGraph {
    version: number;
    rootNodeId: string | null;
    activeTailNodeId: string | null;
    nodes: Record<string, ConversationBranchNode>;
    /** 根节点 activeChildId 镜像指针（决策 4）；以 rootNode.activeChildId 为真源 */
    activeChildId?: string | null;
    /** 候选摘要（TREE-02 起填充） */
    candidateSummaries?: BranchCandidateSummary[];
    /**
     * BR-09：本对话由跨对话「复制为新对话」创建时的来源（新对话侧图元数据）。
     * 新对话的节点全部为 kind='imported'，此字段记录来源对话与来源节点。
     */
    exportedFrom?: BranchExportSource;
    /**
     * BR-09：本对话的跨对话导出记录（源头对话侧图元数据）。
     * 记录「本对话的哪些节点被导出到了哪些新对话」；纯标注，不新增节点。
     */
    exportedRefs?: BranchExportRecord[];
}

/** 带错误码的分支错误（纯函数 / BranchService 抛错用；仓储层损坏走读结果降级） */
export class BranchError extends Error {
    constructor(
        public readonly code: BranchErrorCode,
        message?: string
    ) {
        super(message ?? code);
        this.name = 'BranchError';
    }
}

/**
 * 分支图轻量结构校验（R8b-L3：从 BranchGraphRepository 提升为共享实现）。
 * 只校验 sidecar 可解析为图的表层形状：version 为 >=1 的整数且 nodes 为普通对象。
 * 深度一致性（环 / 悬空指针等）交给 BranchGraph.validate。
 * 使用方：BranchGraphRepository.load（解析失败 → 损坏降级）与
 * UsageIndexStore.readBranchGraph（统计读取降级，不阻塞统计）。
 */
export function isBranchGraphShape(value: unknown): value is ConversationBranchGraph {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const candidate = value as Record<string, unknown>;
    return (
        typeof candidate.version === 'number' &&
        Number.isInteger(candidate.version) &&
        candidate.version >= 1 &&
        typeof candidate.nodes === 'object' &&
        candidate.nodes !== null &&
        !Array.isArray(candidate.nodes)
    );
}
