/**
 * SubAgent 运行时事件总线。
 *
 * 修改原因：SubAgent Monitor 要像正常聊天窗口一样恢复和渲染内部对话，而不是只展示事件列表。
 * 修改方式：每个 run 同时维护 runtime events 和标准 Content[] 子对话，并可将子对话保存到 conversation metadata。
 * 修改目的：主聊天时间线保持干净，Monitor 可恢复完整 SubAgent 内部记录，且前端能复用 MessageItem/ToolMessage/MessageTaskCards。
 */

import type { ITranscriptRepository } from '../../modules/conversation/TranscriptRepository';
import type { Content } from '../../modules/conversation/types';
import type { SubAgentTranscriptData } from '../../modules/conversation/storage';
import { SubAgentTranscriptRepository } from './SubAgentTranscriptRepository';
import type { ToolProgressEvent } from '../types';
import { Logger } from '../../core/logger';
import { deepClone } from '../../core/deepClone';

const logger = Logger.get('SubAgentRunEventBus');

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
    lastSentHistory?: Content[];
}

export interface SubAgentRunSnapshot extends SubAgentRunPersistedRecord {
    contents: Content[];
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
    /** 可选原子读改写（ConversationManager 提供）；缺失时 flushPersist 回退到 get+set 读改写 */
    updateCustomMetadata?(conversationId: string, key: string, updater: (current: unknown) => unknown | Promise<unknown>): Promise<unknown>;
    saveSubAgentTranscript?(conversationId: string, runId: string, data: SubAgentTranscriptData): Promise<string>;
    loadSubAgentTranscript?(conversationId: string, runId: string): Promise<SubAgentTranscriptData | null>;
    deleteSubAgentTranscript?(conversationId: string, runId: string): Promise<void>;
}

type SubAgentRunListener = (event: SubAgentRunEvent, snapshot: SubAgentRunSnapshot) => void;

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

function cloneContentsForWindow(contents: Content[]): Content[] {
    // 修改原因：按需 transcript window 会被前端本地流式 delta 临时修改，不能把事件总线内存对象引用直接交出去。
    // 修改方式：只对窗口切片做 JSON 深拷贝，而不是像旧 snapshots 首包那样复制所有 run 的完整 contents。
    // 修改目的：保持事件总线仍是唯一真源，同时把 Monitor 首屏和窗口请求的复制成本限定在窗口大小内。
    return deepClone(contents || []) as Content[];
}

function extractContentPreview(content: Content | undefined): string | undefined {
    if (!content) return undefined;
    // 修改原因：manifest 会在每个 llm_delta 事件上重新派生，旧实现先把整条消息的全部 parts 拼成完整字符串
    //          再截断到 160 字，对动辄数万字符的模型输出构成流式热路径上的 O(正文长度) 重复开销。
    // 修改方式：逐 part 累积，一旦超过预览上限立即停止读取后续内容。
    // 修改目的：预览成本与预览长度成正比，而不是与消息长度成正比。
    const segments: string[] = [];
    let length = 0;
    for (const part of content.parts || []) {
        let segment = '';
        if (typeof part.text === 'string' && part.text.trim()) {
            segment = part.text.trim();
        } else if (part.functionCall?.name) {
            segment = `调用工具 ${part.functionCall.name}`;
        } else if (part.functionResponse?.name) {
            segment = `工具结果 ${part.functionResponse.name}`;
        }
        if (!segment) continue;
        // 单个 part 就可能远超上限，先按上限裁剪再累积
        segments.push(segment.length > MANIFEST_PREVIEW_MAX_LENGTH + 1
            ? segment.slice(0, MANIFEST_PREVIEW_MAX_LENGTH + 1)
            : segment);
        length += segment.length + 1;
        if (length > MANIFEST_PREVIEW_MAX_LENGTH) break;
    }

    const text = segments.join(' ').replace(/\s+/g, ' ').trim();
    if (!text) return undefined;
    return text.length > MANIFEST_PREVIEW_MAX_LENGTH
        ? `${text.slice(0, MANIFEST_PREVIEW_MAX_LENGTH)}…`
        : text;
}

function ensureSnapshotProtocolFields(snapshot: SubAgentRunSnapshot): void {
    // 修改原因：旧 conversation metadata 中没有 contentRevision/eventSequence，新协议读取历史 run 时不能让字段变成 undefined。
    // 修改方式：在所有 snapshot 进入事件总线时统一补齐协议字段，并把非数字值归零。
    // 修改目的：manifest、window、event 的 freshness 判断在新旧数据上使用同一语义。
    snapshot.contentRevision = Number.isFinite(snapshot.contentRevision) ? snapshot.contentRevision : 0;
    snapshot.eventSequence = Number.isFinite(snapshot.eventSequence) ? snapshot.eventSequence : 0;
}

function stampRunEvent(snapshot: SubAgentRunSnapshot, event: SubAgentRunEvent): SubAgentRunEvent {
    // 修改原因：Webview postMessage 和 getRunWindow response 可能乱序到达，事件必须携带 run 内单调序号。
    // 修改方式：所有事件统一通过本 helper 递增 snapshot.eventSequence，并同时附带当前 contentRevision。
    // 修改目的：前端可以拒绝旧事件或旧窗口，不再依赖 updatedAt 和加载时机猜测。
    snapshot.eventSequence += 1;
    return {
        ...event,
        eventSequence: snapshot.eventSequence,
        contentRevision: snapshot.contentRevision
    };
}

function bumpContentRevision(snapshot: SubAgentRunSnapshot): void {
    // 修改原因：append/update/replace 都会改变 transcript 真源，窗口缓存必须能识别这些变化。
    // 修改方式：所有 Content[] 写入口在发 content_snapshot 前递增 contentRevision。
    // 修改目的：避免旧窗口继续接收下一轮 delta，修复多次回复混为一楼。
    snapshot.contentRevision += 1;
}

