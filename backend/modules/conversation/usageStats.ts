/**
 * GrayCode - 对话用量统计聚合
 *
 * 从已落盘的对话历史中回溯聚合 token 用量，
 * 数据来源为 model 消息上的 usageMetadata（含向后兼容的旧字段）：
 * - promptTokenCount: 每次请求的输入 token（计费口径，逐次累加）
 * - candidatesTokenCount: 输出 token
 * - thoughtsTokenCount: 思考 token
 *
 * 维度：
 * - 总览（totals）
 * - 按对话（byConversation）
 * - 按模型（byModel，以 modelVersion 近似渠道维度）
 * - 按天（byDay，基于消息 timestamp 的本地日期；缺失时间戳的消息只计入其他维度）
 *
 * 性能：全量扫描历史 JSON 的开销随对话数增长明显，统计页可提供 UsageIndexStore
 * （消息级 token 索引，见 UsageIndexStore.ts）。聚合器对每个对话先查索引新鲜度：
 * - fresh：直接聚合索引消息，完全不读历史文件；
 * - missing/stale：回退读取历史并重建写回索引（一次性成本，之后走索引）。
 *
 * 更进一步，可提供 UsageStatsCache（见 usageCache.ts）：目录监听把变更对话
 * 标记为 dirty，统计只重读 dirty 对话，其余直接复用内存明细，日常统计不再
 * 对每个对话做 stat/读文件，加载耗时降到毫秒级。
 *
 * TREE-08（全部分支计入）：reroll/editBranch 产生的非活跃候选内容只存在于
 * BranchGraph sidecar（branches.json），主历史切换后不再出现在主历史，其 token
 * 消耗原本完全不入统计。本模块统计读取时叠加 sidecar 非活跃候选节点的 token
 * （方案 A：读取时合并、不落盘），以「节点 id 是否已出现在主历史」去重（旧索引
 * 无消息 id 时回退按图活跃路径过滤），避免与主历史双计；合并结果通过
 * ConversationUsage.inactiveBranchTokens / totals.inactiveBranchTokens 细分展示
 * （已包含在 totalTokens 中）。
 */

import type { Content, ConversationMetadata } from './types';
import type { UsageStatsCache } from './usageCache';
import { activePath } from './branch/BranchGraph';
import type { ConversationBranchGraph } from './branch/types';
import { Logger } from '../../core/logger';

const log = Logger.get('usageStats');

/** 单个维度桶的 token 计数 */
export interface UsageBucket {
    /** 输入 token（各次请求 promptTokenCount 之和，已含缓存部分） */
    promptTokens: number;
    /** 输出 token */
    candidatesTokens: number;
    /** 思考 token */
    thoughtsTokens: number;
    /** 缓存写入 token（cacheCreationTokenCount 之和；是 promptTokens 的细分，不重复计入 totalTokens） */
    cacheCreationTokens: number;
    /** 缓存命中 token（cacheReadTokenCount 之和；是 promptTokens 的细分，不重复计入 totalTokens） */
    cacheReadTokens: number;
    /** 合计（prompt + candidates + thoughts） */
    totalTokens: number;
    /** 参与统计的 model 消息数 */
    modelMessages: number;
}

export interface ConversationUsage extends UsageBucket {
    conversationId: string;
    title: string;
    /** 最后更新时间（毫秒） */
    updatedAt: number;
    /**
     * 子代理归集消耗（prompt + candidates + thoughts，仅当该对话存在 subagent 条目时出现）。
     * 已包含在 totalTokens 中，仅作细分展示。
     */
    subagentTokens?: number;
    /**
     * 非活跃分支候选节点的 token 消耗（prompt + candidates + thoughts，TREE-08）。
     * 来自 branches.json sidecar 中不在主历史（活跃路径）的候选内容；
     * 已包含在 totalTokens 中，仅作细分展示。无分支图或无非活跃候选时省略。
     */
    inactiveBranchTokens?: number;
}

export interface ModelUsage extends UsageBucket {
    /** 模型标识（modelVersion），未记录时为 'unknown' */
    modelVersion: string;
}

export interface DailyUsage extends UsageBucket {
    /** 本地日期，格式 YYYY-MM-DD */
    date: string;
}

/** 读取失败被跳过的对话信息（title 尽力读取；meta 读取失败/无标题时回退 conversationId） */
export interface SkippedConversationInfo {
    conversationId: string;
    /** 对话标题（尽力读取，失败时回退 conversationId） */
    title: string;
}

export interface UsageStatsResult {
    totals: UsageBucket & {
        /** 参与统计的对话数 */
        conversations: number;
        /** 读取失败被跳过的对话数 */
        skippedConversations: number;
        /** 读取失败被跳过的对话明细（无跳过时省略） */
        skippedConversationDetails?: SkippedConversationInfo[];
        /** 非活跃分支候选节点 token 消耗合计（TREE-08；已包含在 totals 各计数中，仅作细分展示） */
        inactiveBranchTokens?: number;
    };
    byConversation: ConversationUsage[];
    byModel: ModelUsage[];
    byDay: DailyUsage[];
    /** 统计生成时间（毫秒） */
    generatedAt: number;
}

