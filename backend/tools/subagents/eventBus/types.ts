/**
 * SubAgent 运行时事件总线的类型与常量定义。
 *
 * 拆分说明：从 runEventBus.ts 迁出（纯移动，逻辑一字未改）。事件协议
 * （subagentMonitor.event / manifest 前端契约）逐字保留，runEventBus.ts 仅保留 re-export 壳。
 */

import type { SubAgentContextCompactionRecord } from '../../../../shared/subAgentContextCompaction';
import type { Content } from '../../../modules/conversation/types';
import type { SubAgentTranscriptData } from '../../../modules/conversation/storage';
import type { ToolProgressEvent } from '../../types';

export const SUBAGENT_RUNS_METADATA_KEY = 'subAgentRuns';

export interface SubAgentRunEvent extends ToolProgressEvent {
    runId: string;
    agentName?: string;
    timestamp: number;
    /**
     * 修改原因：Monitor window 与事件是异步跨 Webview 通道传输，前端需要可比较的单调事件序号避免旧响应覆盖新状态。
     * 修改方式：由 SubAgentRunEventBus 在每次发事件时递增并写入 eventSequence。
     * 修改目的：让 manifest、window 和 event 能共同判断状态新旧，而不是依赖 updatedAt 或请求返回时序。
     */
    eventSequence?: number;
    /**
     * 修改原因：Content[] transcript 已改为按需 window 传输，前端必须知道当前窗口是否仍对应后端最新 transcript 版本。
     * 修改方式：由所有 transcript 写入口递增 contentRevision，并随事件、manifest、window 下发。
     * 修改目的：阻止 stale window 继续接收 live delta，从协议层修复多轮回复混楼。
     */
    contentRevision?: number;
}

/**
 * SubAgent run 的显式状态机。
 *
 * 修改原因：原有 running/completed/failed/cancelled 无法区分 Monitor 暂停、等待用户处理和扩展重载中断。
 * 修改方式：增加 paused、awaiting_monitor_action、interrupted，并作为持久快照的唯一状态类型；
 *          并发排队能力引入后新增 queued，表示 run 已创建但正在等待全局并发信号量席位。
 * 修改目的：让 UI 控制按钮、主工具等待语义和历史 run 展示不再混用 failed/cancelled。
 */
export type SubAgentRunStatus = 'queued' | 'running' | 'paused' | 'awaiting_monitor_action' | 'completed' | 'failed' | 'cancelled' | 'interrupted';

export interface SubAgentRunPersistedRecord {
    runId: string;
    agentName?: string;
    status: SubAgentRunStatus;
    createdAt: number;
    updatedAt: number;
    /** 新格式只保存独立 transcript 引用；contents 仅用于读取旧元数据并迁移。 */
    transcriptRef?: string;
    contentCount?: number;
    preview?: string;
    lastMessageRole?: Content['role'];
    contents?: Content[];
    /**
     * 修改原因：历史 metadata 只有 contents/updatedAt，无法判断异步 window 响应是否过期。
     * 修改方式：持久化 transcript 修订号；旧 metadata 读取时会补 0，后续写入自然升级。
     * 修改目的：让 Monitor 恢复历史 run 时也能使用同一套 freshness 判断。
     */
    contentRevision?: number;
    /**
     * 修改原因：事件列表被瘦身且 llm_delta 不入持久 journal，仍需要一个 run 级事件时序供前端去重和调试。
     * 修改方式：持久化最新 eventSequence；旧 metadata 读取时补 0。
     * 修改目的：为后续统一 AgentRunEvent replay 保留单调时序基础。
     */
    eventSequence?: number;
    /**
     * 最后一次实际发送给 provider 的 history（generate 前剥离重放 agentInbox 后的请求历史）。
     *
     * 修改原因：Monitor 展示的 contents 首条是 # SubAgent Invocation 卡片，从未发给 provider；
     *          continueFromRunId 续跑若以 contents 为前缀，请求历史与旧 run 从第 0 条就不同，
     *          provider 侧前缀缓存（DeepSeek KVCache / Anthropic user_id 域）必然 miss。
     * 修改方式：executor 每次 generate 前把剥离后的请求历史经 updateLastSentHistory 写入本字段，
     *          随现有 metadata 一起持久化/恢复；续跑时优先取它作为 baseContents。
     * 修改目的：续跑请求前缀与旧 run 最后一次实际发送逐条一致，命中 provider 前缀缓存；
     *          旧 metadata 缺该字段时由 executor 降级处理（过滤卡片 contents）。
     */
    /** provider 上下文自动总结与硬 fallback 的持久诊断记录。 */
    contextCompactions?: SubAgentContextCompactionRecord[];
    lastSentHistory?: Content[];
}