function toManifest(snapshot: SubAgentRunSnapshot): SubAgentRunManifest {
    // 修改原因：Monitor run tab 和首屏只需要列表元数据，不需要完整 transcript。
    // 修改方式：从唯一 snapshot 派生轻量 manifest，并把 preview 截断到固定长度，同时携带单调 revision/sequence。
    // 修改目的：避免 monitorReady 阶段把所有 run 的 contents 经 stringify/postMessage/deserialize 一次性送进前端，并让前端能判断窗口新旧。
    ensureSnapshotProtocolFields(snapshot);
    const contents = snapshot.contents || [];
    const transcriptLoaded = snapshot.transcriptLoaded !== false;
    const lastContent = transcriptLoaded && contents.length > 0 ? contents[contents.length - 1] : undefined;
    return {
        runId: snapshot.runId,
        agentName: snapshot.agentName,
        status: snapshot.status,
        createdAt: snapshot.createdAt,
        updatedAt: snapshot.updatedAt,
        conversationId: snapshot.conversationId,
        contentCount: transcriptLoaded ? contents.length : (snapshot.contentCount ?? 0),
        eventCount: (snapshot.events || []).length,
        contentRevision: snapshot.contentRevision,
        eventSequence: snapshot.eventSequence,
        preview: transcriptLoaded ? extractContentPreview(lastContent) : snapshot.preview,
        lastMessageRole: transcriptLoaded ? lastContent?.role : snapshot.lastMessageRole
    };
}

function providerHistoryBucketKey(content: Content): string {
    const parts = content.parts || [];
    // 粗指纹：role + parts 数量 + 首个文本部分的长度。
    // 绝大多数消息在这一层即可区分，避免对大型 parts（图片/长工具结果）做全量 stringify。
    const firstPart = parts[0] as { text?: unknown } | undefined;
    const firstTextLength = typeof firstPart?.text === 'string' ? firstPart.text.length : 0;
    return `${content.role}:${parts.length}:${firstTextLength}`;
}

function providerHistoryKey(content: Content): string {
    return JSON.stringify({ role: content.role, parts: content.parts || [] });
}

function buildLastSentHistoryProjection(
    contents: Content[],
    lastSentHistory: Content[]
): NonNullable<SubAgentTranscriptData['lastSentHistoryProjection']> {
    // 两级索引：先按粗桶（role + parts 数量 + 首文本长度）分组，桶内再惰性建立精确 key 索引。
    // 与直接把每个 content 全量 stringify 作 Map key 相比，桶内无匹配时（绝大多数情况）不会
    // 为大型 parts 产生大字符串；同一桶的精确索引也只构建一次。
    const contentIndicesByBucket = new Map<string, number[]>();
    contents.forEach((content, index) => {
        const bucket = providerHistoryBucketKey(content);
        const indices = contentIndicesByBucket.get(bucket) ?? [];
        indices.push(index);
        contentIndicesByBucket.set(bucket, indices);
    });
    const exactIndexByBucket = new Map<string, Map<string, number[]>>();
    const getExactIndex = (bucket: string): Map<string, number[]> => {
        let exact = exactIndexByBucket.get(bucket);
        if (exact) return exact;
        exact = new Map<string, number[]>();
        for (const index of contentIndicesByBucket.get(bucket) ?? []) {
            const key = providerHistoryKey(contents[index]);
            const indices = exact.get(key) ?? [];
            indices.push(index);
            exact.set(key, indices);
        }
        exactIndexByBucket.set(bucket, exact);
        return exact;
    };
    const consumedByKey = new Map<string, number>();
    return {
        version: 1,
        entries: lastSentHistory.map(content => {
            const exact = getExactIndex(providerHistoryBucketKey(content));
            const key = providerHistoryKey(content);
            const indices = exact.get(key) ?? [];
            const consumed = consumedByKey.get(key) ?? 0;
            const contentIndex = indices[consumed];
            if (contentIndex === undefined) {
                return { content: deepClone(content) as Content };
            }
            consumedByKey.set(key, consumed + 1);
            return { contentIndex };
        })
    };
}

function restoreLastSentHistory(data: SubAgentTranscriptData): Content[] | undefined {
    if (Array.isArray(data.lastSentHistory)) {
        return data.lastSentHistory;
    }
    if (!Array.isArray(data.contents)) return undefined;
    const projection = data.lastSentHistoryProjection;
    if (!projection || projection.version !== 1 || !Array.isArray(projection.entries)) return undefined;
    const restored: Content[] = [];
    for (const entry of projection.entries) {
        if (!entry || typeof entry !== 'object') return undefined;
        if ('content' in entry) {
            if (!entry.content || typeof entry.content !== 'object') return undefined;
            restored.push(deepClone(entry.content) as Content);
            continue;
        }
        if (!('contentIndex' in entry) || !Number.isInteger(entry.contentIndex) || entry.contentIndex < 0) {
            return undefined;
        }
        const source = data.contents[entry.contentIndex];
        if (!source || typeof source !== 'object' || !Array.isArray(source.parts)) return undefined;
        // Provider formatter只消费 role/parts；显示层的 index/timestamp/isFunctionResponse 等字段不属于请求前缀。
        restored.push({
            role: source.role,
            parts: deepClone(source.parts || [])
        } as Content);
    }
    return restored;
}

function isLiveOnlyEvent(event: SubAgentRunEvent): boolean {
    // 修改原因：llm_delta 是高频流式热路径，写入 snapshot.events 会让内存事件列表和 Monitor postMessage 随输出长度 O(n²) 膨胀。
    // 修改方式：把 llm_delta 标记为仅实时广播事件，不进入持久事件 journal，也不触发 metadata 落盘。
    // 修改目的：SubAgent Monitor 能实时消费 delta，但历史恢复仍只依赖最终 contents 快照。
    return event.type === 'llm_delta';
}

function normalizePersistedMap(raw: unknown): Record<string, SubAgentRunPersistedRecord> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return {};
    }
    return raw as Record<string, SubAgentRunPersistedRecord>;
}