/** 聚合器对数据源的最小依赖（ConversationManager 结构上满足） */
export interface UsageStatsSource {
    listConversations(): Promise<string[]>;
    getMetadata(conversationId: string): Promise<ConversationMetadata | null | undefined>;
    getMessages(conversationId: string): Promise<Content[]>;
    /** 可选：轻量读取原始消息（不经显示规范化/深拷贝），聚合器优先使用以降低全量扫描开销 */
    getMessagesRaw?(conversationId: string): Promise<Content[]>;
    /** 可选：轻量读取元数据（只读 meta 文件，不加载历史做完整性检查），聚合器优先使用 */
    getMetadataLight?(conversationId: string): Promise<ConversationMetadata | null | undefined>;
    /**
     * 可选：读取对话分支图（TREE-08，内存/测试数据源用）。
     * 无分支图 / 损坏返回 null（统计降级为仅主历史）；文件实现走
     * UsageIndexStore.readBranchGraph，二者都提供时 indexStore 优先。
     */
    getBranchGraph?(conversationId: string): Promise<ConversationBranchGraph | null>;
}

/** 用量索引中的单条消息级 token 记录（extractMessageTokens 提取后的扁平结构） */
export interface UsageIndexMessage {
    /**
     * 消息稳定 id（TREE-08，仅主历史条目在消息带 id 时写入）。
     * 供分支合并去重：统计时以「节点 id 是否已在主历史索引中」判定候选是否与主历史重叠，
     * 避免 reroll/切换后候选 sidecar 与主历史双计。旧索引无 id 时回退按图活跃路径过滤。
     */
    id?: string;
    /** 消息时间戳（毫秒）；缺失/无效时省略，时间筛选激活时不参与统计 */
    timestamp?: number;
    /** 模型标识（trim 后原始值；聚合端缺失时兜底 'unknown'） */
    modelVersion?: string;
    prompt: number;
    candidates: number;
    thoughts: number;
    cacheCreation: number;
    cacheRead: number;
    /**
     * 条目来源（可选）：
     * - main（缺省）：从主会话历史提取的 model 消息；
     * - subagent：子代理消耗 token 的归集条目（不入主历史，由 executor 单独追加）；
     * - branch：分支图非活跃候选节点的 token 条目（TREE-08，不入主历史，统计读取时叠加，
     *   仅存在于内存明细/缓存，不写入 usage.json）。
     *
     * 修改原因：子代理 token 需要归集到发起它的主会话统计页，同时全量重建索引时
     *          必须保留这些不在历史里的条目，避免统计波动；分支候选同理需要计入
     *          对话总消耗且可细分展示。
     */
    source?: UsageIndexMessageSource;
}

/** 单个对话的用量索引（消息级 token 明细，落盘打点维护，统计时直接聚合） */
export interface UsageIndex {
    version: 1;
    conversationId: string;
    /** 索引生成时间（毫秒） */
    updatedAt: number;
    messages: UsageIndexMessage[];
}

/** 用量索引条目来源：main=主会话消息（默认），subagent=子代理归集条目（不入主历史），branch=分支图非活跃候选（不入主历史） */
export type UsageIndexMessageSource = 'main' | 'subagent' | 'branch';

/** 索引新鲜度：fresh=历史未再改动；stale=历史比索引新；missing=索引不存在 */
export type UsageIndexFreshness = 'fresh' | 'stale' | 'missing';

/**
 * 用量索引存取接口
 *
 * 文件实现见 UsageIndexStore.ts；测试使用内存实现。
 * getFreshness 用于在读取前判断索引是否仍与历史一致：
 * 历史文件（legacy {id}.json 或 segmented {id}/history.index.json）mtime 新于索引即 stale。
 */
export interface UsageIndexStore {
    read(conversationId: string): Promise<UsageIndex | null>;
    write(conversationId: string, index: UsageIndex): Promise<void>;
    remove(conversationId: string): Promise<void>;
    getFreshness(conversationId: string): Promise<UsageIndexFreshness>;
    /**
     * 可选：增量维护用量索引（HIS-08）。
     * 普通追加助手消息时只更新对应用量条目；返回 false 表示增量不可用
     * （索引缺失/损坏），调用方回退全量重建。
     */
    appendUsage?(conversationId: string, appended: Content[]): Promise<boolean>;

    /**
     * 可选：追加已提取好的用量索引条目（子代理归集用，不入对话历史）。
     * 与 appendUsage 的区别：输入已是 UsageIndexMessage（通常带 source='subagent'），
     * 不再做 Content 提取；索引缺失/损坏时返回 false，调用方决定回退策略。
     */
    appendUsageMessages?(conversationId: string, messages: UsageIndexMessage[]): Promise<boolean>;