export interface SubAgentRunSnapshot extends SubAgentRunPersistedRecord {
    contents: Content[];
    contextCompactions: SubAgentContextCompactionRecord[];
    events: SubAgentRunEvent[];
    conversationId?: string;
    contentRevision: number;
    eventSequence: number;
    /** false 表示只恢复了轻量 metadata，完整 transcript 尚未从独立文件读取。 */
    transcriptLoaded?: boolean;
}

export interface SubAgentRunManifest {
    runId: string;
    agentName?: string;
    status: SubAgentRunStatus;
    createdAt: number;
    updatedAt: number;
    conversationId?: string;
    contentCount: number;
    eventCount: number;
    contentRevision: number;
    eventSequence: number;
    preview?: string;
    lastMessageRole?: Content['role'];
}

export interface SubAgentRunContentWindow {
    runId: string;
    contents: Content[];
    startIndex: number;
    endIndex: number;
    totalCount: number;
    contentRevision: number;
    eventSequence: number;
    contextCompactions: SubAgentContextCompactionRecord[];
    hasMoreBefore: boolean;
    hasMoreAfter: boolean;
}

export interface SubAgentRunContentWindowOptions {
    startIndex?: number;
    endIndex?: number;
    limit?: number;
    fromTail?: boolean;
}

export interface SubAgentRunConversationStore {
    getCustomMetadata(conversationId: string, key: string): Promise<unknown>;
    setCustomMetadata(conversationId: string, key: string, value: unknown): Promise<void>;
    saveSubAgentTranscript?(conversationId: string, runId: string, data: SubAgentTranscriptData): Promise<string>;
    loadSubAgentTranscript?(conversationId: string, runId: string): Promise<SubAgentTranscriptData | null>;
    deleteSubAgentTranscript?(conversationId: string, runId: string): Promise<void>;
}

export type SubAgentRunListener = (event: SubAgentRunEvent, snapshot: SubAgentRunSnapshot) => void;

const DEFAULT_CONTENT_WINDOW_LIMIT = 20;
const MANIFEST_PREVIEW_MAX_LENGTH = 160;

/**
 * 单个 run 内存事件 journal 的上限。
 *
 * 修改原因：事件 journal 从不持久化也从不裁剪，长 run（大量工具调用与重试）会让它无限增长。
 * 修改方式：超出上限时丢弃最旧事件，只保留最近一段用于 Monitor 审计与重试状态展示。
 * 修改目的：内存占用与 run 时长解耦。
 */
const MAX_EVENTS_PER_RUN = 500;

/**
 * 内存中保留的 run 快照上限。
 *
 * 修改原因：snapshots Map 只增不减，每个条目持有完整 Content[]；长时间开着的窗口跑过几百个 SubAgent 后会持续占用内存。
 * 修改方式：超出上限时按 updatedAt 淘汰最旧的、已进入终态且已持久化到 conversation metadata 的 run。
 * 修改目的：内存有界，同时被淘汰的 run 仍可通过 loadConversationSnapshots 从元数据恢复查看。
 */
const MAX_RETAINED_SNAPSHOTS = 200;

/**
 * 流式期间 transcript 落盘的最小间隔（毫秒）。
 *
 * 修改原因：每次 transcript 变更都要"读整份 conversation metadata → 改 → 写回"，而 metadata 里装着该对话
 *          全部 run 的完整 contents；一个多轮子代理跑下来会把同一份大 JSON 反复 parse/stringify 几十次。
 * 修改方式：内容类写入按固定窗口节流合并，run 状态变更（含所有终态）仍然立即落盘。
 * 修改目的：落盘次数与真实时间挂钩而不是与 token 产出速度挂钩，同时不牺牲崩溃恢复能力——
 *          终态事件总会立即写入当时最新的 snapshot。
 */
const PERSIST_THROTTLE_MS = 1500;

const MAX_RETAINED_CONTEXT_COMPACTIONS = 100;

const TERMINAL_RUN_STATUSES: ReadonlySet<SubAgentRunStatus> = new Set<SubAgentRunStatus>([
    'completed',
    'failed',
    'cancelled',
    'interrupted'
]);

/**
 * flushRun 落盘重试次数上限。
 *
 * 修改原因：终态元数据/transcript 写入失败或写入期间产生新变更时，flushRun 需要重新排队等待；
 *          重试次数写死为魔数 3 不易维护，也无法在日志中解释“为什么是 3 次”。
 * 修改方式：提取为命名常量，与 PERSIST_THROTTLE_MS 等持久化参数并列。
 */
const MAX_FLUSH_RETRY_ATTEMPTS = 3;

export {
    DEFAULT_CONTENT_WINDOW_LIMIT,
    MANIFEST_PREVIEW_MAX_LENGTH,
    MAX_EVENTS_PER_RUN,
    MAX_RETAINED_SNAPSHOTS,
    PERSIST_THROTTLE_MS,
    MAX_RETAINED_CONTEXT_COMPACTIONS,
    TERMINAL_RUN_STATUSES,
    MAX_FLUSH_RETRY_ATTEMPTS
};