export class SubAgentRunEventBus {
    private markStaleRecordInterrupted(record: SubAgentRunPersistedRecord): boolean {
        if (TERMINAL_RUN_STATUSES.has(record.status)) return false;
        record.status = 'interrupted';
        record.updatedAt = Date.now();
        return true;
    }

    getTranscriptRepository(runId: string): ITranscriptRepository {
        // 修改原因：SubAgent 子 transcript 需要与主聊天共享同一仓储抽象，而不暴露事件总线内部的 snapshot/persist 细节。
        // 修改方式：为指定 runId 创建一个绑定当前事件总线的 SubAgentTranscriptRepository。
        // 修改目的：调用方通过统一接口读写子 transcript，同时保留事件总线现有广播与 metadata 持久化语义。
        return new SubAgentTranscriptRepository(this, runId);
    }

    private readonly listeners = new Set<SubAgentRunListener>();
    private readonly snapshots = new Map<string, SubAgentRunSnapshot>();
    private readonly stores = new Map<string, SubAgentRunConversationStore>();
    /**
     * 持久化写队列：按 conversationId 键控。
     *
     * 修改原因：flushPersist 的「读整份 metadata → 改一条 → 写回整份」作用于 conversation 级文档，
     *          队列原来按 runId 串行只保证单个 run 内部不交叉，同一会话并行运行的多个 run 仍会并发
     *          读改写，后写者覆盖先写者，丢失对方 run 的 transcript 记录。
     * 修改方式：队列改为按 conversationId 串行；pendingPersists 仍按 runId 合并同一 run 的连续落盘请求。
     * 修改目的：同一会话内任意两个 run 的落盘互斥，读改写不再交叉，同时保留原有节流合并语义。
     */
    private readonly persistQueues = new Map<string, Promise<void>>();
    /** 已排队但尚未开始写入的 run，用于合并连续的持久化请求 */
    private readonly pendingPersists = new Set<string>();
    /** 节流窗口内待落盘的 run 定时器 */
    private readonly persistTimers = new Map<string, ReturnType<typeof setTimeout>>();
    /** 各 run 上一次真正发起落盘的时刻 */
    private readonly lastPersistAt = new Map<string, number>();
    /** transcript 按 run 惰性加载时合并并发请求，避免同一大文件重复 parse。 */
    private readonly transcriptLoadPromises = new Map<string, Promise<SubAgentRunSnapshot | undefined>>();
    /** 最近一次持久化错误；flushRun 会有限重试并在仍失败时上抛。 */
    private readonly persistErrors = new Map<string, unknown>();

    /**
     * 追加事件到 run 的内存 journal，并保持长度有界。
     */
    private pushEvent(snapshot: SubAgentRunSnapshot, event: SubAgentRunEvent): void {
        snapshot.events.push(event);
        if (snapshot.events.length > MAX_EVENTS_PER_RUN) {
            snapshot.events.splice(0, snapshot.events.length - MAX_EVENTS_PER_RUN);
        }
    }

    /**
     * transcript 变更的统一提交尾巴：递增修订号、广播 content_snapshot、入队落盘。
     *
     * 修改原因：append / updateLast / replace 三个写入口各自复制了同一段"改时间 → bump revision → stamp → push →
     *          notify → persist"逻辑，且都把整个 snapshot.contents 塞进事件 payload。该 payload 没有任何消费者
     *          （Monitor 面板一律从 snapshot 自行派生 contentCount），却会让内存事件 journal 长期引用旧 contents 数组，
     *          replaceContents 之后被替换掉的数组因此无法回收。
     * 修改方式：抽成单一提交入口，事件只携带 contentCount 等轻量状态字段。
     * 修改目的：写入口只描述"改了什么"，提交语义与事件瘦身在一处维护。
     */
    private commitContentChange(snapshot: SubAgentRunSnapshot, timestamp: number): void {
        snapshot.updatedAt = timestamp;
        snapshot.transcriptLoaded = true;
        snapshot.contentCount = snapshot.contents.length;
        const lastContent = snapshot.contents[snapshot.contents.length - 1];
        snapshot.preview = extractContentPreview(lastContent);
        snapshot.lastMessageRole = lastContent?.role;
        bumpContentRevision(snapshot);
        const event = stampRunEvent(snapshot, {
            runId: snapshot.runId,
            agentName: snapshot.agentName,
            type: 'content_snapshot',
            timestamp,
            payload: { contentCount: snapshot.contents.length }
        });
        this.pushEvent(snapshot, event);
        this.notify(event, snapshot);
        this.enqueuePersist(snapshot.runId);
    }

    /**
     * 按容量淘汰内存中最旧的可恢复 run 快照。
     *
     * 只淘汰同时满足以下条件的 run：已进入终态、拥有 conversationId 与 store（即已持久化，可再次恢复）。
     * 运行中的 run 和无持久化归属的 run 永不淘汰。
     */
    private evictSnapshotsIfNeeded(): void {
        if (this.snapshots.size <= MAX_RETAINED_SNAPSHOTS) {
            return;
        }
        const evictable = Array.from(this.snapshots.values())
            .filter(snapshot => TERMINAL_RUN_STATUSES.has(snapshot.status)
                && !!snapshot.conversationId
                && this.stores.has(snapshot.runId))
            .sort((a, b) => a.updatedAt - b.updatedAt);

        let overflow = this.snapshots.size - MAX_RETAINED_SNAPSHOTS;
        for (const snapshot of evictable) {
            if (overflow <= 0) break;
            // 仍有未完成的持久化写入时跳过，避免丢失尚未落盘的内容
            if (this.pendingPersists.has(snapshot.runId) || this.persistTimers.has(snapshot.runId)) continue;
            this.snapshots.delete(snapshot.runId);
            this.stores.delete(snapshot.runId);
            // 修改原因：persistQueues 已改为按 conversationId 键控，不能在这里按 runId 删除——
            //          同会话其他 run 可能还有排队中的写入，删掉会话队列会破坏它们的串行化。
            // 修改方式：保留会话级队列条目（已 settle 的 Promise，按会话数有界，后续写入会覆盖）。
            this.lastPersistAt.delete(snapshot.runId);
            overflow--;
        }
    }