    /**
     * 可选：队列内全量重建（R2 1.1）。
     *
     * 在会话级写队列内执行「读当前盘面索引 → build(previous) → 合并盘面 subagent 条目 →
     * 原子落盘」，返回落盘后的索引。调用方在队列外读历史/读旧索引后构造全量重建再 write，
     * 期间并发到达的 main 条目（appendUsage）或 subagent 条目（appendUsageMessages）会被
     * 重建静默覆盖丢失；本方法把读旧索引移入队列内（build 回调收到队列内最新盘面），
     * 保证并发落盘的条目不丢。文件实现见 FileUsageIndexStore.rebuild。
     */
    rebuild?(conversationId: string, build: (previous: UsageIndex | null) => Promise<UsageIndex> | UsageIndex): Promise<UsageIndex>;

    /**
     * 可选：读取分支图 sidecar（TREE-08）。
     * 统计读取时把非活跃候选节点的 token 消耗合并进对话总用量；
     * 无图 / 损坏返回 null（降级为仅主历史统计，不阻塞统计）。
     * 文件实现见 FileUsageIndexStore.readBranchGraph。
     */
    readBranchGraph?(conversationId: string): Promise<ConversationBranchGraph | null>;
}

/**
 * 聚合选项：时间范围过滤（毫秒时间戳，含端点）
 *
 * 任一边界生效时，仅统计带有有效 timestamp 且落在范围内的消息；
 * 缺失时间戳的消息在筛选激活时不参与任何维度的统计。
 */
export interface UsageStatsOptions {
    startTime?: number;
    endTime?: number;
    /** 可选：消息级用量索引，命中时跳过历史文件读取（见 loadOne） */
    indexStore?: UsageIndexStore;
    /** 可选：内存明细缓存（配合目录监听增量失效），命中时跳过全部文件 IO */
    cache?: UsageStatsCache;
}

/** 单个对话的读取结果 */
interface LoadedConversation {
    metadata?: ConversationMetadata | null;
    messages: Content[];
    /** 索引路径：命中新鲜索引时消息明细已提取到 index（messages 为空数组） */
    index?: UsageIndex | null;
}

/**
 * 对中断/取消流的半截 usageMetadata 做保守估算。
 *
 * usageMetadataPartial 为 true 表示 usageMetadata 只覆盖已收到的 chunk
 * （流被取消/网络中断时截断的半截数据），token 数可能严重偏低；
 * 统计端应回退到估算而非信任 usageMetadata。
 * 估算基于消息文本长度：中文等 CJK 约 1 字符/token，英文约 4 字符/token，
 * 取折中 2.5 字符/token 做粗估。
 */
export function estimatePartialMessageTokens(message: Content): { prompt: number; candidates: number; thoughts: number; cacheCreation: number; cacheRead: number } | null {
    const usage = message.usageMetadata;

    let charCount = 0;
    for (const part of message.parts ?? []) {
        if (typeof part.text === 'string') {
            charCount += part.text.length;
        }
        if (part.redactedThinking) {
            charCount += part.redactedThinking.length;
        }
        // functionCall 的 JSON 参数也是模型输出 token（工具调用密集的取消流不应低估）
        if (part.functionCall) {
            try {
                const argsStr = typeof part.functionCall.args === 'string'
                    ? part.functionCall.args
                    : JSON.stringify(part.functionCall.args ?? '');
                charCount += argsStr.length;
            } catch {
                // 忽略序列化失败
            }
        }
    }
    const estimatedCandidates = Math.max(1, Math.ceil(charCount / 2.5));

    // 取消流可能从未收到任何 usage 事件（OpenAI chat / Gemini 的 usage 只在最后
    // 一个 chunk 送达，取消时通常没有）：此时 usageMetadata 为 undefined，也不能
    // 返回 null——否则整条 model 消息被跳过（连 prompt 都不计），M6 声称修复的
    // "中断/取消流 token 严重少计" 只在 Anthropic 类每 chunk 带 usage 的渠道生效。
    // prompt 侧无法从消息文本估算（输入是全量历史+系统提示词），保守记 0。
    // 旧格式（无拆分字段）的缓存合并值近似全部记为命中：OpenAI/Gemini 语义下
    // cachedContentTokenCount 本就是命中；Anthropic 以命中为主，偏差最小。
    const hasSplitCache = usage?.cacheCreationTokenCount !== undefined || usage?.cacheReadTokenCount !== undefined;
    return {
        prompt: usage?.promptTokenCount ?? 0,
        candidates: Math.max(usage?.candidatesTokenCount ?? 0, estimatedCandidates),
        thoughts: usage?.thoughtsTokenCount ?? 0,
        cacheCreation: usage?.cacheCreationTokenCount ?? 0,
        cacheRead: usage?.cacheReadTokenCount ?? (hasSplitCache ? 0 : usage?.cachedContentTokenCount ?? 0)
    };
}

/**
 * 读取单个对话（失败返回 null，由调用方计入 skipped）
 *
 * 提供 indexStore 时优先走索引：
 * - 索引 fresh（历史未被改动）→ 直接返回索引消息，完全不读历史文件；
 * - 索引缺失/过期/损坏 → 回退读取历史，由调用方负责重建写回索引。
 */