    /**
     * 分配一个不会撞上**仍然活跃**的 run 的 runId。
     *
     * 预分配的 runId 由主工具调用 id 推导，同一个 toolId 二次执行时会重复。旧 run 已终态时沿用
     * 同名是刻意的：前端在 pending 阶段就是按 toolId 推导 runId 来关联工具卡与 Monitor 的。
     * 但旧 run 还活着时沿用就有实害——createRun 会覆盖它的内存快照，runController.register 又会
     * 把旧 AbortController 交给新 run，于是在 Monitor 里暂停其中一个会连带暂停另一个。
     */
    allocateRunId(preferredRunId: string): string {
        const existing = this.snapshots.get(preferredRunId);
        if (!existing || TERMINAL_RUN_STATUSES.has(existing.status)) {
            return preferredRunId;
        }

        let suffix = 2;
        while (this.snapshots.has(`${preferredRunId}__${suffix}`)) {
            suffix++;
        }
        return `${preferredRunId}__${suffix}`;
    }

    createRun(
        runId: string,
        agentName?: string,
        payload?: unknown,
        options?: {
            conversationId?: string;
            conversationStore?: SubAgentRunConversationStore;
            initialContents?: Content[];
        }
    ): SubAgentRunSnapshot {
        const now = Date.now();
        const snapshot: SubAgentRunSnapshot = {
            runId,
            agentName,
            status: 'running',
            createdAt: now,
            updatedAt: now,
            contents: options?.initialContents || [],
            events: [],
            conversationId: options?.conversationId,
            // 修改原因：新建 run 需要立即具备 freshness 协议字段，后续 run_created/窗口响应才能共享同一判断规则。
            // 修改方式：eventSequence/contentRevision 从 0 开始，事件发送和 transcript 写入分别递增。
            // 修改目的：避免前端在首个 manifest/window 上收到 undefined revision，导致旧窗口保护失效。
            contentRevision: 0,
            eventSequence: 0,
            transcriptLoaded: true
        };
        this.snapshots.set(runId, snapshot);
        if (options?.conversationId && options.conversationStore) {
            this.stores.set(runId, options.conversationStore);
        }
        this.evictSnapshotsIfNeeded();
        this.emit({
            runId,
            agentName,
            type: 'run_created',
            timestamp: now,
            payload
        });
        return snapshot;
    }

    /**
     * 续跑：复用已终态 run 的快照继续执行（continueFromRunId 语义）。
     *
     * 修改原因：续跑过去会 createRun 重建快照，Monitor 里出现两条相同身份的 run，
     *          且 events 清空、contentRevision/eventSequence 重置，展示上像两个不同的子代理。
     * 修改方式：快照已存在时不清空 contents/events/lastSentHistory，不重置协议序号，
     *          仅把状态从终态切回 running、追加本次 initialContents，并广播 run_resumed
     *          （事件类型与 Monitor 暂停恢复复用同一语义，emit 已有 status 映射）。
     * 修改目的：续跑 = 同一条 run 接着跑——transcript 一条线连续、Monitor 记录唯一、
     *          provider 前缀缓存命中条件不变；快照缺失时防御性回退 createRun。
     */
    resumeRun(
        runId: string,
        agentName?: string,
        payload?: unknown,
        options?: {
            conversationId?: string;
            conversationStore?: SubAgentRunConversationStore;
            initialContents?: Content[];
        }
    ): SubAgentRunSnapshot {
        const existing = this.snapshots.get(runId);
        if (!existing) {
            // 防御：续跑校验已保证快照存在（内存或持久化恢复），缺失时退化为新建
            return this.createRun(runId, agentName, payload, options);
        }
        const now = Date.now();
        const fromStatus = existing.status;
        existing.status = 'running';
        existing.updatedAt = now;
        existing.transcriptLoaded = true;
        if (agentName) {
            existing.agentName = agentName;
        }
        if (options?.conversationId) {
            existing.conversationId = options.conversationId;
            if (options.conversationStore) {
                this.stores.set(runId, options.conversationStore);
            }
        }
        this.emit({
            runId,
            agentName,
            type: 'run_resumed',
            timestamp: now,
            payload: {
                ...(payload || {}),
                fromStatus
            }
        });
        for (const content of options?.initialContents ?? []) {
            this.appendContent(runId, content);
        }
        return existing;
    }

    emit(event: ToolProgressEvent & { runId: string; agentName?: string }): void {
        const timestamp = event.timestamp || Date.now();
        const normalized: SubAgentRunEvent = {
            ...event,
            timestamp
        };

        let snapshot = this.snapshots.get(normalized.runId);
        if (!snapshot) {
            snapshot = {
                runId: normalized.runId,
                agentName: normalized.agentName,
                status: 'running',
                createdAt: timestamp,
                updatedAt: timestamp,
                contents: [],
                events: [],
                // 修改原因：事件先于 createRun 到达时也必须具备协议字段，不能让自动创建路径落后于正常 createRun。
                // 修改方式：自动 snapshot 同样从 0 初始化 eventSequence/contentRevision。
                // 修改目的：保证 Monitor 对异常/恢复事件也能执行同一 stale 判断。
                contentRevision: 0,
                eventSequence: 0,
                transcriptLoaded: true
            };
            this.snapshots.set(normalized.runId, snapshot);
        }

        ensureSnapshotProtocolFields(snapshot);
        snapshot.agentName = normalized.agentName || snapshot.agentName;
        snapshot.updatedAt = timestamp;
        const stamped = stampRunEvent(snapshot, normalized);
        if (!isLiveOnlyEvent(stamped)) {
            this.pushEvent(snapshot, stamped);
        }

        if (stamped.type === 'run_completed') {
            snapshot.status = 'completed';
        } else if (stamped.type === 'run_failed') {
            snapshot.status = 'failed';
        } else if (stamped.type === 'run_cancelled') {
            snapshot.status = 'cancelled';
        } else if (stamped.type === 'run_paused') {
            // 修改原因：Monitor 中止不能被记录成 failed，否则主窗口工具会误判 SubAgent 已经失败。
            // 修改方式：运行事件总线将 run_paused 映射为 paused 状态。
            // 修改目的：保留主工具等待语义，同时让 Monitor 明确显示“已暂停”。
            snapshot.status = 'paused';
        } else if (stamped.type === 'run_resumed') {
            snapshot.status = 'running';
        } else if (stamped.type === 'run_queued') {
            // 修改原因：并发排队时 Monitor 需要区分“排队中”和“执行中”，否则用户会误以为 run 卡死。
            // 修改方式：executor 在 acquire 信号量前发 run_queued，acquire 成功后发 run_started 恢复 running。
            // 修改目的：排队状态可视化，且排队时间不计入 maxRuntime。
            snapshot.status = 'queued';
        } else if (stamped.type === 'run_started') {
            snapshot.status = 'running';
        } else if (stamped.type === 'run_awaiting_monitor_action') {
            snapshot.status = 'awaiting_monitor_action';
        } else if (stamped.type === 'run_interrupted') {
            snapshot.status = 'interrupted';
        }

        this.notify(stamped, snapshot);
        if (stamped.type.startsWith('run_')) {
            // run 状态变更是低频且关键的（尤其终态），不参与内容写入的节流窗口
            this.enqueuePersist(stamped.runId, true);
        }
    }