/** 轻量读取元数据：优先 getMetadataLight（只读 meta 文件），缺失时回退 getMetadata */
function readMetadataLight(source: UsageStatsSource, conversationId: string): Promise<ConversationMetadata | null | undefined> {
    return typeof source.getMetadataLight === 'function'
        ? source.getMetadataLight(conversationId)
        : source.getMetadata(conversationId);
}

/** 尽力读取对话标题（统计读取失败后仍尝试提供可定位信息；meta 读取失败/无标题时回退 conversationId） */
async function tryReadConversationTitle(source: UsageStatsSource, conversationId: string): Promise<string> {
    try {
        const metadata = await readMetadataLight(source, conversationId);
        const title = (metadata?.title || '').trim();
        return title || conversationId;
    } catch {
        return conversationId;
    }
}

async function loadOne(source: UsageStatsSource, conversationId: string, indexStore?: UsageIndexStore): Promise<LoadedConversation | null> {
    if (indexStore) {
        try {
            const freshness = await indexStore.getFreshness(conversationId);
            if (freshness === 'fresh') {
                const index = await indexStore.read(conversationId);
                if (index && Array.isArray(index.messages)) {
                    const metadata = await readMetadataLight(source, conversationId);
                    return { metadata, messages: [], index };
                }
            }
        } catch {
            // 索引读失败（含 metadata 失败）：回退历史路径
        }
    }

    try {
        const metadata = await readMetadataLight(source, conversationId);
        const messages = typeof source.getMessagesRaw === 'function'
            ? await source.getMessagesRaw(conversationId)
            : await source.getMessages(conversationId);
        return { metadata, messages };
    } catch {
        return null;
    }
}

/**
 * 历史路径的用量索引重建（R2 1.1 / 2.1）。
 *
 * - store 提供 rebuild 时：在 store 会话级写队列内执行「读最新历史 → 构建 → 合并盘面
 *   subagent 条目 → 原子落盘」。调用方在队列外读到的历史 H0/旧索引可能已过期，期间并发
 *   落盘的 main 条目（appendUsage）或 subagent 条目（appendUsageMessages）不会被重建
 *   覆盖丢失。
 * - store 未提供 rebuild（内存实现等）：保留原有「读旧索引合并 subagent → 写回」兜底。
 *
 * 失败返回 null（本次统计走历史路径，下次仍会再尝试重建）。
 */
async function rebuildIndexForConversation(
    source: UsageStatsSource,
    conversationId: string,
    indexStore: UsageIndexStore,
    loadedMessages: Content[]
): Promise<UsageIndex | null> {
    try {
        if (typeof indexStore.rebuild === 'function') {
            return await indexStore.rebuild(conversationId, async (previous) => {
                // 队列内重读最新历史（与 loadOne 的轻量读取同一偏好：getMessagesRaw 优先），
                // 保证重建基于最新盘面，期间并发落盘的 main 条目不会被覆盖。
                const freshMessages = typeof source.getMessagesRaw === 'function'
                    ? await source.getMessagesRaw(conversationId)
                    : await source.getMessages(conversationId);
                const rebuilt = buildConversationUsageIndex(conversationId, freshMessages);
                // 子代理归集条目不在主历史里：从队列内最新盘面索引合并保留
                if (previous && Array.isArray(previous.messages)) {
                    const subagentEntries = previous.messages.filter(m => m.source === 'subagent');
                    if (subagentEntries.length > 0) {
                        rebuilt.messages.push(...subagentEntries);
                    }
                }
                return rebuilt;
            });
        }
        // 无 rebuild 的 store：读改写兜底（保留既有 subagent 条目）
        const rebuilt = buildConversationUsageIndex(conversationId, loadedMessages);
        const previous = await indexStore.read(conversationId);
        if (previous && Array.isArray(previous.messages)) {
            const subagentEntries = previous.messages.filter(m => m.source === 'subagent');
            if (subagentEntries.length > 0) {
                rebuilt.messages.push(...subagentEntries);
            }
        }
        await indexStore.write(conversationId, rebuilt);
        return rebuilt;
    } catch {
        // 忽略索引读/重建/写失败（本次统计走历史路径，下次重建兜底）
        return null;
    }
}

/**
 * 限流并发执行：同时最多 concurrency 个任务在途。
 * 用量统计需要逐个读取全部对话，串行 IO 在对话多时耗时明显；
 * 并发受限于文件句柄与内存，取一个适中的并发上限。
 */
async function runBounded<T>(items: readonly T[], concurrency: number, task: (item: T) => Promise<void>): Promise<void> {
    let next = 0;
    const workerCount = Math.max(1, Math.min(concurrency, items.length));
    await Promise.all(Array.from({ length: workerCount }, async () => {
        while (next < items.length) {
            const index = next++;
            await task(items[index]);
        }
    }));
}

/** 从消息中提取 token 计数（优先 usageMetadata，向后兼容旧字段） */
export function extractMessageTokens(message: Content): { prompt: number; candidates: number; thoughts: number; cacheCreation: number; cacheRead: number } | null {
    // 中断/取消流的 usageMetadata 只覆盖已收到的 chunk，token 严重偏低：
    // 回退到文本长度估算，避免统计结果与真实消耗偏差过大。
    if (message.usageMetadataPartial) {
        return estimatePartialMessageTokens(message);
    }

    const usage = message.usageMetadata;
    const prompt = usage?.promptTokenCount ?? 0;
    const candidates = usage?.candidatesTokenCount ?? message.candidatesTokenCount ?? 0;
    const thoughts = usage?.thoughtsTokenCount ?? message.thoughtsTokenCount ?? 0;
    // 旧格式（仅合并值 cachedContentTokenCount）无法拆分写入/命中，近似全部记为命中
    const hasSplitCache = usage?.cacheCreationTokenCount !== undefined || usage?.cacheReadTokenCount !== undefined;
    const cacheCreation = usage?.cacheCreationTokenCount ?? 0;
    const cacheRead = usage?.cacheReadTokenCount ?? (hasSplitCache ? 0 : usage?.cachedContentTokenCount ?? 0);

    if (prompt === 0 && candidates === 0 && thoughts === 0) {
        return null;
    }
    return { prompt, candidates, thoughts, cacheCreation, cacheRead };
}

/**
 * 从对话历史构建用量索引（纯函数）。
 *
 * 供两处复用：消息落盘打点（ConversationManager 保存后）与统计侧索引缺失/过期时的重建。
 * 只保留有 token 计数的 model 消息，与统计语义一致；
 * 时间戳无效的消息省略 timestamp（筛选激活时不计入，与统计端一致）。
 */
export function buildConversationUsageIndex(conversationId: string, history: Content[]): UsageIndex {
    const messages: UsageIndexMessage[] = [];
    for (const message of history) {
        if (message.role !== 'model') continue;
        const tokens = extractMessageTokens(message);
        if (!tokens) continue;
        const ts = message.timestamp;
        const entry: UsageIndexMessage = {
            timestamp: (typeof ts === 'number' && Number.isFinite(ts) && ts > 0) ? ts : undefined,
            modelVersion: (message.modelVersion || '').trim(),
            ...tokens
        };
        // TREE-08：主历史条目记录稳定 id，供分支合并去重（旧消息无 id 时省略）
        if (typeof message.id === 'string' && message.id.length > 0) {
            entry.id = message.id;
        }
        messages.push(entry);
    }
    return { version: 1, conversationId, updatedAt: Date.now(), messages };
}

/** 分支图读取器：返回 null 表示无图/损坏（降级为仅主历史统计） */
type BranchGraphReader = (conversationId: string) => Promise<ConversationBranchGraph | null>;

/**
 * 从分支图提取「非活跃候选节点」的 token 记录（TREE-08，读取侧合并）。
 *
 * 口径：
 * - 只计 model 节点（user/system 无 usageMetadata；functionResponse 已并入所属节点 parts）；
 * - 软删除节点（deleted）不计（用户已丢弃该分支）；
 * - 主历史去重（权威）：节点 id 已出现在主历史（historyIds）则跳过——主历史 = 活跃路径，
 *   其 token 已由主历史 / 用量索引统计，sidecar 只补「不在主历史」的候选消耗；
 * - 兜底去重：旧索引无消息 id（historyIds 为空）时，按图活跃路径过滤
 *   （不变量：活跃路径 = 主历史，活跃节点已由主历史统计）；
 * - 图损坏（无根 / 活跃路径解析失败 / 空图）返回 []：降级线性模式，避免误计或双计。
 *
 * 返回条目带 source='branch'，聚合端据此提供 inactiveBranchTokens 细分。
 */
export function extractBranchUsageMessages(
    graph: ConversationBranchGraph,
    historyIds?: ReadonlySet<string>
): UsageIndexMessage[] {
    if (!graph || typeof graph.nodes !== 'object' || graph.nodes === null) {
        return [];
    }
    const nodeCount = Object.keys(graph.nodes).length;
    if (nodeCount === 0 || graph.rootNodeId === null) {
        return [];
    }
    // R8b-L1：仅当需要活跃路径兜底（historyIds 为空）时才解析 activePath。
    // 此前无条件先执行 activePath，损坏图（悬空 activeChildId / 环）即使主历史 id 权威
    // 也放弃整个合并（分支消耗漏计）；id 权威时去重不依赖图活跃路径，跳过解析可把
    // 损坏图影响面收窄到真正需要兜底的场景。
    const useActivePathFallback = historyIds === undefined || historyIds.size === 0;
    let active: Set<string> | null = null;
    if (useActivePathFallback) {
        try {
            active = new Set(activePath(graph));
        } catch {
            return []; // 活跃路径解析失败（环等）：图损坏，不合并（降级线性模式）
        }
    }

    const result: UsageIndexMessage[] = [];
    for (const node of Object.values(graph.nodes)) {
        if (node.deleted) continue;
        if (node.role !== 'model') continue;
        if (historyIds && historyIds.has(node.id)) continue;
        if (useActivePathFallback && active!.has(node.id)) continue;
        const tokens = extractMessageTokens(node as unknown as Content);
        if (!tokens) continue;
        const entry: UsageIndexMessage = {
            timestamp: (typeof node.timestamp === 'number' && Number.isFinite(node.timestamp) && node.timestamp > 0) ? node.timestamp : undefined,
            modelVersion: (node.modelVersion || '').trim(),
            ...tokens,
            source: 'branch',
        };
        if (node.id) {
            entry.id = node.id;
        }
        result.push(entry);
    }
    return result;
}