    appendContent(runId: string, content: Content): void {
        const snapshot = this.snapshots.get(runId);
        if (!snapshot) {
            return;
        }
        ensureSnapshotProtocolFields(snapshot);
        const now = Date.now();
        snapshot.contents.push({
            ...content,
            timestamp: content.timestamp || now,
            index: snapshot.contents.length
        } as Content);
        this.commitContentChange(snapshot, now);
    }

    updateLastModelContent(runId: string, content: Content): void {
        const snapshot = this.snapshots.get(runId);
        if (!snapshot) {
            return;
        }
        ensureSnapshotProtocolFields(snapshot);
        const lastIndex = snapshot.contents.length - 1;
        if (lastIndex >= 0 && snapshot.contents[lastIndex]?.role === 'model') {
            snapshot.contents[lastIndex] = {
                ...content,
                timestamp: content.timestamp || snapshot.contents[lastIndex].timestamp || Date.now(),
                index: snapshot.contents[lastIndex].index ?? lastIndex
            } as Content;
        } else {
            this.appendContent(runId, content);
            return;
        }

        // 修改原因：这里过去是三个 transcript 写入口中唯一不落盘的，持久记录的 contentRevision 会落后于内存快照，
        //          扩展在 run 进行中重载时最后一轮模型输出也无法恢复。
        // 修改方式：与 appendContent/replaceContents 走同一个 commitContentChange 提交尾巴。
        // 修改目的：transcript 的三个写入口具有一致的广播与持久化语义。
        this.commitContentChange(snapshot, Date.now());
    }

    replaceContents(runId: string, contents: Content[]): SubAgentRunSnapshot | undefined {
        const snapshot = this.snapshots.get(runId);
        if (!snapshot) {
            return undefined;
        }

        // 修改原因：Monitor 删除/重试内部楼层后，新的 Content[] 必须写回 run 快照和 conversation metadata。
        // 修改方式：由事件总线提供 replaceContents 作为唯一写入口，统一更新时间、通知前端和入队持久化。
        // 修改目的：避免 SubAgentsHandlers 直接改 snapshot.contents，保证内存和持久化记录同步。
        ensureSnapshotProtocolFields(snapshot);
        const now = Date.now();
        snapshot.contents = contents.map((content, index) => ({
            ...content,
            index,
            timestamp: content.timestamp || now
        } as Content));
        this.commitContentChange(snapshot, now);
        return snapshot;
    }

    mutateContents(runId: string, mutator: (contents: Content[]) => Content[]): SubAgentRunSnapshot | undefined {
        const snapshot = this.snapshots.get(runId);
        if (!snapshot) {
            return undefined;
        }

        // 修改原因：SubAgent 子对话要复用 TranscriptMutation 这类纯变更函数，同时由事件总线负责保存结果。
        // 修改方式：复制当前 contents 后交给 mutator，再通过 replaceContents 统一落盘和广播。
        // 修改目的：让 Monitor 消息操作不绕过事件总线的持久化队列。
        const nextContents = mutator(deepClone(snapshot.contents || []) as Content[]);
        return this.replaceContents(runId, nextContents);
    }

    /**
     * 记录某 run 最后一次实际发送给 provider 的 history（供 continueFromRunId 续跑精确复用）。
     *
     * 修改原因：续跑必须以「旧 run 真正发给 provider 的请求前缀」为 baseContents，
     *          而不是 Monitor 展示用的 contents（首条是 # SubAgent Invocation 卡片、从未发给模型），
     *          否则续跑请求从第 0 条起就与旧 run 不同，provider 前缀缓存（DeepSeek KVCache /
     *          Anthropic user_id 域）必然 miss。
     * 修改方式：深拷贝存入 snapshot.lastSentHistory，只更新时间与入队持久化；
     *          不调用 commitContentChange / bumpContentRevision，不发 content_snapshot 事件。
     * 修改目的：续跑复用旧 run 的 provider 前缀缓存，同时不污染 Monitor 的 contents 与 contentRevision。
     */
    updateLastSentHistory(runId: string, history: Content[]): void {
        const snapshot = this.snapshots.get(runId);
        if (!snapshot) {
            return;
        }
        ensureSnapshotProtocolFields(snapshot);
        const now = Date.now();
        snapshot.lastSentHistory = deepClone(history || []) as Content[];
        snapshot.updatedAt = now;
        // 与内容类写入共用节流持久化窗口；不 bump contentRevision、不发 content_snapshot
        this.enqueuePersist(runId);
    }