/**
 * 把分支图非活跃候选节点的 token 消耗合并进加载结果（TREE-08，方案 A：读取时合并，不落盘）。
 *
 * - usage.json 仍只含主历史（写路径语义不变）；分支候选内容每次统计时从 sidecar 新鲜读取，
 *   索引 freshness 只负责主历史部分（reroll/切换都会重写主历史，历史 mtime 变化触发索引重建）；
 * - 合并结果只在内存 / 明细缓存中存在（含 source='branch' 条目），不影响既有重建写回；
 * - 无图 / 损坏 / 读取失败：返回原 loaded，本次按主历史统计（降级线性模式）。
 */
async function mergeBranchUsageIntoLoaded(
    loaded: LoadedConversation,
    conversationId: string,
    reader: BranchGraphReader
): Promise<LoadedConversation> {
    let graph: ConversationBranchGraph | null = null;
    try {
        graph = await reader(conversationId);
    } catch {
        return loaded;
    }
    if (!graph || typeof graph.nodes !== 'object' || graph.nodes === null || Object.keys(graph.nodes).length === 0) {
        return loaded;
    }

    // 主历史已统计消息的 id 集合（权威去重）：索引路径用条目 id，历史路径用消息 id。
    // R8b-M1：同时跟踪 historyIdsComplete——索引/历史中所有 main（model）条目都必须带稳定 id
    // 才视为完整。若存在「部分主历史消息缺 id」的混合态（旧索引/迁移失败），按非空即权威使用
    // 会让缺失 id 的主历史消息对应的图节点被当作候选双计；此处不完整时视同「无 id」，
    // 走 extractBranchUsageMessages 的活跃路径兜底（不变量：主历史 = 活跃路径，活跃节点已由主历史统计）。
    let historyIds = new Set<string>();
    let historyIdsComplete = true;
    if (loaded.index) {
        for (const record of loaded.index.messages) {
            if (record.source === 'subagent' || record.source === 'branch') {
                continue; // 非主历史条目不参与主历史去重
            }
            if (typeof record.id === 'string' && record.id.length > 0) {
                historyIds.add(record.id);
            } else {
                historyIdsComplete = false;
            }
        }
    } else {
        for (const message of loaded.messages) {
            if (message.role !== 'model') continue; // 只有 model 消息会产生用量条目
            if (typeof message.id === 'string' && message.id.length > 0) {
                historyIds.add(message.id);
            } else {
                historyIdsComplete = false;
            }
        }
    }
    if (!historyIdsComplete) {
        // 混合态索引/历史（部分主历史条目缺 id）：id 权威不可用，整体回退活跃路径兜底去重
        log.warn(
            `mergeBranchUsageIntoLoaded(${conversationId}): main-history usage entries have missing stable ids; `
            + `falling back to active-path dedup for branch merge`
        );
        historyIds = new Set();
    }

    const branchMessages = extractBranchUsageMessages(graph, historyIds);
    if (branchMessages.length === 0) {
        return loaded;
    }

    const baseIndex = loaded.index ?? buildConversationUsageIndex(conversationId, loaded.messages);
    return {
        metadata: loaded.metadata,
        messages: [],
        index: {
            version: 1,
            conversationId,
            updatedAt: Date.now(),
            messages: [...baseIndex.messages, ...branchMessages],
        },
    };
}

function createBucket(): UsageBucket {
    return { promptTokens: 0, candidatesTokens: 0, thoughtsTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, totalTokens: 0, modelMessages: 0 };
}

function addToBucket(bucket: UsageBucket, tokens: { prompt: number; candidates: number; thoughts: number; cacheCreation: number; cacheRead: number }): void {
    bucket.promptTokens += tokens.prompt;
    bucket.candidatesTokens += tokens.candidates;
    bucket.thoughtsTokens += tokens.thoughts;
    bucket.cacheCreationTokens += tokens.cacheCreation;
    bucket.cacheReadTokens += tokens.cacheRead;
    bucket.totalTokens += tokens.prompt + tokens.candidates + tokens.thoughts;
    bucket.modelMessages += 1;
}

/** 将毫秒时间戳格式化为本地日期 YYYY-MM-DD */
function toLocalDateKey(timestamp: number): string {
    const d = new Date(timestamp);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

/** 判断消息/索引记录是否通过时间范围筛选（timestamp 缺失或无效时不通过） */
function passesTimeFilter(record: { timestamp?: unknown }, options?: UsageStatsOptions): boolean {
    const hasFilter = typeof options?.startTime === 'number' || typeof options?.endTime === 'number';
    if (!hasFilter) return true;

    const ts = record.timestamp;
    if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) return false;
    if (typeof options?.startTime === 'number' && ts < options.startTime) return false;
    if (typeof options?.endTime === 'number' && ts > options.endTime) return false;
    return true;
}