    subscribe(listener: SubAgentRunListener): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    getSnapshot(runId: string): SubAgentRunSnapshot | undefined {
        return this.snapshots.get(runId);
    }

    getManifest(runId: string): SubAgentRunManifest | undefined {
        const snapshot = this.snapshots.get(runId);
        return snapshot ? toManifest(snapshot) : undefined;
    }

    getManifests(): SubAgentRunManifest[] {
        // 修改原因：SubAgent Monitor 首屏只需要 run 列表、状态和预览，完整 contents 会在大输出场景造成打开卡顿。
        // 修改方式：保留 getSnapshots 供兼容路径使用，新增 getManifests 只派生轻量字段且绝不包含 contents/events。
        // 修改目的：不引入第二真源，仍从现有 snapshot 派生 Monitor manifest。
        return Array.from(this.snapshots.values())
            .map(snapshot => toManifest(snapshot))
            .sort((a, b) => b.updatedAt - a.updatedAt);
    }

    getContentWindow(runId: string, options: SubAgentRunContentWindowOptions = {}): SubAgentRunContentWindow | undefined {
        const snapshot = this.snapshots.get(runId);
        if (!snapshot || snapshot.transcriptLoaded === false) {
            return undefined;
        }

        // 修改原因：聚焦 run 后只需要先渲染一段 transcript，不应一次性传输完整 contents。
        // 修改方式：基于 snapshot.contents 做窗口切片；默认从尾部取最后 20 条，显式 start/end/limit 可支持后续“加载更多”。
        // 修改目的：保持 Content[]/MessageItem 渲染语义不分叉，同时把传输、反序列化和 Markdown 渲染成本限制在窗口内。
        const contents = snapshot.contents || [];
        const totalCount = contents.length;
        const rawLimit = Number.isFinite(options.limit) ? Math.max(0, Math.floor(options.limit!)) : DEFAULT_CONTENT_WINDOW_LIMIT;
        const limit = rawLimit > 0 ? rawLimit : DEFAULT_CONTENT_WINDOW_LIMIT;
        let startIndex: number;
        let endIndex: number;

        if (typeof options.startIndex === 'number' || typeof options.endIndex === 'number') {
            // 修改原因：“加载更早消息”会只传 endIndex=当前窗口 startIndex，语义是取该位置之前的一页；旧逻辑会错误返回 0..limit。
            // 修改方式：分别处理 start-only、end-only、start+end 三种窗口请求；end-only 从 endIndex 向前回退 limit 条。
            // 修改目的：前端可以用真实 backendIndex 分页向前加载，而不需要知道完整 transcript 长度或自行换算。
            if (typeof options.startIndex === 'number' && typeof options.endIndex === 'number') {
                startIndex = Math.max(0, Math.min(totalCount, Math.floor(options.startIndex)));
                endIndex = Math.max(startIndex, Math.min(totalCount, Math.floor(options.endIndex)));
                if (endIndex - startIndex > limit) {
                    endIndex = startIndex + limit;
                }
            } else if (typeof options.endIndex === 'number') {
                endIndex = Math.max(0, Math.min(totalCount, Math.floor(options.endIndex)));
                startIndex = Math.max(0, endIndex - limit);
            } else {
                startIndex = Math.max(0, Math.min(totalCount, Math.floor(options.startIndex!)));
                endIndex = Math.min(totalCount, startIndex + limit);
            }
        } else if (options.fromTail !== false) {
            endIndex = totalCount;
            startIndex = Math.max(0, endIndex - limit);
        } else {
            startIndex = 0;
            endIndex = Math.min(totalCount, limit);
        }

        ensureSnapshotProtocolFields(snapshot);
        return {
            runId,
            contents: cloneContentsForWindow(contents.slice(startIndex, endIndex)),
            startIndex,
            endIndex,
            totalCount,
            contentRevision: snapshot.contentRevision,
            eventSequence: snapshot.eventSequence,
            hasMoreBefore: startIndex > 0,
            hasMoreAfter: endIndex < totalCount
        };
    }

    getSnapshots(): SubAgentRunSnapshot[] {
        return Array.from(this.snapshots.values()).sort((a, b) => b.updatedAt - a.updatedAt);
    }

    /** 仅在 Monitor 打开某个 run、续跑或修改 transcript 时读取该 run 的独立 transcript。 */
    async loadRunTranscript(runId: string): Promise<SubAgentRunSnapshot | undefined> {
        const snapshot = this.snapshots.get(runId);
        if (!snapshot || snapshot.transcriptLoaded !== false) return snapshot;
        const existingLoad = this.transcriptLoadPromises.get(runId);
        if (existingLoad) return await existingLoad;

        const load = (async () => {
            const store = this.stores.get(runId);
            if (!store?.loadSubAgentTranscript || !snapshot.conversationId || !snapshot.transcriptRef) {
                snapshot.transcriptLoaded = true;
                return snapshot;
            }
            const external = await store.loadSubAgentTranscript(snapshot.conversationId, runId);
            snapshot.contents = Array.isArray(external?.contents) ? external.contents : [];
            const lastSentHistory = external ? restoreLastSentHistory(external) : undefined;
            if (Array.isArray(lastSentHistory)) {
                snapshot.lastSentHistory = deepClone(lastSentHistory) as Content[];
            } else {
                delete snapshot.lastSentHistory;
            }
            snapshot.contentCount = snapshot.contents.length;
            const lastContent = snapshot.contents[snapshot.contents.length - 1];
            snapshot.preview = extractContentPreview(lastContent);
            snapshot.lastMessageRole = lastContent?.role;
            snapshot.transcriptLoaded = true;
            return snapshot;
        })().finally(() => {
            this.transcriptLoadPromises.delete(runId);
        });
        this.transcriptLoadPromises.set(runId, load);
        return await load;
    }

    /** 等待指定 run 的最新 transcript 与终态元数据落盘；失败时重试，避免工具已返回而 metadata 仍为 running。 */
    async flushRun(runId: string): Promise<void> {
        const snapshot = this.snapshots.get(runId);
        if (!snapshot?.conversationId || snapshot.transcriptLoaded === false) return;
        for (let attempt = 0; attempt < MAX_FLUSH_RETRY_ATTEMPTS; attempt++) {
            const timer = this.persistTimers.get(runId);
            if (timer) {
                clearTimeout(timer);
                this.persistTimers.delete(runId);
            }
            this.persistErrors.delete(runId);
            this.flushPersist(runId);
            const tail = this.persistQueues.get(snapshot.conversationId);
            await (tail ?? Promise.resolve());
            const error = this.persistErrors.get(runId);
            const dirty = this.pendingPersists.has(runId) || this.persistTimers.has(runId);
            if (!error && !dirty) return;
            if (attempt === MAX_FLUSH_RETRY_ATTEMPTS - 1 && error) throw error;
        }
        throw new Error(`SubAgent persistence did not become idle for run ${runId}`);
    }

    /** 等待该会话已排队的 transcript/索引写入完成，并吸收写入期间产生的后续脏状态。 */
    async flushConversation(conversationId: string): Promise<void> {
        const runIds = (): string[] => Array.from(this.snapshots.values())
            .filter(snapshot => snapshot.conversationId === conversationId)
            .map(snapshot => snapshot.runId);
        for (const runId of runIds()) await this.flushRun(runId);
    }

    /** 对话删除后清理事件总线内存与队列引用，防止旧 run 再写入已删除会话。 */
    forgetConversation(conversationId: string): void {
        for (const [runId, snapshot] of this.snapshots) {
            if (snapshot.conversationId !== conversationId) continue;
            const timer = this.persistTimers.get(runId);
            if (timer) clearTimeout(timer);
            this.persistTimers.delete(runId);
            this.pendingPersists.delete(runId);
            this.lastPersistAt.delete(runId);
            this.stores.delete(runId);
            this.snapshots.delete(runId);
            this.transcriptLoadPromises.delete(runId);
            this.persistErrors.delete(runId);
        }
        this.persistQueues.delete(conversationId);
    }

    async loadConversationSnapshots(
        conversationId: string,
        store: SubAgentRunConversationStore
    ): Promise<SubAgentRunSnapshot[]> {
        const raw = await store.getCustomMetadata(conversationId, SUBAGENT_RUNS_METADATA_KEY);
        const persistedMap = normalizePersistedMap(raw);
        const snapshots: SubAgentRunSnapshot[] = [];
        let migratedLegacyRecord = false;
        let interruptedStaleRecord = false;

        for (const record of Object.values(persistedMap)) {
            const existing = this.snapshots.get(record.runId);
            if (existing) {
                snapshots.push(existing);
                continue;
            }
            // 扩展宿主重启后，元数据中的非终态 run 已不可能继续执行；及时纠正状态，
            // 避免 Monitor 永久显示 running/queued。当前进程仍活跃的 run 已命中上面的 snapshot 分支。
            interruptedStaleRecord = this.markStaleRecordInterrupted(record) || interruptedStaleRecord;
            // 独立 transcript 只恢复轻量索引；Monitor 聚焦、续跑或消息修改时才按 run 读取正文。
            // 旧内嵌格式必须先读取现有数组并迁移，迁移完成后的本次快照仍可直接使用。
            const legacyContents = Array.isArray(record.contents) ? record.contents : undefined;
            const legacyLastSentHistory = Array.isArray(record.lastSentHistory) ? record.lastSentHistory : undefined;
            const contents = legacyContents ?? [];
            const snapshot: SubAgentRunSnapshot = {
                ...record,
                contents,
                events: [],
                conversationId,
                // 修改原因：旧 metadata 没有 revision/sequence 字段；恢复为 snapshot 时必须补齐，后续写回会自动升级持久格式。
                // 修改方式：缺失字段统一补 0，保留已有新格式字段。
                // 修改目的：历史 run 也能参与前端 stale window 判断，不需要专门兼容分支。
                contentRevision: Number.isFinite(record.contentRevision) ? record.contentRevision! : 0,
                eventSequence: Number.isFinite(record.eventSequence) ? record.eventSequence! : 0,
                transcriptLoaded: !record.transcriptRef || !!legacyContents,
                // 修改原因：lastSentHistory 是续跑复用 provider 前缀缓存的唯一依据，恢复时深拷贝避免与持久化对象共享引用。
                // 修改方式：仅在字段为数组时显式重建；旧数据缺字段时保持 undefined，由 executor 降级处理。
                ...(Array.isArray(legacyLastSentHistory)
                    ? { lastSentHistory: deepClone(legacyLastSentHistory) as Content[] }
                    : {})
            };
            if (!record.transcriptRef && Array.isArray(record.contents) && store.saveSubAgentTranscript) {
                record.transcriptRef = await store.saveSubAgentTranscript(conversationId, record.runId, {
                    contents,
                    ...(legacyLastSentHistory ? { lastSentHistory: legacyLastSentHistory } : {})
                });
                record.contentCount = contents.length;
                delete record.contents;
                delete record.lastSentHistory;
                migratedLegacyRecord = true;
            }
            this.snapshots.set(record.runId, snapshot);
            this.stores.set(record.runId, store);
            snapshots.push(snapshot);
        }
        if (migratedLegacyRecord || interruptedStaleRecord) {
            await store.setCustomMetadata(conversationId, SUBAGENT_RUNS_METADATA_KEY, persistedMap);
        }
        this.evictSnapshotsIfNeeded();

        return snapshots.sort((a, b) => b.updatedAt - a.updatedAt);
    }

    private notify(event: SubAgentRunEvent, snapshot: SubAgentRunSnapshot): void {
        for (const listener of this.listeners) {
            listener(event, snapshot);
        }
    }