/**
 * 累加一条消息级 token 记录到各维度桶（索引消息与历史消息共用）。
 * 时间范围筛选在此统一执行：缺时间戳的记录在筛选激活时不参与统计。
 */
function accumulateRecord(
    conversationBucket: UsageBucket,
    totals: UsageBucket,
    modelBuckets: Map<string, UsageBucket>,
    dayBuckets: Map<string, UsageBucket>,
    record: UsageIndexMessage,
    options?: UsageStatsOptions
): void {
    if (!passesTimeFilter(record, options)) return;

    const tokens = {
        prompt: record.prompt,
        candidates: record.candidates,
        thoughts: record.thoughts,
        cacheCreation: record.cacheCreation,
        cacheRead: record.cacheRead
    };
    addToBucket(conversationBucket, tokens);
    addToBucket(totals, tokens);

    // 按模型
    const modelKey = (record.modelVersion || '').trim() || 'unknown';
    let modelBucket = modelBuckets.get(modelKey);
    if (!modelBucket) {
        modelBucket = createBucket();
        modelBuckets.set(modelKey, modelBucket);
    }
    addToBucket(modelBucket, tokens);

    // 按天（缺失时间戳的消息不计入该维度）
    if (typeof record.timestamp === 'number' && Number.isFinite(record.timestamp) && record.timestamp > 0) {
        const dayKey = toLocalDateKey(record.timestamp);
        let dayBucket = dayBuckets.get(dayKey);
        if (!dayBucket) {
            dayBucket = createBucket();
            dayBuckets.set(dayKey, dayBucket);
        }
        addToBucket(dayBucket, tokens);
    }
}

/**
 * 聚合所有对话的 token 用量
 *
 * 单个对话读取失败时跳过并计入 skippedConversations，不影响整体统计。
 * 提供 options.indexStore 时：索引 fresh 的对话直接聚合索引（不读历史文件），
 * 索引缺失/过期/损坏的对话回退读取历史并在统计完成后重建写回索引。
 */