    /**
     * 请求把 run 落盘。
     *
     * @param immediate run 状态变更（含终态）跳过节流窗口立即写入；内容类变更按 PERSIST_THROTTLE_MS 合并。
     */
    private enqueuePersist(runId: string, immediate = false): void {
        if (immediate) {
            const timer = this.persistTimers.get(runId);
            if (timer) {
                clearTimeout(timer);
                this.persistTimers.delete(runId);
            }
            this.flushPersist(runId);
            return;
        }

        // 已有待落盘窗口时无需重复排期：定时器到期时读取的是届时最新的 snapshot
        if (this.persistTimers.has(runId)) {
            return;
        }
        const elapsed = Date.now() - (this.lastPersistAt.get(runId) ?? 0);
        if (elapsed >= PERSIST_THROTTLE_MS) {
            this.flushPersist(runId);
            return;
        }
        const timer = setTimeout(() => {
            this.persistTimers.delete(runId);
            this.flushPersist(runId);
        }, PERSIST_THROTTLE_MS - elapsed);
        // 待落盘窗口不应成为进程存活理由：真正的数据安全由终态事件的立即落盘保证
        (timer as { unref?: () => void }).unref?.();
        this.persistTimers.set(runId, timer);
    }

    private flushPersist(runId: string): void {
        const snapshot = this.snapshots.get(runId);
        const store = this.stores.get(runId);
        if (!snapshot?.conversationId || !store || snapshot.transcriptLoaded === false) {
            return;
        }
        this.lastPersistAt.set(runId, Date.now());

        // 修改原因：流式期间每次 transcript 写入都排一次完整的「读元数据 → 改 → 写回」，队列会被同一个 run 的连续写入撑满。
        // 修改方式：已排队但尚未开始执行的写入会读取写入时刻的最新 snapshot 状态，因此期间的重复请求直接合并掉。
        // 修改目的：持久化次数与实际写入时机相关，而不是与 transcript 变更次数线性相关。
        if (this.pendingPersists.has(runId)) {
            return;
        }
        this.pendingPersists.add(runId);

                // 修改原因：持久化队列原按 runId 串行，但「读整份 metadata → 改一条 → 写回整份」的读改写
                //          作用于 conversation 级文档；同一会话并行运行的多个 run 并发读改写时，后写者会
                //          覆盖先写者写入的对方 run 记录，导致 transcript 丢失。
                // 修改方式：队列改为按 conversationId 串行——同一会话的落盘排队执行，后一个写入总是基于
                //          前一个写入完成后的盘面重新读取合并；pendingPersists 仍按 runId 合并同一 run 的
                //          连续请求，不同会话之间互不阻塞。
                // 修改目的：同一会话两个 run 并发 flush 不再互相覆盖，同时保持原有节流与合并时序。
                // PERF：记录构造与「读整份 subAgentRuns map → 插入 → 写回」合并为单次原子
                // updateCustomMetadata（链内读改写），不再先 getCustomMetadata 全量读盘再写链内重读。
                const conversationId = snapshot.conversationId;
                const previous = this.persistQueues.get(conversationId) || Promise.resolve();
                const next = previous
                    .catch(() => undefined)
                    .then(async () => {
                        // 进入真正写入前清除脏标记：写入期间发生的新变更会重新排队一次后续写入
                        this.pendingPersists.delete(runId);
                        const terminal = TERMINAL_RUN_STATUSES.has(snapshot.status);
                        const transcriptData: SubAgentTranscriptData = {
                            contents: snapshot.contents,
                            ...(Array.isArray(snapshot.lastSentHistory)
                                ? (terminal
                                    ? { lastSentHistoryProjection: buildLastSentHistoryProjection(snapshot.contents, snapshot.lastSentHistory) }
                                    : { lastSentHistory: snapshot.lastSentHistory })
                                : {})
                        };
                        const transcriptRef = store.saveSubAgentTranscript
                            ? await store.saveSubAgentTranscript(conversationId, runId, transcriptData)
                            : undefined;
                        ensureSnapshotProtocolFields(snapshot);
                        const record: SubAgentRunPersistedRecord = {
                            runId: snapshot.runId,
                            agentName: snapshot.agentName,
                            status: snapshot.status,
                            createdAt: snapshot.createdAt,
                            updatedAt: snapshot.updatedAt,
                            contentCount: snapshot.contents.length,
                            contentRevision: snapshot.contentRevision,
                            eventSequence: snapshot.eventSequence,
                            preview: extractContentPreview(snapshot.contents[snapshot.contents.length - 1]),
                            lastMessageRole: snapshot.contents[snapshot.contents.length - 1]?.role,
                            ...(transcriptRef
                                ? { transcriptRef }
                                : {
                                    contents: snapshot.contents,
                                    ...(Array.isArray(snapshot.lastSentHistory) ? { lastSentHistory: snapshot.lastSentHistory } : {})
                                })
                        };

                        // PERF：记录构造与「读整份 subAgentRuns map → 插入 → 写回」合并为单次原子
                        // updateCustomMetadata（链内读改写），不再先 getCustomMetadata 全量读盘再写链内重读；
                        // store 未实现 updateCustomMetadata（测试/旧适配器）时回退读改写。
                        await (store.updateCustomMetadata
                            ? store.updateCustomMetadata(conversationId, SUBAGENT_RUNS_METADATA_KEY, current => {
                                const persistedMap = normalizePersistedMap(current);
                                persistedMap[runId] = record;
                                return persistedMap;
                            })
                            : (async () => {
                                const raw = await store.getCustomMetadata(conversationId, SUBAGENT_RUNS_METADATA_KEY);
                                const persistedMap = normalizePersistedMap(raw);
                                persistedMap[runId] = record;
                                await store.setCustomMetadata(conversationId, SUBAGENT_RUNS_METADATA_KEY, persistedMap);
                            })());
                        this.persistErrors.delete(runId);
                    })
                    .catch(error => {
                        this.pendingPersists.delete(runId);
                        this.persistErrors.set(runId, error);
                        logger.warn('subagent.persist_failed', {
                            runId,
                            conversationId,
                            error: error instanceof Error ? error.message : String(error),
                        });
                    });

        this.persistQueues.set(conversationId, next);
    }
}

export const subAgentRunEventBus = new SubAgentRunEventBus();