export async function aggregateUsageStats(source: UsageStatsSource, options?: UsageStatsOptions): Promise<UsageStatsResult> {
    const totals = createBucket();
    let skippedConversations = 0;
    const skippedConversationDetails: SkippedConversationInfo[] = [];
    let conversationsWithUsage = 0;
    // 非活跃分支候选消耗合计（TREE-08；source='branch' 条目，已计入 totals 各计数）
    let totalBranchTokens = 0;

    const byConversation: ConversationUsage[] = [];
    const modelBuckets = new Map<string, UsageBucket>();
    const dayBuckets = new Map<string, UsageBucket>();

    let conversationIds: string[] = [];
    let listFailed = false;
    try {
        conversationIds = await source.listConversations();
    } catch {
        // 目录瞬时读取错误：本次按空列表统计（跳过全部对话），但记住失败标志，
        // 末尾不要 prune——否则会把整个内存缓存清空，下次统计全量重读（见 prune 处）。
        conversationIds = [];
        listFailed = true;
    }

    // 并发读取各对话（限流避免一次性打开过多文件），结果按原顺序消费。
    // 提供 indexStore 时优先读轻量用量索引，缺失/过期再回退历史（见 loadOne）；
    // 提供 cache 时 dirty 对话重读并回填缓存，其余直接复用内存明细（零文件 IO）。
    const indexStore = options?.indexStore;
    const cache = options?.cache;
    const dirtyIds = cache ? new Set(cache.takeDirty()) : undefined;

    // TREE-08：分支图读取源（indexStore 优先；无读取源时跳过分支合并，行为与旧版一致）
    const branchGraphReader: BranchGraphReader | undefined =
        indexStore?.readBranchGraph ?? source.getBranchGraph;

    const loadWithCache = async (conversationId: string): Promise<LoadedConversation | null> => {
        if (cache) {
            const cached = cache.get(conversationId);
            if (cached && (!dirtyIds || !dirtyIds.has(conversationId))) {
                // 内存缓存命中：跳过全部文件 IO，直接构造索引视图供主循环累加
                // （缓存明细已含 TREE-08 分支合并条目，命中即含分支消耗）
                return {
                    metadata: { id: conversationId, title: cached.title, updatedAt: cached.updatedAt } as ConversationMetadata,
                    messages: [],
                    index: { version: 1, conversationId, updatedAt: 0, messages: cached.messages }
                };
            }
        }
        let loaded = await loadOne(source, conversationId, indexStore);
        if (loaded && indexStore && !loaded.index && Array.isArray(loaded.messages)) {
            // 索引缺失/过期：队列内重建写回（R2 1.1）。重建回调在 store 写队列内基于最新历史
            // 构造并合并盘面 subagent 条目（调用方队列外读到的 H0/旧索引可能已过期，期间并发
            // 落盘的 main 条目不能被重建覆盖）。重建结果回填 loaded.index，主循环按索引路径
            // 聚合（含 subagent），缓存回填也使用合并后的完整明细（R2 2.1）。
            const rebuilt = await rebuildIndexForConversation(source, conversationId, indexStore, loaded.messages);
            if (rebuilt) {
                loaded.index = rebuilt;
                loaded.messages = [];
            }
        }
        // TREE-08：合并分支图非活跃候选节点消耗（读取时叠加，不写入 usage.json；
        // 无分支图/损坏/读取失败按主历史统计，与旧版行为一致）
        if (loaded && branchGraphReader) {
            loaded = await mergeBranchUsageIntoLoaded(loaded, conversationId, branchGraphReader);
        }
        if (loaded && cache) {
            // 回填缓存：索引路径直接用索引明细（重建路径已是合并 subagent 后的完整明细，
            // 分支合并路径已含 source='branch' 条目），历史路径复用索引构建逻辑提取。
            cache.set(conversationId, {
                title: (loaded.metadata?.title || '').trim(),
                updatedAt: loaded.metadata?.updatedAt ?? 0,
                messages: loaded.index
                    ? loaded.index.messages
                    : buildConversationUsageIndex(conversationId, loaded.messages).messages
            });
        }
        return loaded;
    };

    const loadedMap = new Map<string, LoadedConversation | null>();
    await runBounded(conversationIds, 24, async (conversationId) => {
        loadedMap.set(conversationId, await loadWithCache(conversationId));
    });

    for (const conversationId of conversationIds) {
        const loaded = loadedMap.get(conversationId) ?? null;
        if (loaded === null) {
            skippedConversations++;
            skippedConversationDetails.push({
                conversationId,
                title: await tryReadConversationTitle(source, conversationId)
            });
            continue;
        }

        const conversationBucket = createBucket();
        // 子代理归集消耗（source='subagent' 的条目；与时间筛选保持同一口径）
        let conversationSubagentTokens = 0;
        // 非活跃分支候选消耗（source='branch' 的条目；TREE-08，与时间筛选保持同一口径）
        let conversationBranchTokens = 0;

        if (loaded.index) {
            // 索引路径：token 记录已提取，直接累加
            for (const record of loaded.index.messages) {
                accumulateRecord(conversationBucket, totals, modelBuckets, dayBuckets, record, options);
                if (record.source === 'subagent' && passesTimeFilter(record, options)) {
                    conversationSubagentTokens += record.prompt + record.candidates + record.thoughts;
                }
                if (record.source === 'branch' && passesTimeFilter(record, options)) {
                    conversationBranchTokens += record.prompt + record.candidates + record.thoughts;
                    totalBranchTokens += record.prompt + record.candidates + record.thoughts;
                }
            }
        } else {
            // 历史路径：逐条提取并累加（indexStore 未提供，或索引重建失败时走这里）
            for (const message of loaded.messages) {
                if (message.role !== 'model') continue;
                const tokens = extractMessageTokens(message);
                if (!tokens) continue;
                accumulateRecord(conversationBucket, totals, modelBuckets, dayBuckets, {
                    timestamp: message.timestamp,
                    modelVersion: message.modelVersion,
                    ...tokens
                }, options);
            }
            // 索引重建已移到 loadWithCache（队列内执行，合并盘面 subagent 后回填 loaded.index，
            // 主循环按索引路径聚合）；重建失败时本次按历史路径统计，下次统计仍会再尝试重建。
        }

        if (conversationBucket.modelMessages > 0) {
            conversationsWithUsage++;
            const usage: ConversationUsage = {
                conversationId,
                title: (loaded.metadata?.title || '').trim() || conversationId,
                updatedAt: loaded.metadata?.updatedAt ?? 0,
                ...conversationBucket
            };
            if (conversationSubagentTokens > 0) {
                usage.subagentTokens = conversationSubagentTokens;
            }
            if (conversationBranchTokens > 0) {
                usage.inactiveBranchTokens = conversationBranchTokens;
            }
            byConversation.push(usage);
        }
    }

    // 清理缓存：磁盘上已不存在的对话从内存缓存移除，保持与磁盘一致。
    // listConversations 失败时 conversationIds 为空数组，直接 prune 会清空整个内存缓存：
    // 瞬时错误不应导致整体缓存失效，跳过 prune 等下次列表成功再清理。
    if (cache && !listFailed) {
        cache.prune(new Set(conversationIds));
    }

    // 排序：对话/模型按用量降序，日期按时间降序
    byConversation.sort((a, b) => b.totalTokens - a.totalTokens);

    const byModel: ModelUsage[] = [...modelBuckets.entries()]
        .map(([modelVersion, bucket]) => ({ modelVersion, ...bucket }))
        .sort((a, b) => b.totalTokens - a.totalTokens);

    const byDay: DailyUsage[] = [...dayBuckets.entries()]
        .map(([date, bucket]) => ({ date, ...bucket }))
        .sort((a, b) => (a.date < b.date ? 1 : -1));

    return {
        totals: {
            ...totals,
            conversations: conversationsWithUsage,
            skippedConversations,
            ...(skippedConversationDetails.length > 0 ? { skippedConversationDetails } : {}),
            ...(totalBranchTokens > 0 ? { inactiveBranchTokens: totalBranchTokens } : {})
        },
        byConversation,
        byModel,
        byDay,
        generatedAt: Date.now()
    };
}

