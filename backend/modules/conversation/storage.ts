/**
 * GrayCode - 存储适配器接口
 * 
 * 存储格式说明:
 * - 对话历史: 完整的 Gemini Content[] 格式
 * - 文件命名: {conversationId}.json
 * - 元数据: 单独存储在 {conversationId}.meta.json
 * 
 * 这样设计的优势:
 * 1. 历史文件可直接用于 Gemini API
 * 2. 完整保留所有 Gemini 特性(函数调用、思考签名等)
 * 3. 元数据与历史分离,便于管理
 */

import { ConversationHistory, ConversationMetadata, HistorySnapshot, Content } from './types';
import { HistorySegmentCache } from './history/HistorySegmentCache';
import { Logger } from '../../core/logger';

const log = Logger.get('storage');

/**
 * readDirectory 返回的 [name, type] 中 type 的取值（vscode.FileType 枚举值）。
 * 用符号常量代替魔法数字 1/2，避免与其它文件类型混淆。
 */
const FS_ENTRY_TYPE_FILE = 1;
const FS_ENTRY_TYPE_DIRECTORY = 2;

/**
 * 校验会被直接用作文件/目录名的存储 ID。
 *
 * conversationId / snapshotId 会来自 Webview 消息和导入数据，不能在未校验时交给
 * Uri.joinPath。只允许项目当前生成器使用的 ASCII 安全集合，既覆盖 conv_*、UUID、
 * 测试中的 c-*，也从根源拒绝 ..、路径分隔符、盘符与 URI 编码绕过。
 */
export function assertSafeStorageId(value: unknown, label = 'storage id'): asserts value is string {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) {
        throw new Error(`Unsafe ${label}: ${String(value)}`);
    }
}

// 同一会话的分段历史写入必须串行化：writeSegmentedHistory 涉及"删目录→重写段→写 index"，
// 并发写会互相删除对方刚写入的段文件，导致 index 与 segment 不一致、历史错位混合。
// 锁只保证写写互斥，读（load）不参与，读侧已有容错。
const segmentedHistoryWriteQueues = new Map<string, Promise<void>>();

/** 分段历史写任务挂起超时：任务长时间不结束视为挂起，超时后队列继续前进（防 Map 条目永久泄漏） */
const SEGMENTED_WRITE_HANG_TIMEOUT_MS = 60000;
/** 元数据链任务挂起超时（元数据写都是小文件，超时取更短值） */
const METADATA_WRITE_HANG_TIMEOUT_MS = 30000;

/**
 * 给 Promise 加挂起超时：超时后本调用的调用方按失败处理（fail-fast，不无限等待）。
 * 注意：底层任务（如卡死的 fs 调用）可能仍在后台运行——各写队列的链尾必须等待底层任务
 * 真正结束（见各队列实现：tail 基于 underlying 而非 current），否则超时后新写入会与
 * 仍在运行的旧任务并发读写同一批文件，互相覆盖/删除，损坏历史、索引与元数据。
 * 调用方应把「队列链尾」挂在底层任务上，把「超时感知」挂在 withHangTimeout 返回值上。
 * 取舍：真正永久卡死的底层任务会让该会话写队列永久排队（liveness 让位于一致性），
 * 正常路径的写操作远小于该阈值、实际不触发。
 *
 * 导出供 UsageIndexStore 等其它模块复用（R2 1.2：用量索引写队列同样需要挂起超时兜底）。
 */
export function withHangTimeout<T>(promise: Promise<T>, label: string, timeoutMs: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
            log.warn('operationHangTimeout', { label, timeoutMs });
            reject(new Error(`${label} hung for ${timeoutMs}ms`));
        }, timeoutMs);
    });
    return Promise.race([promise, timeout]).finally(() => {
        if (timer !== undefined) clearTimeout(timer);
    });
}

function runSegmentedHistoryWriteSerialized<T>(conversationId: string, task: () => Promise<T>): Promise<T> {
    const previous = segmentedHistoryWriteQueues.get(conversationId) ?? Promise.resolve();
    const start = previous.catch(() => undefined);
    // 队列链尾挂在底层任务（underlying）上：即使任务挂起超时（current 提前 reject），
    // 链也不会前进——超时后的旧任务仍在"删目录→重写段→双 rename"，新任务并发启动会
    // 互相覆盖/删除对方刚写入的段文件与 index，造成历史错位混合。代价是挂起任务期间
    // Map 条目保留（正确性优先于条目回收）。
    const underlying = start.then(() => task());
    // 挂起超时从任务真正启动时开始计时（排队等待时间不计入，慢而健康的写入不被误报）
    const current = start.then(() =>
        withHangTimeout(underlying, `segmentedHistoryWrite(${conversationId})`, SEGMENTED_WRITE_HANG_TIMEOUT_MS)
    );
    const tail = underlying.then(() => undefined, () => undefined);
    segmentedHistoryWriteQueues.set(conversationId, tail);
    void tail.then(() => {
        if (segmentedHistoryWriteQueues.get(conversationId) === tail) {
            segmentedHistoryWriteQueues.delete(conversationId);
        }
    });
    return current;
}

// 同一会话的元数据读改写共享串行链：ConversationManager 的 setCustomMetadata/updateCustomMetadata
// 与各存储适配器 saveHistory 内部的 updatedAt 更新必须落在同一条链上。否则两条独立串行链并发时，
// 后写者基于旧 meta 的整体写回会把先写者的 custom 字段覆盖（如 checkpoints 落盘与 trimState 失效并发
// → 检查点列表或裁剪状态丢失）。
interface MetadataChainEntry {
    tail: Promise<void>;
    /** 链是否已结束（淘汰时跳过仍在运行中的链，避免与新链并发整体写回互相覆盖） */
    done: boolean;
}
const metadataWriteChains = new Map<string, MetadataChainEntry>();
const METADATA_WRITE_MAX_KEYS = 10000; // 防 Map 无界增长（正常链完成即删除，上限只兜底极端泄漏）

/**
 * 将元数据读改写动作串行化到会话级共享链上。
 * 链内保证「读 meta → 改 → 整体写回」原子执行，避免并发整体写回互相覆盖。
 */
export async function withMetadataWriteSerialized<T>(conversationId: string, action: () => Promise<T>): Promise<T> {
    const previous = metadataWriteChains.get(conversationId)?.tail ?? Promise.resolve();
    const start = previous.catch(() => undefined);
    // 与 segmentedHistoryWriteSerialized 同理：链尾挂在底层任务上，挂起超时只让调用方
    // 失败，链不前进——超时后旧任务仍持有"读 meta → 整体写回"的读改写窗口，新任务
    // 并发整体写回会把先写者的 custom 字段覆盖（检查点列表/裁剪状态丢失）。
    // 挂起超时从任务真正启动时开始计时（排队等待时间不计入）。
    const underlying = start.then(() => action());
    const current = start.then(() =>
        withHangTimeout(underlying, `metadataWrite(${conversationId})`, METADATA_WRITE_HANG_TIMEOUT_MS)
    );
    const tail = underlying.then(() => undefined, () => undefined);
    if (metadataWriteChains.size >= METADATA_WRITE_MAX_KEYS) {
        // 容量告警：只淘汰最旧的「已结束」链。运行中的链若被淘汰，会与该会话新链并发
        // 执行「读 meta → 整体写回」，重新引入 custom 字段互相覆盖的问题；挂起中的链
        // 同样不可淘汰（其底层任务仍可能正在写盘，淘汰即放行并发写）。
        for (const key of metadataWriteChains.keys()) {
            if (key === conversationId) continue;
            const entry = metadataWriteChains.get(key);
            if (entry && entry.done) {
                metadataWriteChains.delete(key);
                break;
            }
        }
    }
    const entry: MetadataChainEntry = { tail, done: false };
    metadataWriteChains.set(conversationId, entry);
    void tail.then(() => {
        entry.done = true;
        if (metadataWriteChains.get(conversationId) === entry) {
            metadataWriteChains.delete(conversationId);
        }
    });
    return current;
}

export type StorageReadErrorCode = 'not_found' | 'parse_error' | 'io_error' | 'segment_missing';

export interface StorageReadResult<T> {
    value: T | null;
    errorCode?: StorageReadErrorCode;
    errorMessage?: string;
}

export interface StorageHistoryPage {
    total: number;
    startIndex: number;
    messages: ConversationHistory;
    format: 'paged' | 'legacy';
}

/**
 * 历史索引结构信息（HIS-11）。
 * 元数据完整性检查只需要索引结构（totalMessages/segments），不应解析段消息内容。
 */
export interface HistoryIndexInfo {
    /** 历史是否存在（segmented index 或 legacy 单文件） */
    exists: boolean;
    /** 历史索引是否可读（index 解析成功且段文件齐全；legacy 文件存在且 JSON 可解析） */
    readable: boolean;
    /** segmented 索引的消息总数（仅 segmented 时提供） */
    totalMessages?: number;
    /** segmented 索引的段数（仅 segmented 时提供） */
    segmentCount?: number;
    errorCode?: StorageReadErrorCode;
    errorMessage?: string;
}

export interface ConversationStorageIntegrity {
    historyExists: boolean;
    metadataExists: boolean;
    historyReadable: boolean;
    metadataReadable: boolean;
    historyErrorCode?: StorageReadErrorCode;
    metadataErrorCode?: StorageReadErrorCode;
    historyErrorMessage?: string;
    metadataErrorMessage?: string;
}

export interface ConversationStorageLocation {
    /**
     * 文件管理器应该 reveal 的 URI。
     *
     * 修改原因：历史页按钮需要打开真实存储位置，但不同存储格式可能是 legacy 单文件或 segmented 目录。
     * 修改方式：由存储适配器返回已解析好的 revealUri，而不是让 webview handler 猜路径。
     * 修改目的：路径规则保持单一来源，后续存储格式升级时只改适配器。
     */
    revealUri: any;
    /** 展示给前端或日志的人类可读路径 */
    displayPath: string;
    /** 是否定位到了该 conversation 的具体文件或目录 */
    exists: boolean;
    /** 文件缺失或使用兜底目录时的提示 */
    warning?: string;
}

/**
 * 存储适配器接口
 * 
 * 职责:
 * - ConversationManager 负责内存中的状态管理
 * - StorageAdapter 负责持久化(保存到文件、数据库等)
 */
export interface SubAgentTranscriptData {
    contents: Content[];
    lastSentHistory?: Content[];
    /**
     * 新格式把 provider history 中可由 contents 重建的消息保存为索引，只内嵌无法匹配的消息。
     * 这样大型工具结果/图片不会在 contents 与 lastSentHistory 中重复保存两份。
     */
    lastSentHistoryProjection?: {
        version: 1;
        entries: Array<{ contentIndex: number } | { content: Content }>;
    };
}

export interface IStorageAdapter {
    /**
     * 保存对话历史(Gemini 格式)
     * @param conversationId 对话 ID
     * @param history 对话历史(Gemini Content[])
     */
    saveHistory(conversationId: string, history: ConversationHistory): Promise<void>;
    
    /**
     * 加载对话历史
     * @param conversationId 对话 ID
     * @returns Gemini 格式的历史记录
     */
    loadHistory(conversationId: string): Promise<ConversationHistory | null>;
    loadHistoryWithStatus(conversationId: string): Promise<StorageReadResult<ConversationHistory>>;
    loadHistoryPage(conversationId: string, options?: { beforeIndex?: number; offset?: number; limit?: number }): Promise<StorageReadResult<StorageHistoryPage>>;
    
    /**
     * 删除对话历史
     * @param conversationId 对话 ID
     */
    deleteHistory(conversationId: string): Promise<void>;
    
    /**
     * 列出所有对话 ID
     */
    listConversations(): Promise<string[]>;

    /**
     * 获取 conversations 目录的本地文件系统路径（供用量统计目录监听使用）；
     * 非文件系统存储（内存等）不实现，调用方退化全量扫描。
     */
    getConversationsDirFsPath?(): string | undefined;

    /** 子代理完整 transcript 独立存储，避免 Base64/长历史膨胀 conversation meta.json。 */
    saveSubAgentTranscript?(conversationId: string, runId: string, data: SubAgentTranscriptData): Promise<string>;
    loadSubAgentTranscript?(conversationId: string, runId: string): Promise<SubAgentTranscriptData | null>;
    deleteSubAgentTranscript?(conversationId: string, runId: string): Promise<void>;
    
    /**
     * 保存对话元数据
     * @param metadata 元数据
     */
    saveMetadata(metadata: ConversationMetadata): Promise<void>;
    
    /**
     * 加载对话元数据
     * @param conversationId 对话 ID
     */
    loadMetadata(conversationId: string): Promise<ConversationMetadata | null>;
    loadMetadataWithStatus(conversationId: string): Promise<StorageReadResult<ConversationMetadata>>;
    getConversationIntegrity(conversationId: string): Promise<ConversationStorageIntegrity>;

    /**
     * 元数据损坏降级备份（可选）：把 {id}.meta.json 改名备份为
     * {id}.meta.json.corrupt-{Date.now()}（只保留一份，改名失败不抛错）。
     * ConversationManager.getMetadata 在 parse_error 降级时调用；
     * 未实现的适配器跳过备份直接返回 fallback 元数据。
     */
    backupCorruptMetadata?(conversationId: string): Promise<void>;

    /**
     * 获取对话在本地文件系统中的可定位位置。
     *
     * 修改原因：历史 UI 需要“在文件管理器中显示”对话记录，但 handler 不应该复制存储路径规则。
     * 修改方式：文件系统适配器实现该可选窄接口；非文件系统存储可不实现。
     * 修改目的：保持存储布局的单一来源，并让按钮在 legacy/segmented 两种格式下都可用。
     */
    getConversationStorageLocation?(conversationId: string): Promise<ConversationStorageLocation | null>;

    /**
     * 追加历史（append-only 尾段写入，HIS-01）。
     * 可选：未实现时调用方回退 saveHistory 全量重写。
     * 实现约定：最后段未满 200 条只追加该段，满了新建下一段；
     * 写临时尾段→原子替换→写临时 index→原子替换（index 是提交点）。
     */
    appendHistory?(conversationId: string, contents: ConversationHistory): Promise<void>;

    /**
     * 仅读取历史索引结构（不解析段消息内容，HIS-11）。
     * 可选：未实现时调用方回退 getConversationIntegrity。
     */
    getHistoryIndexInfo?(conversationId: string): Promise<HistoryIndexInfo>;

    /**
     * 仅读取历史索引的消息总数（不 stat 各段文件；updateSummary M3 钳制等轻量场景用，HIS-11）。
     * 可选：未实现时调用方回退 getHistoryIndexInfo（可能逐段 stat）。
     * 返回 null 表示索引不可读 / legacy / 不存在（钳制应跳过）。
     */
    getHistoryTotalMessages?(conversationId: string): Promise<number | null>;
    
    /**
     * 保存快照
     * @param snapshot 快照数据
     */
    saveSnapshot(snapshot: HistorySnapshot): Promise<void>;
    
    /**
     * 加载快照
     * @param snapshotId 快照 ID
     */
    loadSnapshot(snapshotId: string): Promise<HistorySnapshot | null>;
    
    /**
     * 删除快照
     * @param snapshotId 快照 ID
     */
    deleteSnapshot(snapshotId: string): Promise<void>;
    
    /**
     * 列出对话的所有快照
     * @param conversationId 对话 ID
     */
    listSnapshots(conversationId: string): Promise<string[]>;
}

/**
 * 内存存储适配器（用于测试或临时存储）
 */
export class MemoryStorageAdapter implements IStorageAdapter {
    private histories: Map<string, ConversationHistory> = new Map();
    private metadata: Map<string, ConversationMetadata> = new Map();
    private snapshots: Map<string, HistorySnapshot> = new Map();
    private subAgentTranscripts: Map<string, SubAgentTranscriptData> = new Map();

    async saveHistory(conversationId: string, history: ConversationHistory): Promise<void> {
        // 深拷贝以避免引用问题
        this.histories.set(conversationId, JSON.parse(JSON.stringify(history)));
    }

    async loadHistory(conversationId: string): Promise<ConversationHistory | null> {
        const history = this.histories.get(conversationId);
        return history ? JSON.parse(JSON.stringify(history)) : null;
    }

    async loadHistoryWithStatus(conversationId: string): Promise<StorageReadResult<ConversationHistory>> {
        const value = await this.loadHistory(conversationId);
        if (!value) {
            return { value: null, errorCode: 'not_found' };
        }
        return { value };
    }

    async loadHistoryPage(
        conversationId: string,
        options: { beforeIndex?: number; offset?: number; limit?: number } = {}
    ): Promise<StorageReadResult<StorageHistoryPage>> {
        const historyResult = await this.loadHistoryWithStatus(conversationId);
        if (!historyResult.value) {
            return { value: null, errorCode: historyResult.errorCode, errorMessage: historyResult.errorMessage };
        }

        const history = historyResult.value;
        const total = history.length;
        const limit = Math.max(1, Math.min(options.limit ?? 120, 1000));
        let startIndex = 0;
        let endExclusive = total;
        if (typeof options.beforeIndex === 'number' && Number.isFinite(options.beforeIndex)) {
            endExclusive = Math.max(0, Math.min(total, Math.floor(options.beforeIndex)));
            startIndex = Math.max(0, endExclusive - limit);
        } else if (typeof options.offset === 'number' && Number.isFinite(options.offset)) {
            startIndex = Math.max(0, Math.min(total, Math.floor(options.offset)));
            endExclusive = Math.max(startIndex, Math.min(total, startIndex + limit));
        } else { startIndex = Math.max(0, total - limit); }
        return { value: { total, startIndex, messages: JSON.parse(JSON.stringify(history.slice(startIndex, endExclusive))), format: 'legacy' } };
    }

    /** 追加历史（append-only，HIS-01）：内存实现直接 push 后单次深拷贝保存 */
    async appendHistory(conversationId: string, contents: ConversationHistory): Promise<void> {
        const existing = this.histories.get(conversationId) ?? [];
        existing.push(...contents);
        // 单次 structuredClone：避免 concat 新数组 + JSON 往返的双份全量拷贝（O(n²) 追加路径）
        this.histories.set(conversationId, structuredClone(existing));
    }

    /** 索引结构信息（HIS-11）：内存实现只查存在性，不解析消息 */
    async getHistoryIndexInfo(conversationId: string): Promise<HistoryIndexInfo> {
        const exists = this.histories.has(conversationId);
        return { exists, readable: exists };
    }

    async deleteHistory(conversationId: string): Promise<void> {
        this.histories.delete(conversationId);
        this.metadata.delete(conversationId);
        for (const key of this.subAgentTranscripts.keys()) {
            if (key.startsWith(`${conversationId}:`)) this.subAgentTranscripts.delete(key);
        }
    }

    async listConversations(): Promise<string[]> {
        return Array.from(this.histories.keys());
    }

    async saveSubAgentTranscript(conversationId: string, runId: string, data: SubAgentTranscriptData): Promise<string> {
        this.subAgentTranscripts.set(`${conversationId}:${runId}`, JSON.parse(JSON.stringify(data)));
        return `subagents/${encodeURIComponent(runId)}.json`;
    }

    async loadSubAgentTranscript(conversationId: string, runId: string): Promise<SubAgentTranscriptData | null> {
        const data = this.subAgentTranscripts.get(`${conversationId}:${runId}`);
        return data ? JSON.parse(JSON.stringify(data)) : null;
    }

    async deleteSubAgentTranscript(conversationId: string, runId: string): Promise<void> {
        this.subAgentTranscripts.delete(`${conversationId}:${runId}`);
    }

    async saveMetadata(metadata: ConversationMetadata): Promise<void> {
        this.metadata.set(metadata.id, JSON.parse(JSON.stringify(metadata)));
    }

    async loadMetadata(conversationId: string): Promise<ConversationMetadata | null> {
        const meta = this.metadata.get(conversationId);
        return meta ? JSON.parse(JSON.stringify(meta)) : null;
    }

    async loadMetadataWithStatus(conversationId: string): Promise<StorageReadResult<ConversationMetadata>> {
        const value = await this.loadMetadata(conversationId);
        if (!value) {
            return { value: null, errorCode: 'not_found' };
        }
        return { value };
    }

    async getConversationIntegrity(conversationId: string): Promise<ConversationStorageIntegrity> {
        const historyExists = this.histories.has(conversationId);
        const metadataExists = this.metadata.has(conversationId);
        return {
            historyExists,
            metadataExists,
            historyReadable: historyExists,
            metadataReadable: metadataExists,
            historyErrorCode: historyExists ? undefined : 'not_found',
            metadataErrorCode: metadataExists ? undefined : 'not_found',
        };
    }

    async saveSnapshot(snapshot: HistorySnapshot): Promise<void> {
        this.snapshots.set(snapshot.id, JSON.parse(JSON.stringify(snapshot)));
    }

    async loadSnapshot(snapshotId: string): Promise<HistorySnapshot | null> {
        const snapshot = this.snapshots.get(snapshotId);
        return snapshot ? JSON.parse(JSON.stringify(snapshot)) : null;
    }

    async deleteSnapshot(snapshotId: string): Promise<void> {
        this.snapshots.delete(snapshotId);
    }

    async listSnapshots(conversationId: string): Promise<string[]> {
        const snapshots = Array.from(this.snapshots.values());
        return snapshots
            .filter(s => s.conversationId === conversationId)
            .map(s => s.id);
    }

    /**
     * 清空所有数据
     */
    clear(): void {
        this.histories.clear();
        this.metadata.clear();
        this.snapshots.clear();
        this.subAgentTranscripts.clear();
    }
}

/**
 * VS Code ExtensionContext 存储适配器
 * 使用 VS Code 的 globalState 或 workspaceState
 */
export class VSCodeStorageAdapter implements IStorageAdapter {
    constructor(
        private context: any // vscode.ExtensionContext
    ) {}

    async saveHistory(conversationId: string, history: ConversationHistory): Promise<void> {
        const key = `limcode.history.${conversationId}`;
        await this.context.globalState.update(key, history);
        
        // 更新元数据的 updatedAt（必须与 ConversationManager 的元数据读改写共用同一条链，
        // 否则基于旧 meta 的整体写回会互相覆盖 custom 字段）
        await withMetadataWriteSerialized(conversationId, async () => {
            const metaKey = `limcode.meta.${conversationId}`;
            const meta = this.context.globalState.get(metaKey) as ConversationMetadata | undefined;
            if (meta) {
                meta.updatedAt = Date.now();
                await this.context.globalState.update(metaKey, meta);
            }
        });
    }

    async loadHistory(conversationId: string): Promise<ConversationHistory | null> {
        const key = `limcode.history.${conversationId}`;
        return (this.context.globalState.get(key) as ConversationHistory | undefined) || null;
    }

    async loadHistoryWithStatus(conversationId: string): Promise<StorageReadResult<ConversationHistory>> {
        const value = await this.loadHistory(conversationId);
        if (!value) {
            return { value: null, errorCode: 'not_found' };
        }
        return { value };
    }

    async loadHistoryPage(
        conversationId: string,
        options: { beforeIndex?: number; offset?: number; limit?: number } = {}
    ): Promise<StorageReadResult<StorageHistoryPage>> {
        const historyResult = await this.loadHistoryWithStatus(conversationId);
        if (!historyResult.value) {
            return { value: null, errorCode: historyResult.errorCode, errorMessage: historyResult.errorMessage };
        }

        const history = historyResult.value;
        const total = history.length;
        const limit = Math.max(1, Math.min(options.limit ?? 120, 1000));
        let startIndex = 0;
        let endExclusive = total;
        if (typeof options.beforeIndex === 'number' && Number.isFinite(options.beforeIndex)) {
            endExclusive = Math.max(0, Math.min(total, Math.floor(options.beforeIndex)));
            startIndex = Math.max(0, endExclusive - limit);
        } else if (typeof options.offset === 'number' && Number.isFinite(options.offset)) {
            startIndex = Math.max(0, Math.min(total, Math.floor(options.offset)));
            endExclusive = Math.max(startIndex, Math.min(total, startIndex + limit));
        } else { startIndex = Math.max(0, total - limit); }
        return { value: { total, startIndex, messages: JSON.parse(JSON.stringify(history.slice(startIndex, endExclusive))), format: 'legacy' } };
    }

    /** 追加历史（append-only，HIS-01）：globalState 直接追加后整体更新 */
    async appendHistory(conversationId: string, contents: ConversationHistory): Promise<void> {
        const key = `limcode.history.${conversationId}`;
        const existing = (this.context.globalState.get(key) as ConversationHistory | undefined) || [];
        await this.context.globalState.update(key, existing.concat(contents));

        // 与 saveHistory 同链更新 updatedAt（避免覆盖 custom 字段）
        await withMetadataWriteSerialized(conversationId, async () => {
            const metaKey = `limcode.meta.${conversationId}`;
            const meta = this.context.globalState.get(metaKey) as ConversationMetadata | undefined;
            if (meta) {
                meta.updatedAt = Date.now();
                await this.context.globalState.update(metaKey, meta);
            }
        });
    }

    /** 索引结构信息（HIS-11）：globalState 只查存在性 */
    async getHistoryIndexInfo(conversationId: string): Promise<HistoryIndexInfo> {
        const key = `limcode.history.${conversationId}`;
        return { exists: this.context.globalState.get(key) !== undefined, readable: true };
    }

    /** 索引消息总数（HIS-11 轻量路径）：globalState 直接取数组长度，无逐段 stat */
    async getHistoryTotalMessages(conversationId: string): Promise<number | null> {
        const key = `limcode.history.${conversationId}`;
        const history = this.context.globalState.get(key) as ConversationHistory | undefined;
        return history ? history.length : null;
    }

    async deleteHistory(conversationId: string): Promise<void> {
        const historyKey = `limcode.history.${conversationId}`;
        const metaKey = `limcode.meta.${conversationId}`;
        await withMetadataWriteSerialized(conversationId, async () => {
            await this.context.globalState.update(historyKey, undefined);
            await this.context.globalState.update(metaKey, undefined);
            const prefix = `limcode.subagent.${conversationId}.`;
            for (const key of this.context.globalState.keys()) {
                if (key.startsWith(prefix)) await this.context.globalState.update(key, undefined);
            }
        });
    }

    async listConversations(): Promise<string[]> {
        const keys = this.context.globalState.keys();
        return keys
            .filter((k: string) => k.startsWith('limcode.history.'))
            .map((k: string) => k.replace('limcode.history.', ''));
    }

    async saveSubAgentTranscript(conversationId: string, runId: string, data: SubAgentTranscriptData): Promise<string> {
        await this.context.globalState.update(`limcode.subagent.${conversationId}.${runId}`, data);
        return `globalState:${runId}`;
    }

    async loadSubAgentTranscript(conversationId: string, runId: string): Promise<SubAgentTranscriptData | null> {
        return (this.context.globalState.get(`limcode.subagent.${conversationId}.${runId}`) as SubAgentTranscriptData | undefined) ?? null;
    }

    async deleteSubAgentTranscript(conversationId: string, runId: string): Promise<void> {
        await this.context.globalState.update(`limcode.subagent.${conversationId}.${runId}`, undefined);
    }

    async saveMetadata(metadata: ConversationMetadata): Promise<void> {
        const key = `limcode.meta.${metadata.id}`;
        await this.context.globalState.update(key, metadata);
    }

    async loadMetadata(conversationId: string): Promise<ConversationMetadata | null> {
        const key = `limcode.meta.${conversationId}`;
        return (this.context.globalState.get(key) as ConversationMetadata | undefined) || null;
    }

    async loadMetadataWithStatus(conversationId: string): Promise<StorageReadResult<ConversationMetadata>> {
        const value = await this.loadMetadata(conversationId);
        if (!value) {
            return { value: null, errorCode: 'not_found' };
        }
        return { value };
    }

    async getConversationIntegrity(conversationId: string): Promise<ConversationStorageIntegrity> {
        const history = await this.loadHistoryWithStatus(conversationId);
        const metadata = await this.loadMetadataWithStatus(conversationId);
        const historyExists = history.value !== null || history.errorCode !== 'not_found';
        const metadataExists = metadata.value !== null || metadata.errorCode !== 'not_found';
        return {
            historyExists,
            metadataExists,
            historyReadable: history.value !== null,
            metadataReadable: metadata.value !== null,
            historyErrorCode: history.errorCode,
            metadataErrorCode: metadata.errorCode,
            historyErrorMessage: history.errorMessage,
            metadataErrorMessage: metadata.errorMessage,
        };
    }

    async saveSnapshot(snapshot: HistorySnapshot): Promise<void> {
        const key = `limcode.snapshot.${snapshot.id}`;
        await this.context.globalState.update(key, snapshot);
    }

    async loadSnapshot(snapshotId: string): Promise<HistorySnapshot | null> {
        const key = `limcode.snapshot.${snapshotId}`;
        return (this.context.globalState.get(key) as HistorySnapshot | undefined) || null;
    }

    async deleteSnapshot(snapshotId: string): Promise<void> {
        const key = `limcode.snapshot.${snapshotId}`;
        await this.context.globalState.update(key, undefined);
    }

    async listSnapshots(conversationId: string): Promise<string[]> {
        const keys = this.context.globalState.keys();
        const snapshotKeys = keys.filter((k: string) => k.startsWith('limcode.snapshot.'));
        
        const snapshots: string[] = [];
        for (const key of snapshotKeys) {
            const snapshot = this.context.globalState.get(key) as HistorySnapshot | undefined;
            if (snapshot && snapshot.conversationId === conversationId) {
                snapshots.push(snapshot.id);
            }
        }
        return snapshots;
    }
}

interface FileHistorySegmentIndexEntry {
    file: string;
    startIndex: number;
    endIndex: number;
    count: number;
}

interface FileHistoryIndex {
    version: 1;
    segmentSize: number;
    totalMessages: number;
    segments: FileHistorySegmentIndexEntry[];
}

/**
 * 文件系统存储适配器（使用 VS Code workspace.fs API）
 * 
 * 文件结构:
 * - {baseDir}/conversations/{conversationId}.json        # 旧版对话历史(Gemini 格式，向后兼容)
 * - {baseDir}/conversations/{conversationId}.meta.json   # 对话元数据
 * - {baseDir}/conversations/{conversationId}.usage.json  # 用量索引（统计加速，见 UsageIndexStore.ts）
 * - {baseDir}/conversations/{conversationId}/history.index.json
 * - {baseDir}/conversations/{conversationId}/history/*.ndjson
 * - {baseDir}/snapshots/{snapshotId}.json                # 快照
 */
export class FileSystemStorageAdapter implements IStorageAdapter {
    private static readonly HISTORY_SEGMENT_SIZE = 200;

    /** 段读取并发上限（HIS-05）：受限于文件句柄与内存，取适中值 */
    private static readonly SEGMENT_READ_CONCURRENCY = 4;

    /** 读侧重试退避：写提交窗口内可能短暂读到 not_found/io_error/segment_missing，最多重试 2 次（共 3 次尝试） */
    private static readonly READ_RETRY_DELAYS_MS = [50, 120];

    /** 段级 LRU 缓存（HIS-06）：命中跳过读盘；写提交后按会话整体失效 */
    private readonly segmentCache = new HistorySegmentCache();

    constructor(
        private vscode: any, // VS Code API
        private baseDir: string // 存储目录的 URI
    ) {}

    /** 供测试/诊断读取当前缓存段数 */
    getHistorySegmentCacheSize(): number {
        return this.segmentCache.size;
    }

    private getLegacyHistoryPath(conversationId: string): any {
        assertSafeStorageId(conversationId, 'conversation id');
        return this.vscode.Uri.joinPath(
            this.vscode.Uri.parse(this.baseDir),
            'conversations',
            `${conversationId}.json`
        );
    }

    private getConversationDir(conversationId: string): any {
        assertSafeStorageId(conversationId, 'conversation id');
        return this.vscode.Uri.joinPath(
            this.vscode.Uri.parse(this.baseDir),
            'conversations',
            conversationId
        );
    }

    private getHistoryDir(conversationId: string): any {
        return this.vscode.Uri.joinPath(this.getConversationDir(conversationId), 'history');
    }

    private getSubAgentTranscriptPath(conversationId: string, runId: string): any {
        return this.vscode.Uri.joinPath(
            this.getConversationDir(conversationId),
            'subagents',
            `${encodeURIComponent(runId)}.json`
        );
    }

    private getHistoryIndexPath(conversationId: string): any {
        return this.vscode.Uri.joinPath(this.getConversationDir(conversationId), 'history.index.json');
    }

    private getMetadataPath(conversationId: string): any {
        assertSafeStorageId(conversationId, 'conversation id');
        return this.vscode.Uri.joinPath(
            this.vscode.Uri.parse(this.baseDir),
            'conversations',
            `${conversationId}.meta.json`
        );
    }

    private getSnapshotPath(snapshotId: string): any {
        assertSafeStorageId(snapshotId, 'snapshot id');
        return this.vscode.Uri.joinPath(
            this.vscode.Uri.parse(this.baseDir),
            'snapshots',
            `${snapshotId}.json`
        );
    }

    private getConversationsRootDir(): any {
        // 修改原因：reveal 兜底需要打开 conversations 根目录，而不是在 handler 中拼接存储路径。
        // 修改方式：把 root URI 构造留在 FileSystemStorageAdapter 内部复用 baseDir 和 VS Code Uri API。
        // 修改目的：所有 conversation 存储路径规则集中在存储适配器里维护。
        return this.vscode.Uri.joinPath(
            this.vscode.Uri.parse(this.baseDir),
            'conversations'
        );
    }

    getConversationsDirFsPath(): string {
        // 用量统计的目录监听（fs.watch）需要本地文件系统路径；
        // 与 getConversationsRootDir 同源，避免路径规则在 adapter 外重复拼接。
        return this.getConversationsRootDir().fsPath;
    }
    
    private isNotFoundError(error: any): boolean {
        const code = String(error?.code || '');
        if (code === 'FileNotFound' || code === 'EntryNotFound' || code === 'ENOENT') {
            return true;
        }
        const name = String(error?.name || '');
        if (name.includes('EntryNotFound')) {
            return true;
        }
        const message = String(error?.message || '').toLowerCase();
        return (
            message.includes('entrynotfound') ||
            message.includes('enoent') ||
            message.includes('file not found')
        );
    }

    private async exists(uri: any): Promise<boolean> {
        try { await this.vscode.workspace.fs.stat(uri); return true; }
        catch { return false; }
    }

    /**
     * 带 EPERM/EACCES/EBUSY 重试的 rename（与 BranchGraphRepository.renameWithRetry 同风格）：
     * Windows 上 rename 偶发 EPERM（文件锁/杀软竞态），短暂退避重试后仍失败才抛出。
     * 仅重试「可恢复」错误码（EPERM/EACCES/EBUSY，及 vscode FileSystemError 对应的
     * NoPermissions/Unavailable）；其他错误（ENOENT 等）立即抛出。
     */
    private async renameWithRetry(src: any, dest: any, overwrite: boolean, attempts = 4, delayMs = 30): Promise<void> {
        for (let attempt = 1; ; attempt += 1) {
            try {
                await this.vscode.workspace.fs.rename(src, dest, { overwrite });
                return;
            } catch (error: any) {
                const code = String(error?.code ?? '');
                const retryable =
                    code === 'EPERM' || code === 'EACCES' || code === 'EBUSY'
                    || code === 'NoPermissions' || code === 'Unavailable';
                if (!retryable || attempt >= attempts) {
                    throw error;
                }
                await new Promise(resolve => setTimeout(resolve, delayMs * attempt));
            }
        }
    }

    /**
     * 原子覆盖：优先 overwrite rename（无窗口，并发读始终看到完整旧状态或完整新状态）；
     * 平台不支持 overwrite 或瞬态重试耗尽时回退「旧目标改名备份 → rename 到位 → 清理备份」
     * （与 DependencyManager 目录替换同模式）。第二次 rename 失败时把备份恢复回去，避免
     * 「已删旧、新未落位」的不可恢复状态：例如 writeSegmentedHistory 中若在线 history 目录
     * 被删后 rename 再失败，分段历史不可读且 appendHistory 的 H5/M4 自愈只能从目录残留段
     * 文件/legacy 快照重建，二者都已不在时无法重建（只能抛错，不静默丢）。
     * 调用方必须已保证写写串行（runSegmentedHistoryWriteSerialized 或单写者）。
     */
    private async renameOverwrite(src: any, dest: any): Promise<void> {
        try {
            await this.renameWithRetry(src, dest, true);
            return;
        } catch {
            // 平台不支持 overwrite（rename 覆盖目标抛 FileExists 等）或瞬态重试耗尽：
            // 进入「删旧 + rename」回退，但删旧改为「改名备份」，第二次 rename 失败可恢复。
            const destBasename = String(dest?.path ?? '').split('/').filter(Boolean).pop() ?? 'dest';
            const backup = this.vscode.Uri.joinPath(
                dest,
                '..',
                `${destBasename}.rename-backup-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
            );
            let backupMoved = false;
            try {
                await this.renameWithRetry(dest, backup, false);
                backupMoved = true;
            } catch {
                // 旧目标改名备份失败（目标已被并发删除等罕见情况）：退回「删旧目标后重试」
                try {
                    await this.vscode.workspace.fs.delete(dest, { useTrash: false });
                } catch {
                    // ignore（目标不存在）
                }
                await this.renameWithRetry(src, dest, false);
                return;
            }
            if (backupMoved) {
                try {
                    await this.renameWithRetry(src, dest, false);
                } catch (error) {
                    // 第二次 rename 失败：恢复备份，尽量保留旧目标（恢复也失败时抛原错误、
                    // 不静默——旧目标仍在备份路径，可人工恢复，不会「删旧后丢失」）。
                    try {
                        await this.renameWithRetry(backup, dest, false);
                    } catch (restoreError) {
                        log.warn('renameOverwriteRestoreFailed', {
                            backup: backup?.fsPath ?? String(backup),
                            dest: dest?.fsPath ?? String(dest),
                            error: String((restoreError as Error)?.message ?? restoreError)
                        });
                    }
                    throw error;
                }
                // rename 成功：清理备份（recursive 对文件同样有效，目录也覆盖）
                try {
                    await this.vscode.workspace.fs.delete(backup, { recursive: true, useTrash: false });
                } catch {
                    // 备份清理失败忽略（不影响已完成的替换）
                }
            }
        }
    }

    /** 写临时段文件 → 原子替换到线上段路径 */
    private async atomicWriteSegment(tmpUri: any, destUri: any, messages: ConversationHistory): Promise<void> {
        const content = messages.map(item => JSON.stringify(item)).join('\n');
        await this.vscode.workspace.fs.writeFile(tmpUri, Buffer.from(content, 'utf8'));
        await this.renameOverwrite(tmpUri, destUri);
    }

    /** 历史提交后统一维护 updatedAt（与 saveHistory 同链，避免覆盖 custom 字段） */
    private async refreshUpdatedAt(conversationId: string): Promise<void> {
        try {
            await withMetadataWriteSerialized(conversationId, async () => {
                const meta = await this.loadMetadata(conversationId);
                if (meta) {
                    meta.updatedAt = Date.now();
                    await this.saveMetadata(meta);
                }
            });
        } catch {
            // 忽略元数据更新失败
        }
    }

    /**
     * 限流并发执行（HIS-05）：同时最多 concurrency 个任务在途，结果按输入顺序返回。
     */
    private async runBounded<T, R>(
        items: readonly T[],
        concurrency: number,
        task: (item: T) => Promise<R>
    ): Promise<R[]> {
        const results: R[] = new Array(items.length);
        let next = 0;
        const workerCount = Math.max(1, Math.min(concurrency, items.length));
        await Promise.all(Array.from({ length: workerCount }, async () => {
            while (next < items.length) {
                const index = next++;
                results[index] = await task(items[index]);
            }
        }));
        return results;
    }

    /**
     * 缓存 revision：任何历史提交都会改变 totalMessages 或段结构；把段结构（文件/区间/计数）
     * 一并纳入 revision——FAT 2s 粒度下 totalMessages 未变但段被重排/重切时也能失效缓存
     * （同尺寸段内原地编辑的极端边界仍由 readSegmentCached 的 mtime+size 双键兜底）。
     */
    private buildSegmentCacheRevision(index: FileHistoryIndex): string {
        return `${index.totalMessages}:${index.segments.map(s => `${s.file}:${s.startIndex}:${s.count}`).join('|')}`;
    }

    /**
     * 读段（命中缓存跳过读盘，HIS-06）。
     * M5：外部进程直接改段文件不会改变 totalMessages，revision 无法感知；
     * 命中前先 stat 段文件并把 mtime 纳入缓存键，mtime 变化 → 缓存失效重读（成本可控，不解析内容）。
     */
    private async readSegmentCached(
        conversationId: string,
        historyDir: any,
        segment: FileHistorySegmentIndexEntry,
        revision: string
    ): Promise<StorageReadResult<ConversationHistory>> {
        const segmentUri = this.vscode.Uri.joinPath(historyDir, segment.file);
        let mtimeKey = 'missing';
        try {
            const stat = await this.vscode.workspace.fs.stat(segmentUri);
            // mtime + size 双键：文件系统 mtime 精度不足（同毫秒写入/FAT 2 秒粒度）时，
            // size 变化仍能感知，避免缓存读到陈旧内容。
            mtimeKey = `${stat.mtime ?? 0}:${stat.size ?? 0}`;
        } catch {
            // 文件缺失/stat 失败：不命中缓存（由 readHistorySegment 返回 not_found/io_error）
        }
        const cacheKey = `${revision}::m${mtimeKey}`;
        const cached = this.segmentCache.get(conversationId, segment.file, cacheKey);
        if (cached) {
            return { value: cached };
        }
        const result = await this.readHistorySegment(segmentUri);
        if (result.value) {
            this.segmentCache.set(conversationId, segment.file, cacheKey, result.value);
        }
        return result;
    }

    async getConversationStorageLocation(conversationId: string): Promise<ConversationStorageLocation> {
        // 修改原因：历史页“在文件管理器中显示”需要优先定位真实存在的对话存储文件。
        // 修改方式：按当前存储格式优先级选择 segmented history.index.json，其次 legacy history，再其次 metadata；全部缺失时回退到 conversations 根目录。
        // 修改目的：支持新旧存储格式，同时在文件缺失时给用户明确反馈而不是静默无效。
        const historyIndexUri = this.getHistoryIndexPath(conversationId);
        const legacyHistoryUri = this.getLegacyHistoryPath(conversationId);
        const metadataUri = this.getMetadataPath(conversationId);
        const conversationDir = this.getConversationDir(conversationId);
        const conversationsRoot = this.getConversationsRootDir();

        if (await this.exists(historyIndexUri)) {
            return { revealUri: historyIndexUri, displayPath: historyIndexUri.fsPath || historyIndexUri.toString(), exists: true };
        }
        if (await this.exists(legacyHistoryUri)) {
            return { revealUri: legacyHistoryUri, displayPath: legacyHistoryUri.fsPath || legacyHistoryUri.toString(), exists: true };
        }
        if (await this.exists(metadataUri)) {
            return { revealUri: metadataUri, displayPath: metadataUri.fsPath || metadataUri.toString(), exists: true };
        }
        if (await this.exists(conversationDir)) {
            return {
                revealUri: conversationDir,
                displayPath: conversationDir.fsPath || conversationDir.toString(),
                exists: false,
                warning: `Conversation storage files are missing for ${conversationId}; opened the conversation directory instead.`
            };
        }
        return {
            revealUri: conversationsRoot,
            displayPath: conversationsRoot.fsPath || conversationsRoot.toString(),
            exists: false,
            warning: `Conversation storage files are missing for ${conversationId}; opened the conversations directory instead.`
        };
    }

    private async readJsonFile<T>(uri: any): Promise<StorageReadResult<T>> {
        try {
            const content = await this.vscode.workspace.fs.readFile(uri);
            const text = Buffer.from(content).toString('utf8');
            try {
                return { value: JSON.parse(text) as T };
            } catch (parseError: any) {
                return {
                    value: null,
                    errorCode: 'parse_error',
                    errorMessage: parseError?.message || 'Failed to parse JSON',
                };
            }
        } catch (error: any) {
            if (this.isNotFoundError(error)) {
                return {
                    value: null,
                    errorCode: 'not_found',
                    errorMessage: error?.message,
                };
            }
            return {
                value: null,
                errorCode: 'io_error',
                errorMessage: error?.message || String(error),
            };
        }
    }

    /**
     * legacy 历史解析结果校验：ConversationHistory 必须是数组。非数组 JSON（对象/标量，
     * 手工编辑或旧版误写）视为不可读并返回 parse_error，避免读取路径对非数组调用
     * .length/.filter 抛 TypeError（与 getHistoryIndexInfo 误报可读同源的问题）。
     */
    private asHistoryReadResult(result: StorageReadResult<ConversationHistory>): StorageReadResult<ConversationHistory> {
        if (result.value !== null && !Array.isArray(result.value)) {
            return {
                value: null,
                errorCode: 'parse_error',
                errorMessage: 'Legacy history JSON is not an array; refusing to read as conversation history',
            };
        }
        return result;
    }

    private buildPageRange(total: number, options: { beforeIndex?: number; offset?: number; limit?: number }) {
        const limit = Math.max(1, Math.min(options.limit ?? 120, 1000));
        let startIndex = 0;
        let endExclusive = total;

        if (typeof options.beforeIndex === 'number' && Number.isFinite(options.beforeIndex)) {
            endExclusive = Math.max(0, Math.min(total, Math.floor(options.beforeIndex)));
            startIndex = Math.max(0, endExclusive - limit);
        } else if (typeof options.offset === 'number' && Number.isFinite(options.offset)) {
            startIndex = Math.max(0, Math.min(total, Math.floor(options.offset)));
            endExclusive = Math.max(startIndex, Math.min(total, startIndex + limit));
        } else {
            startIndex = Math.max(0, total - limit);
            endExclusive = total;
        }

        return { startIndex, endExclusive };
    }

    private async readHistorySegment(uri: any): Promise<StorageReadResult<ConversationHistory>> {
        try {
            const content = await this.vscode.workspace.fs.readFile(uri);
            const text = Buffer.from(content).toString('utf8');
            if (!text.trim()) {
                return { value: [] };
            }

            const messages: ConversationHistory = [];
            for (const rawLine of text.split(/\r?\n/)) {
                const line = rawLine.trim();
                if (!line) continue;
                try {
                    messages.push(JSON.parse(line) as Content);
                } catch (parseError: any) {
                    return {
                        value: null,
                        errorCode: 'parse_error',
                        errorMessage: parseError?.message || 'Failed to parse history segment',
                    };
                }
            }

            return { value: messages };
        } catch (error: any) {
            if (this.isNotFoundError(error)) {
                return {
                    value: null,
                    errorCode: 'not_found',
                    errorMessage: error?.message,
                };
            }
            return {
                value: null,
                errorCode: 'io_error',
                errorMessage: error?.message || String(error),
            };
        }
    }

    private async readHistoryIndex(conversationId: string): Promise<StorageReadResult<FileHistoryIndex>> {
        return await this.readJsonFile<FileHistoryIndex>(this.getHistoryIndexPath(conversationId));
    }

    /**
     * 枚举 history 目录下的段文件（*.ndjson），按文件名升序返回。
     * 目录不存在/不可读时返回空数组（调用方按「无段文件」处理，H5）。
     */
    private async enumerateHistorySegmentFiles(historyDir: any): Promise<string[]> {
        try {
            const entries = await this.vscode.workspace.fs.readDirectory(historyDir);
            return entries
                .filter(([name, type]) => type === FS_ENTRY_TYPE_FILE && /^\d{6}\.ndjson$/.test(name))
                .map(([name]) => name)
                .sort();
        } catch {
            return [];
        }
    }

    /**
     * H5：index 不可读（parse_error/io_error）或缺失但目录残留段文件时的自愈恢复。
     *
     * 与 M4 尾段自愈同口径，返回可重建的 existing 历史（不含待追加的 pending）：
     * - 目录中存在段文件且全部可读：按文件名顺序合并全部段内容；
     * - 部分段可读、部分不可读：抛错（跳过会静默丢消息，与 M4「任一段不可读抛错」一致）；
     * - 全部段不可读 / 目录无段文件：回退 legacy 快照（legacy 在分段完成后才删除，崩溃窗口内
     *   它是旧快照）；legacy 也不可用时：
     *   - not_found 且目录无段文件：全新对话 → 空历史（旧语义，保证 createConversation 后首次 append）；
     *   - 其它（parse_error/io_error，或有段文件但全部不可读）：抛错，不静默写空历史覆盖。
     *
     * 注意 at-most-once（H1）：正常路径按 index.count 截断尾段残留；此处 index 不可读，
     * 无法恢复已提交计数，只能按段文件实际内容全量读取——崩溃残留的未提交行会随全量重写
     * 一并提交（在「丢历史」与「可能多收一条未提交消息」之间选择前者，宁可多不可少）。
     */
    private async recoverHistoryForAppend(
        conversationId: string,
        historyDir: any,
        indexResult: StorageReadResult<FileHistoryIndex>
    ): Promise<ConversationHistory> {
        const files = await this.enumerateHistorySegmentFiles(historyDir);
        if (files.length === 0) {
            // 目录没有段文件：回退 legacy（与旧 not_found 语义一致，区别见抛错分支）
            const legacyResult = this.asHistoryReadResult(
                await this.readJsonFile<ConversationHistory>(this.getLegacyHistoryPath(conversationId))
            );
            if (legacyResult.value !== null) {
                return legacyResult.value;
            }
            if (indexResult.errorCode === 'not_found') {
                // not_found 且目录无段文件、无 legacy：全新对话 → 空历史
                return [];
            }
            throw new Error(
                `appendHistory: cannot self-heal, index unreadable and no readable history for `
                + `${conversationId} (${indexResult.errorCode ?? 'unknown'}: `
                + `${indexResult.errorMessage ?? 'no segments and no legacy history'})`
            );
        }

        let readableSegmentCount = 0;
        const readable: ConversationHistory = [];
        const unreadableSegments: string[] = [];
        for (const file of files) {
            const segResult = await this.readHistorySegment(this.vscode.Uri.joinPath(historyDir, file));
            if (!segResult.value) {
                unreadableSegments.push(file);
                continue;
            }
            readableSegmentCount += 1;
            readable.push(...segResult.value);
        }
        if (readableSegmentCount > 0 && unreadableSegments.length > 0) {
            // 部分段可读、部分不可读：无法安全重建（跳过会静默丢消息），抛错
            throw new Error(
                `appendHistory: cannot self-heal, unreadable history segment(s) `
                + `${unreadableSegments.join(', ')} for ${conversationId}`
            );
        }
        if (readableSegmentCount === 0) {
            // 全部段不可读：回退 legacy；legacy 也没有 → 抛错（不静默丢）
            const legacyResult = this.asHistoryReadResult(
                await this.readJsonFile<ConversationHistory>(this.getLegacyHistoryPath(conversationId))
            );
            if (legacyResult.value !== null) {
                return legacyResult.value;
            }
            throw new Error(
                `appendHistory: cannot self-heal, all history segments unreadable and no legacy `
                + `history for ${conversationId} (${indexResult.errorCode ?? 'unknown'}: `
                + `${indexResult.errorMessage ?? 'unreadable segments and no legacy history'})`
            );
        }
        return readable;
    }

    private async writeSegmentedHistory(conversationId: string, history: ConversationHistory): Promise<void> {
        const conversationDir = this.getConversationDir(conversationId);
        const historyDir = this.getHistoryDir(conversationId);
        const historyIndexPath = this.getHistoryIndexPath(conversationId);
        // 注意：tmp 路径必须是 Uri 对象，不能把 Uri 对象与字符串拼接（`uri + '.tmp'` 会隐式调用 toString()
        // 得到字符串），字符串传给 workspace.fs 时会被当作 UriComponents 重新解析，scheme 变成整串非法字符，
        // 抛 [UriError]: Scheme contains illegal characters，导致新建对话/保存历史失败。
        const tmpDir = this.vscode.Uri.joinPath(conversationDir, 'history.tmp');
        const tmpIndexPath = this.vscode.Uri.joinPath(conversationDir, 'history.index.json.tmp');

        await this.vscode.workspace.fs.createDirectory(conversationDir);

        // 0. 写前清理崩溃残留：临时目录与临时 index 都要清。
        //    段数变少时，残留的旧段文件会随 rename 进入线上目录成为孤儿文件（磁盘泄漏）。
        try {
            await this.vscode.workspace.fs.delete(tmpDir, { recursive: true, useTrash: false });
        } catch {
            // 不存在或清理失败，忽略
        }
        try {
            await this.vscode.workspace.fs.delete(tmpIndexPath, { useTrash: false });
        } catch {
            // 不存在或清理失败，忽略
        }

        // 1. 先写临时目录，不触碰线上目录：中途崩溃时线上仍是完整的旧状态，
        //    不会出现 index 缺失且 legacy 已被删的历史不可读场景。
        await this.vscode.workspace.fs.createDirectory(tmpDir);

        const segments: FileHistorySegmentIndexEntry[] = [];
        for (let startIndex = 0; startIndex < history.length; startIndex += FileSystemStorageAdapter.HISTORY_SEGMENT_SIZE) {
            const endExclusive = Math.min(history.length, startIndex + FileSystemStorageAdapter.HISTORY_SEGMENT_SIZE);
            const chunk = history.slice(startIndex, endExclusive);
            const file = `${String(segments.length).padStart(6, '0')}.ndjson`;
            const uri = this.vscode.Uri.joinPath(tmpDir, file);
            const content = chunk.map(item => JSON.stringify(item)).join('\n');
            await this.vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
            segments.push({ file, startIndex, endIndex: endExclusive - 1, count: chunk.length });
        }

        const index: FileHistoryIndex = {
            version: 1,
            segmentSize: FileSystemStorageAdapter.HISTORY_SEGMENT_SIZE,
            totalMessages: history.length,
            segments,
        };

        await this.vscode.workspace.fs.writeFile(tmpIndexPath, Buffer.from(JSON.stringify(index, null, 2), 'utf8'));

        // 2. 原子切换：优先 overwrite rename（无窗口，并发读始终看到完整旧状态或完整新状态）；
        //    平台不支持 overwrite 或瞬态 EPERM 重试耗尽时，renameOverwrite 内部回退
        //    「旧目标改名备份 → rename 到位 → 清理备份」，第二次 rename 失败时恢复备份，
        //    不会留下「在线 history 目录已删、新目录未落位」的不可恢复状态（H5/M4 自愈依赖
        //    目录残留段文件或 legacy 快照，两者都被清掉时无法重建，只能抛错不静默丢）。
        await this.renameOverwrite(tmpDir, historyDir);
        await this.renameOverwrite(tmpIndexPath, historyIndexPath);

        // 3. 删除遗留的 legacy 历史文件
        try {
            await this.vscode.workspace.fs.delete(this.getLegacyHistoryPath(conversationId), { useTrash: false });
        } catch {
            // ignore
        }

        // 写后失效（HIS-06）：本次提交后该会话所有缓存段不可信
        this.segmentCache.invalidateConversation(conversationId);
    }

    /**
     * 追加历史（append-only 尾段写入，HIS-01）。
     *
     * 崩溃一致性：写临时尾段→原子替换→写临时 index→原子替换。
     * index 是有效历史的提交点：段文件先于 index 就位，崩溃时旧 index 不引用新内容
     * （多出的行在 load 时按 index.count 截断，不会进入完整历史）。
     * 再次 append 尾段前同样按 index.count 截断（H1），保证重试 at-most-once。
     */
    async appendHistory(conversationId: string, contents: ConversationHistory): Promise<void> {
        const pending = Array.isArray(contents) ? contents : [];
        if (pending.length === 0) return;

        await runSegmentedHistoryWriteSerialized(conversationId, async () => {
            const indexResult = await this.readHistoryIndex(conversationId);
            const conversationDir = this.getConversationDir(conversationId);
            const historyDir = this.getHistoryDir(conversationId);
            const historyIndexPath = this.getHistoryIndexPath(conversationId);
            // 注意：tmp 路径必须是 Uri 对象（见 writeSegmentedHistory 注释，字符串会触发 UriError）
            const tmpSegmentPath = this.vscode.Uri.joinPath(conversationDir, 'history.append.tmp.ndjson');
            const tmpIndexPath = this.vscode.Uri.joinPath(conversationDir, 'history.index.json.tmp');

            if (!indexResult.value) {
                // H5：index 不可读时不再静默回退 legacy 全量重写。旧行为把 parse_error/io_error
                // 也当成「尚无分段索引」处理：此时 legacy 已在分段完成后删除（读得 null），
                // existing = legacy ?? [] = [] → writeSegmentedHistory([] + pending)，整段分段历史
                // 被覆盖丢失。现在与 M4 尾段自愈同口径：优先从目录枚举段文件读取合并；
                // 任一段不可读抛错（不静默丢）；全部不可读才回退 legacy；都没有才抛错。
                // not_found 且目录无段文件才是「尚无分段索引」的正常形态（legacy 或全新对话），
                // 保留旧回退语义（legacy ?? []）；目录实际残留段文件（index 被外部删除）时同样走自愈。
                const existing = await this.recoverHistoryForAppend(conversationId, historyDir, indexResult);
                await this.writeSegmentedHistory(conversationId, existing.concat(pending));
                await this.refreshUpdatedAt(conversationId);
                return;
            }

            const index = indexResult.value;
            const segments = index.segments.map(segment => ({ ...segment }));
            let totalMessages = index.totalMessages;
            let cursor = 0;

            while (cursor < pending.length) {
                const remainingCount = pending.length - cursor;

                if (segments.length === 0) {
                    // 空历史（createConversation 写入过 []）→ 新建 000000.ndjson
                    const take = Math.min(remainingCount, FileSystemStorageAdapter.HISTORY_SEGMENT_SIZE);
                    const chunk = pending.slice(cursor, cursor + take);
                    const file = '000000.ndjson';
                    await this.vscode.workspace.fs.createDirectory(historyDir);
                    await this.atomicWriteSegment(tmpSegmentPath, this.vscode.Uri.joinPath(historyDir, file), chunk);
                    segments.push({ file, startIndex: totalMessages, endIndex: totalMessages + take - 1, count: take });
                    totalMessages += take;
                    cursor += take;
                    continue;
                }

                const last = segments[segments.length - 1];
                const freeSlots = FileSystemStorageAdapter.HISTORY_SEGMENT_SIZE - last.count;
                if (freeSlots > 0) {
                    // 尾段未满：读尾段 → 追加 → 写临时 → 原子替换
                    const take = Math.min(remainingCount, freeSlots);
                    const chunk = pending.slice(cursor, cursor + take);
                    const lastUri = this.vscode.Uri.joinPath(historyDir, last.file);
                    const segmentResult = await this.readHistorySegment(lastUri);
                    if (!segmentResult.value) {
                        // M4：index 存在但尾段缺失/损坏时不再直接抛错，回退“可读段或 legacy 合并全量重写”自愈。
                        // 优先从可读 segments 重建（保留分段之后的追加内容）；只有没有任何 segment 可读时
                        // 才用 legacy 快照（legacy 在分段完成后才删除，崩溃窗口内它是旧快照，会丢分段后的追加）。
                        let existing: ConversationHistory = [];
                        let anySegmentReadable = false;
                        // 中间段不可读时不得静默跳过：跳过会让自愈重写把该段消息悄悄丢弃（静默数据
                        // 丢失）。收集所有失败段并整体报错，由上层按「历史不可读」处理；只有全部
                        // 中间段可读（或根本没有中间段）时才继续自愈重写。
                        const unreadableSegments: string[] = [];
                        for (let i = 0; i < segments.length - 1; i++) {
                            const seg = segments[i];
                            const segResult = await this.readHistorySegment(this.vscode.Uri.joinPath(historyDir, seg.file));
                            if (!segResult.value) {
                                unreadableSegments.push(seg.file);
                                continue;
                            }
                            anySegmentReadable = true;
                            existing.push(...segResult.value.slice(0, seg.count));
                        }
                        if (unreadableSegments.length > 0) {
                            throw new Error(
                                `appendHistory: cannot self-heal, unreadable history segment(s) `
                                + `${unreadableSegments.join(', ')} for ${conversationId}`
                            );
                        }
                        if (!anySegmentReadable) {
                            const legacyResult = this.asHistoryReadResult(
                                await this.readJsonFile<ConversationHistory>(this.getLegacyHistoryPath(conversationId))
                            );
                            if (legacyResult.value && legacyResult.value.length > 0) {
                                existing = legacyResult.value;
                            }
                        }
                        await this.writeSegmentedHistory(conversationId, existing.concat(pending.slice(cursor)));
                        await this.refreshUpdatedAt(conversationId);
                        return;
                    }
                    // H1：以 index.count 为提交点截断尾段残留（上次 append 尾段 rename 成功但 index
                    // 写失败/崩溃时，尾段文件会多出未提交行），再拼接本次新增——at-most-once，
                    // 调用方重试不会重复追加，totalMessages 与 Σcount 保持一致。
                    const updated = segmentResult.value.slice(0, last.count).concat(chunk);
                    await this.atomicWriteSegment(tmpSegmentPath, lastUri, updated);
                    last.count = updated.length;
                    last.endIndex = last.startIndex + updated.length - 1;
                    totalMessages += take;
                    cursor += take;
                    continue;
                }

                // 尾段已满：新建下一段
                const take = Math.min(remainingCount, FileSystemStorageAdapter.HISTORY_SEGMENT_SIZE);
                const chunk = pending.slice(cursor, cursor + take);
                const file = `${String(segments.length).padStart(6, '0')}.ndjson`;
                await this.vscode.workspace.fs.createDirectory(historyDir);
                await this.atomicWriteSegment(tmpSegmentPath, this.vscode.Uri.joinPath(historyDir, file), chunk);
                segments.push({ file, startIndex: totalMessages, endIndex: totalMessages + take - 1, count: take });
                totalMessages += take;
                cursor += take;
            }

            const nextIndex: FileHistoryIndex = {
                version: 1,
                segmentSize: FileSystemStorageAdapter.HISTORY_SEGMENT_SIZE,
                // 提交前重算 totalMessages = Σ segments.count：异常态（index.count 大于段实际行数等）
                // 下以实际写入段为准，避免分页 total 与完整历史长度不一致。
                totalMessages: segments.reduce((sum, segment) => sum + segment.count, 0),
                segments,
            };

            // 提交点：先段后 index（写临时 index → 原子替换）
            await this.vscode.workspace.fs.writeFile(tmpIndexPath, Buffer.from(JSON.stringify(nextIndex, null, 2), 'utf8'));
            await this.renameOverwrite(tmpIndexPath, historyIndexPath);

            // 写后失效（HIS-06）
            this.segmentCache.invalidateConversation(conversationId);

            await this.refreshUpdatedAt(conversationId);
        });
    }

    /**
     * 索引结构信息（HIS-11）：只读 index.json 或 legacy 存在性，不解析段消息内容。
     * M1：
     * - (a) legacy 单文件历史至少做一次 JSON.parse 探测，损坏 JSON 报不可读（旧行为误报 ok）；
     * - (b) segmented 分支对 segments 逐个 stat 存在性（不解析内容），任一缺失报不可读（旧行为误报 ok）。
     */
    async getHistoryIndexInfo(conversationId: string): Promise<HistoryIndexInfo> {
        const indexPath = this.getHistoryIndexPath(conversationId);
        if (await this.exists(indexPath)) {
            const result = await this.readHistoryIndex(conversationId);
            if (!result.value) {
                return {
                    exists: true,
                    readable: false,
                    errorCode: result.errorCode,
                    errorMessage: result.errorMessage,
                };
            }
            // M1(b)：index 完好但段文件缺失 → readable=false（只 stat，保持 HIS-11 只读结构目标）
            const historyDir = this.getHistoryDir(conversationId);
            for (const segment of result.value.segments) {
                if (!(await this.exists(this.vscode.Uri.joinPath(historyDir, segment.file)))) {
                    return {
                        exists: true,
                        readable: false,
                        totalMessages: result.value.totalMessages,
                        segmentCount: result.value.segments.length,
                        errorCode: 'segment_missing',
                        errorMessage: `Missing history segment file ${segment.file} for ${conversationId}`,
                    };
                }
            }
            return {
                exists: true,
                readable: true,
                totalMessages: result.value.totalMessages,
                segmentCount: result.value.segments.length,
            };
        }
        const legacyPath = this.getLegacyHistoryPath(conversationId);
        if (await this.exists(legacyPath)) {
            // M1(a)：legacy 分支至少做一次 JSON.parse 探测，损坏 JSON / 非数组 JSON 报不可读
            const legacyResult = this.asHistoryReadResult(
                await this.readJsonFile<ConversationHistory>(legacyPath)
            );
            return {
                exists: true,
                readable: legacyResult.value !== null,
                errorCode: legacyResult.errorCode,
                errorMessage: legacyResult.errorMessage,
            };
        }
        return { exists: false, readable: false };
    }

    /**
     * 仅读 index JSON 取 totalMessages（updateSummary M3 钳制用，HIS-11 轻量路径）：
     * 1 次读、0 次逐段 stat。索引不可读 / legacy / 不存在返回 null（钳制跳过）。
     */
    async getHistoryTotalMessages(conversationId: string): Promise<number | null> {
        const result = await this.readHistoryIndex(conversationId);
        return result.value ? result.value.totalMessages : null;
    }

    private async loadSegmentedHistory(conversationId: string): Promise<StorageReadResult<ConversationHistory>> {
        const indexResult = await this.readHistoryIndex(conversationId);
        if (!indexResult.value) {
            return { value: null, errorCode: indexResult.errorCode, errorMessage: indexResult.errorMessage };
        }

        const index = indexResult.value;
        // 双 rename 提交窗口 / 损坏 index 校验：writeSegmentedHistory 的目录 rename 与 index rename
        // 是两次独立操作，读侧可能短暂看到“新段文件 + 旧 index”。Σsegments.count !== totalMessages
        // 或段区间不连续时，直接返回 segment_missing（外层重试），而不是静默返回截断/错位历史。
        const consistencyError = this.validateIndexConsistency(index);
        if (consistencyError) {
            return { value: null, errorCode: 'segment_missing', errorMessage: consistencyError };
        }

        const revision = this.buildSegmentCacheRevision(index);
        const historyDir = this.getHistoryDir(conversationId);
        // HIS-05：多段有界并发读取（结果按段顺序返回）
        const results = await this.runBounded(index.segments, FileSystemStorageAdapter.SEGMENT_READ_CONCURRENCY, segment =>
            this.readSegmentCached(conversationId, historyDir, segment, revision)
        );

        const history: ConversationHistory = [];
        for (let i = 0; i < index.segments.length; i++) {
            const segmentResult = results[i];
            if (!segmentResult.value) {
                return { value: null, errorCode: segmentResult.errorCode, errorMessage: segmentResult.errorMessage };
            }
            // 以 index.count 为提交点：崩溃残留（段文件多于 index 计数）不进入完整历史
            // M2：返回前对元素做浅拷贝——缓存元素引用不再泄漏给调用方，
            // 调用方对消息顶层属性的原地赋值（如 tokenCountByChannel = {...}）不会污染缓存。
            // 嵌套结构（parts 等）仍与缓存共享引用：需要原地修改嵌套内容的调用方必须先深拷贝
            // 目标消息（约定见 manager/query.ts、manager/toolCalls.ts 的「先深拷贝再修改」）。
            history.push(...segmentResult.value.slice(0, index.segments[i].count).map(msg => ({ ...msg })));
        }

        // R2 3.1：双 rename 提交窗口复核——writeSegmentedHistory 先换目录再换 index，
        // 读取期间可能发生“段文件已换新、index 仍是旧版”：validateIndexConsistency 只能
        // 校验 index 自身一致性（旧 index 完全自洽），无法发现段文件已被换掉导致的静默错读。
        // 段读取完成后重读一次 index，比对 totalMessages 与段标识（文件名/区间/计数）；
        // 不一致说明读到的是提交窗口内的混合状态，按可重试错误返回，外层重试后读到一致状态。
        const recheck = await this.verifyIndexUnchanged(conversationId, index);
        if (!recheck.value) {
            return { value: null, errorCode: recheck.errorCode ?? 'segment_missing', errorMessage: recheck.errorMessage };
        }

        return { value: history };
    }

    /**
     * 双 rename 窗口复核：段文件读取完成后重读一次 index，与读取前解析的 index 版本比对。
     * 一致返回最新 index；不一致返回可重试错误（segment_missing）。
     */
    private async verifyIndexUnchanged(conversationId: string, expected: FileHistoryIndex): Promise<StorageReadResult<FileHistoryIndex>> {
        const recheck = await this.readHistoryIndex(conversationId);
        if (!recheck.value) {
            return { value: null, errorCode: recheck.errorCode, errorMessage: recheck.errorMessage };
        }
        if (!this.sameIndexVersion(recheck.value, expected)) {
            return {
                value: null,
                errorCode: 'segment_missing',
                errorMessage: `History index changed during segment read (double-rename commit window) for ${conversationId}; retry`
            };
        }
        return recheck;
    }

    /** 两个 index 版本是否指向同一批段文件（totalMessages + 段标识逐一比对） */
    private sameIndexVersion(a: FileHistoryIndex, b: FileHistoryIndex): boolean {
        if (a.totalMessages !== b.totalMessages) return false;
        if (a.segments.length !== b.segments.length) return false;
        for (let i = 0; i < a.segments.length; i++) {
            const sa = a.segments[i];
            const sb = b.segments[i];
            if (!sa || !sb) return false;
            if (sa.file !== sb.file || sa.startIndex !== sb.startIndex
                || sa.endIndex !== sb.endIndex || sa.count !== sb.count) {
                return false;
            }
        }
        return true;
    }

    /**
     * 校验 index 内部一致性：Σsegments.count === totalMessages 且段区间连续不重叠。
     * 只做内存计算（不读段文件），读路径在索引解析后立即调用；返回错误描述，一致时返回 null。
     */
    private validateIndexConsistency(index: FileHistoryIndex): string | null {
        let sum = 0;
        for (let i = 0; i < index.segments.length; i++) {
            const segment = index.segments[i];
            if (!segment || !Number.isFinite(segment.count) || segment.count < 0
                || !Number.isFinite(segment.startIndex) || !Number.isFinite(segment.endIndex)) {
                return `History index segment ${segment?.file ?? i} has invalid range`;
            }
            if (segment.endIndex !== segment.startIndex + segment.count - 1) {
                return `History index segment ${segment.file} endIndex(${segment.endIndex}) `
                    + `!== startIndex+count-1(${segment.startIndex + segment.count - 1})`;
            }
            if (i > 0) {
                const prev = index.segments[i - 1];
                if (segment.startIndex !== prev.startIndex + prev.count) {
                    return `History index segments not contiguous: ${prev.file} -> ${segment.file}`;
                }
            }
            sum += segment.count;
        }
        if (sum !== index.totalMessages) {
            return `History index inconsistent: Σsegments.count(${sum}) !== totalMessages(${index.totalMessages})`;
        }
        return null;
    }

    private async loadSegmentedHistoryPage(
        conversationId: string,
        options: { beforeIndex?: number; offset?: number; limit?: number } = {}
    ): Promise<StorageReadResult<StorageHistoryPage>> {
        const indexResult = await this.readHistoryIndex(conversationId);
        if (!indexResult.value) {
            return { value: null, errorCode: indexResult.errorCode, errorMessage: indexResult.errorMessage };
        }

        const index = indexResult.value;
        // 与 loadSegmentedHistory 相同的索引一致性校验（仅内存计算，无额外 IO）
        const consistencyError = this.validateIndexConsistency(index);
        if (consistencyError) {
            return { value: null, errorCode: 'segment_missing', errorMessage: consistencyError };
        }
        const { startIndex, endExclusive } = this.buildPageRange(index.totalMessages, options);
        const revision = this.buildSegmentCacheRevision(index);
        const historyDir = this.getHistoryDir(conversationId);

        const relevant: Array<{ segment: FileHistorySegmentIndexEntry; segmentIndex: number }> = [];
        for (let i = 0; i < index.segments.length; i++) {
            const segment = index.segments[i];
            if (segment.endIndex < startIndex || segment.startIndex >= endExclusive) continue;
            relevant.push({ segment, segmentIndex: i });
        }

        // HIS-05：多段有界并发读取
        const results = await this.runBounded(relevant, FileSystemStorageAdapter.SEGMENT_READ_CONCURRENCY, ({ segment }) =>
            this.readSegmentCached(conversationId, historyDir, segment, revision)
        );

        const messages: ConversationHistory = [];
        for (let k = 0; k < relevant.length; k++) {
            const { segment } = relevant[k];
            const segmentResult = results[k];
            if (!segmentResult.value) {
                return { value: null, errorCode: segmentResult.errorCode, errorMessage: segmentResult.errorMessage };
            }

            const localStart = Math.max(0, startIndex - segment.startIndex);
            const localEndExclusive = Math.min(segment.count, endExclusive - segment.startIndex);
            // M2：元素浅拷贝（见 loadSegmentedHistory 注释），避免缓存元素引用泄漏给调用方
            messages.push(...segmentResult.value.slice(localStart, localEndExclusive).map(msg => ({ ...msg })));
        }

        // R2 3.1：双 rename 提交窗口复核（与 loadSegmentedHistory 相同，见 verifyIndexUnchanged）
        const recheck = await this.verifyIndexUnchanged(conversationId, index);
        if (!recheck.value) {
            return { value: null, errorCode: recheck.errorCode ?? 'segment_missing', errorMessage: recheck.errorMessage };
        }

        return {
            value: {
                total: index.totalMessages,
                startIndex,
                messages,
                format: 'paged'
            }
        };
    }

    async migrateLegacyConversationsToSegmented(progressCallback?: (status: { current: number; total: number; conversationId?: string }) => void): Promise<{
        migrated: number;
        skipped: number;
        failed: Array<{ conversationId: string; error: string }>;
    }> {
        const conversationIds = await this.listConversations();
        const failed: Array<{ conversationId: string; error: string }> = [];
        let migrated = 0;
        let skipped = 0;

        const resolvedLegacyIds: string[] = [];
        for (const id of conversationIds) {
            if (await this.exists(this.getLegacyHistoryPath(id))) {
                resolvedLegacyIds.push(id);
            }
        }

        const total = resolvedLegacyIds.length;
        for (let i = 0; i < resolvedLegacyIds.length; i++) {
            const conversationId = resolvedLegacyIds[i];
            progressCallback?.({ current: i + 1, total, conversationId });
            try {
                if (await this.exists(this.getHistoryIndexPath(conversationId))) {
                    await this.vscode.workspace.fs.delete(this.getLegacyHistoryPath(conversationId), { useTrash: false });
                    skipped++;
                    continue;
                }
                const historyResult = this.asHistoryReadResult(
                    await this.readJsonFile<ConversationHistory>(this.getLegacyHistoryPath(conversationId))
                );
                const legacyHistory = historyResult.value;
                if (!legacyHistory) throw new Error(historyResult.errorMessage || historyResult.errorCode || 'Failed to read legacy history');
                // 与 saveHistory 共用同一写队列：迁移与用户消息写入并发时，
                // 两路写共用同一 history.tmp 路径，会互相删除对方刚写的临时目录。
                await runSegmentedHistoryWriteSerialized(conversationId, async () => {
                    await this.writeSegmentedHistory(conversationId, legacyHistory);
                });
                migrated++;
            } catch (error: any) {
                failed.push({ conversationId, error: error?.message || String(error) });
            }
        }

        return { migrated, skipped, failed };
    }


    async saveHistory(conversationId: string, history: ConversationHistory): Promise<void> {
        // 同一会话的写操作串行化：writeSegmentedHistory 先删目录再重写，
        // 并发写会互相删除对方刚写入的段文件（代码多处注释已承认并发写场景）。
        await runSegmentedHistoryWriteSerialized(conversationId, async () => {
            await this.writeSegmentedHistory(conversationId, history);

            // 更新元数据的 updatedAt（必须与 ConversationManager 的元数据读改写共用同一条链，
            // 否则基于旧 meta 的整体写回会互相覆盖 custom 字段）
            try {
                await withMetadataWriteSerialized(conversationId, async () => {
                    const meta = await this.loadMetadata(conversationId);
                    if (meta) {
                        meta.updatedAt = Date.now();
                        await this.saveMetadata(meta);
                    }
                });
            } catch {
                // 忽略元数据更新失败
            }
        });
    }

    async loadHistory(conversationId: string): Promise<ConversationHistory | null> {
        const result = await this.loadHistoryWithStatus(conversationId);
        return result.value;
    }

    private isRetryableReadError(result: StorageReadResult<unknown>): boolean {
        return result.value === null
            && (result.errorCode === 'not_found' || result.errorCode === 'io_error' || result.errorCode === 'segment_missing');
    }

    async loadHistoryWithStatus(conversationId: string): Promise<StorageReadResult<ConversationHistory>> {
        // 写提交（overwrite rename）期间可能短暂读到 not_found/io_error/segment_missing
        // （index 在但段文件尚未就位 / 双 rename 窗口 index 与段错位）：重试最多 2 次带退避，
        // 避免流式迭代中聊天请求被瞬间窗口打断。
        let result = await this.tryLoadHistoryWithStatus(conversationId);
        for (const delay of FileSystemStorageAdapter.READ_RETRY_DELAYS_MS) {
            if (!this.isRetryableReadError(result)) break;
            // R2 3.3：not_found 且 legacy+segmented 双格式都不存在 ⇒ 会话确实不存在（或已删除），
            // 不是写提交窗口，直接返回不重试（避免对已删除/不存在的会话空转 2 次退避重试）。
            if (result.errorCode === 'not_found' && !(await this.historyExistsAnyFormat(conversationId))) {
                break;
            }
            await new Promise(resolve => setTimeout(resolve, delay));
            result = await this.tryLoadHistoryWithStatus(conversationId);
        }
        return result;
    }

    /** 会话是否以任一格式存在（legacy 单文件或 segmented index），用于区分“不存在”与“提交窗口” */
    private async historyExistsAnyFormat(conversationId: string): Promise<boolean> {
        const [index, legacy] = await Promise.all([
            this.exists(this.getHistoryIndexPath(conversationId)),
            this.exists(this.getLegacyHistoryPath(conversationId))
        ]);
        return index || legacy;
    }

    private async tryLoadHistoryWithStatus(conversationId: string): Promise<StorageReadResult<ConversationHistory>> {
        if (await this.exists(this.getHistoryIndexPath(conversationId))) {
            return await this.loadSegmentedHistory(conversationId);
        }

        return this.asHistoryReadResult(
            await this.readJsonFile<ConversationHistory>(this.getLegacyHistoryPath(conversationId))
        );
    }

    async loadHistoryPage(
        conversationId: string,
        options: { beforeIndex?: number; offset?: number; limit?: number } = {}
    ): Promise<StorageReadResult<StorageHistoryPage>> {
        // 与 loadHistoryWithStatus 相同的写提交窗口重试（最多 2 次带退避，共 3 次尝试）
        let result = await this.tryLoadHistoryPage(conversationId, options);
        for (const delay of FileSystemStorageAdapter.READ_RETRY_DELAYS_MS) {
            if (!this.isRetryableReadError(result)) break;
            // R2 3.3：双格式都不存在 ⇒ 会话不存在，不是提交窗口，直接返回不重试
            if (result.errorCode === 'not_found' && !(await this.historyExistsAnyFormat(conversationId))) {
                break;
            }
            await new Promise(resolve => setTimeout(resolve, delay));
            result = await this.tryLoadHistoryPage(conversationId, options);
        }
        return result;
    }

    private async tryLoadHistoryPage(
        conversationId: string,
        options: { beforeIndex?: number; offset?: number; limit?: number } = {}
    ): Promise<StorageReadResult<StorageHistoryPage>> {
        if (await this.exists(this.getHistoryIndexPath(conversationId))) {
            return await this.loadSegmentedHistoryPage(conversationId, options);
        }

        const historyResult = await this.tryLoadHistoryWithStatus(conversationId);
        if (!historyResult.value) {
            return { value: null, errorCode: historyResult.errorCode, errorMessage: historyResult.errorMessage };
        }

        const history = historyResult.value;
        const { startIndex, endExclusive } = this.buildPageRange(history.length, options);
        return {
            value: {
                total: history.length,
                startIndex,
                messages: history.slice(startIndex, endExclusive),
                format: 'legacy'
            }
        };
    }

    async deleteHistory(conversationId: string): Promise<void> {
        // 删除与历史写、元数据整体写回都必须串行。尤其是大 meta 写已读取旧值后，若删除不进入
        // metadata 链，其晚到 rename 会在删除完成后重新创建幽灵 .meta.json。
        await runSegmentedHistoryWriteSerialized(conversationId, async () => {
            await withMetadataWriteSerialized(conversationId, async () => {
                this.segmentCache.invalidateConversation(conversationId);
                const historyUri = this.getLegacyHistoryPath(conversationId);
                const metaUri = this.getMetadataPath(conversationId);
                const conversationDir = this.getConversationDir(conversationId);
                try {
                    await this.vscode.workspace.fs.delete(historyUri, { useTrash: false });
                } catch {
                    // ignore
                }
                try {
                    await this.vscode.workspace.fs.delete(conversationDir, { recursive: true, useTrash: false });
                } catch {
                    // ignore
                }
                try {
                    await this.vscode.workspace.fs.delete(metaUri, { useTrash: false });
                } catch {
                    // ignore
                }
            });
        });
    }

    async listConversations(): Promise<string[]> {
        try {
            const dirUri = this.vscode.Uri.joinPath(
                this.vscode.Uri.parse(this.baseDir),
                'conversations'
            );
            const entries = await this.vscode.workspace.fs.readDirectory(dirUri);
            const ids = new Set<string>();
            for (const [name, type] of entries as Array<[string, number]>) {
                // corrupt-* 是 meta 损坏降级备份文件（{id}.meta.json.corrupt-{ts}），
                // 无论如何都不能被当成对话 ID 列入列表。
                if (name.includes('.corrupt-')) continue;
                // 只识别对话历史文件：{id}.json（legacy）与 {id}/ 目录（segmented）；
                // {id}.meta.json 元数据与 {id}.usage.json 用量索引必须排除，
                // 否则会被当成假对话 ID（如 xxx.usage）显示在历史列表并报 metadata missing。
                if (type === FS_ENTRY_TYPE_FILE && name.endsWith('.json') && !name.endsWith('.meta.json') && !name.endsWith('.usage.json')) {
                    ids.add(name.replace('.json', ''));
                    continue;
                }
                if (type === FS_ENTRY_TYPE_DIRECTORY) {
                    // 排除假对话目录：旧版 bug 把 {id}.usage.json 误识别为对话 ID {id}.usage，
                    // 用户点入后写入 segmented 历史，磁盘留下 {id}.usage/ 目录；
                    // 目录分支必须同样排除（.usage 后缀不可能是真实对话 ID）。
                    if (name.endsWith('.usage')) continue;
                    ids.add(name);
                }
            }
            return Array.from(ids);
        } catch {
            return [];
        }
    }

    async saveSubAgentTranscript(conversationId: string, runId: string, data: SubAgentTranscriptData): Promise<string> {
        const uri = this.getSubAgentTranscriptPath(conversationId, runId);
        const directory = this.vscode.Uri.joinPath(this.getConversationDir(conversationId), 'subagents');
        const tmpUri = this.vscode.Uri.joinPath(directory, `${encodeURIComponent(runId)}.json.tmp`);
        await this.vscode.workspace.fs.createDirectory(directory);
        try {
            await this.vscode.workspace.fs.writeFile(tmpUri, Buffer.from(JSON.stringify(data), 'utf8'));
            await this.renameOverwrite(tmpUri, uri);
        } catch (error) {
            try { await this.vscode.workspace.fs.delete(tmpUri, { useTrash: false }); } catch { /* ignore */ }
            throw error;
        }
        return `subagents/${encodeURIComponent(runId)}.json`;
    }

    async loadSubAgentTranscript(conversationId: string, runId: string): Promise<SubAgentTranscriptData | null> {
        const result = await this.readJsonFile<SubAgentTranscriptData>(this.getSubAgentTranscriptPath(conversationId, runId));
        return result.value;
    }

    async deleteSubAgentTranscript(conversationId: string, runId: string): Promise<void> {
        try {
            await this.vscode.workspace.fs.delete(this.getSubAgentTranscriptPath(conversationId, runId), { useTrash: false });
        } catch (error) {
            if (!this.isNotFoundError(error)) throw error;
        }
    }

    /**
     * 元数据损坏降级备份：把 {id}.meta.json 改名备份为 {id}.meta.json.corrupt-{Date.now()}。
     *
     * 背景：meta.json 因历史非原子写截断（或外部原因）损坏（parse_error）时，
     * ConversationManager.getMetadata 不再向调用方抛 UNKNOWN_ERROR，而是先把损坏文件
     * 改名备份（保留损坏现场供人工排查），再返回从历史重建的 fallback 元数据。
     *
     * 约定：
     * - 只保留一份备份：改名前列出并删除旧的 {id}.meta.json.corrupt-*（避免无限堆积）；
     * - 改名失败不抛错（不阻塞降级主流程）；
     * - 备份文件不会被自动清理（不参与日常删除），排查后可手动删除。
     */
    async backupCorruptMetadata(conversationId: string): Promise<void> {
        const uri = this.getMetadataPath(conversationId);
        if (!(await this.exists(uri))) {
            return;
        }
        const conversationsDir = this.getConversationsRootDir();
        const prefix = `${conversationId}.meta.json.corrupt-`;
        // 只保留一份：先清理旧备份（列出 conversations 目录，删除匹配 .corrupt-* 前缀的文件）
        try {
            const entries = await this.vscode.workspace.fs.readDirectory(conversationsDir);
            for (const [name] of entries as Array<[string, number]>) {
                if (name.startsWith(prefix)) {
                    try {
                        await this.vscode.workspace.fs.delete(
                            this.vscode.Uri.joinPath(conversationsDir, name),
                            { useTrash: false }
                        );
                    } catch {
                        // 旧备份删除失败忽略（后续 rename 仍可完成）
                    }
                }
            }
        } catch {
            // 目录枚举失败不阻塞（后续 rename 仍可完成）
        }
        try {
            // 注意：tmp/备份路径必须是 Uri 对象（字符串拼接会触发 UriError，见 writeSegmentedHistory 注释）
            await this.renameOverwrite(uri, this.vscode.Uri.joinPath(conversationsDir, `${prefix}${Date.now()}`));
        } catch {
            // 改名失败不阻塞降级（原损坏文件保留，下次 getMetadata 会再次尝试）
        }
    }

    /**
     * 原子保存元数据：先写同目录临时文件 {id}.meta.json.tmp，再 rename 覆盖。
     *
     * 旧实现直接 writeFile 线上文件：写入中途崩溃/断电/被杀进程会留下截断的 meta.json
     * （JSON.parse 报 Unterminated string → parse_error → 调用方报 UNKNOWN_ERROR）。
     * 与 appendHistory/writeSegmentedHistory 的提交模式一致：tmp 写完后 rename 是唯一提交点，
     * 崩溃时线上文件要么是完整旧版要么是完整新版，不会截断。
     * 写入失败时清理 tmp（rename 未发生，原 meta.json 不受影响）。
     */
    async saveMetadata(metadata: ConversationMetadata): Promise<void> {
        const uri = this.getMetadataPath(metadata.id);
        const content = JSON.stringify(metadata, null, 2);
        // 注意：tmp 路径必须是 Uri 对象（字符串拼接会触发 UriError，见 writeSegmentedHistory 注释）
        const tmpUri = this.vscode.Uri.joinPath(
            this.getConversationsRootDir(),
            `${metadata.id}.meta.json.tmp`
        );
        try {
            await this.vscode.workspace.fs.writeFile(tmpUri, Buffer.from(content, 'utf8'));
            await this.renameOverwrite(tmpUri, uri);
        } catch (error) {
            // 写入失败：清理临时文件，不留垃圾；原 meta.json 保持完好（rename 未发生）
            try {
                await this.vscode.workspace.fs.delete(tmpUri, { useTrash: false });
            } catch {
                // 清理失败忽略
            }
            throw error;
        }
    }

    async loadMetadata(conversationId: string): Promise<ConversationMetadata | null> {
        const result = await this.loadMetadataWithStatus(conversationId);
        return result.value;
    }

    async loadMetadataWithStatus(conversationId: string): Promise<StorageReadResult<ConversationMetadata>> {
        const uri = this.getMetadataPath(conversationId);
        return await this.readJsonFile<ConversationMetadata>(uri);
    }

    async getConversationIntegrity(conversationId: string): Promise<ConversationStorageIntegrity> {
        const [history, metadata] = await Promise.all([
            this.loadHistoryWithStatus(conversationId),
            this.loadMetadataWithStatus(conversationId),
        ]);
        const historyExists = history.value !== null || history.errorCode !== 'not_found';
        const metadataExists = metadata.value !== null || metadata.errorCode !== 'not_found';
        return {
            historyExists,
            metadataExists,
            historyReadable: history.value !== null,
            metadataReadable: metadata.value !== null,
            historyErrorCode: history.errorCode,
            metadataErrorCode: metadata.errorCode,
            historyErrorMessage: history.errorMessage,
            metadataErrorMessage: metadata.errorMessage,
        };
    }

    async saveSnapshot(snapshot: HistorySnapshot): Promise<void> {
        const uri = this.getSnapshotPath(snapshot.id);
        const content = JSON.stringify(snapshot, null, 2);
        // 与 saveMetadata 同模式：先写同目录临时文件再 rename 覆盖——快照含全量历史，
        // 直接写线上文件在崩溃/被杀时留下截断的 snapshot JSON，loadSnapshot 读到 parse 异常。
        // 注意：tmp 路径必须是 Uri 对象（字符串拼接会触发 UriError，见 writeSegmentedHistory 注释）
        const snapshotsDir = this.vscode.Uri.joinPath(this.vscode.Uri.parse(this.baseDir), 'snapshots');
        const tmpUri = this.vscode.Uri.joinPath(snapshotsDir, `${snapshot.id}.json.tmp`);
        try {
            await this.vscode.workspace.fs.createDirectory(snapshotsDir);
            await this.vscode.workspace.fs.writeFile(tmpUri, Buffer.from(content, 'utf8'));
            await this.renameOverwrite(tmpUri, uri);
        } catch (error) {
            // 写入失败：清理临时文件，不留垃圾；原快照保持完好（rename 未发生）
            try {
                await this.vscode.workspace.fs.delete(tmpUri, { useTrash: false });
            } catch {
                // 清理失败忽略
            }
            throw error;
        }
    }

    async loadSnapshot(snapshotId: string): Promise<HistorySnapshot | null> {
        let content: Uint8Array;
        try {
            const uri = this.getSnapshotPath(snapshotId);
            content = await this.vscode.workspace.fs.readFile(uri);
        } catch (error) {
            // 文件不存在视为「快照不存在」（返回 null，restoreSnapshot 报 snapshotNotFound）；
            // 真实 IO 错误（EACCES/EIO 等）向上抛——参考 loadMetadataWithStatus 的
            // not_found / io_error 分级，避免真实存储故障被静默当作「快照不存在」。
            if (this.isNotFoundError(error)) {
                return null;
            }
            throw error;
        }
        try {
            return JSON.parse(Buffer.from(content).toString('utf8')) as HistorySnapshot;
        } catch {
            // 损坏快照（JSON 解析失败）：与 loadMetadata 的 parse_error→null 语义一致（保留旧行为）
            return null;
        }
    }

    async deleteSnapshot(snapshotId: string): Promise<void> {
        try {
            const uri = this.getSnapshotPath(snapshotId);
            await this.vscode.workspace.fs.delete(uri);
        } catch {
            // 文件不存在，忽略
        }
    }

    async listSnapshots(conversationId: string): Promise<string[]> {
        try {
            const dirUri = this.vscode.Uri.joinPath(
                this.vscode.Uri.parse(this.baseDir),
                'snapshots'
            );
            const entries = await this.vscode.workspace.fs.readDirectory(dirUri);

            const snapshots: string[] = [];
            for (const [name, type] of entries) {
                if (type === FS_ENTRY_TYPE_FILE && name.endsWith('.json')) {
                    const snapshotId = name.replace('.json', '');
                    if (await this.snapshotBelongsToConversation(dirUri, name, conversationId)) {
                        snapshots.push(snapshotId);
                    }
                }
            }
            return snapshots;
        } catch {
            return [];
        }
    }

    /**
     * 轻量快照归属判定：只解析文件头部的 conversationId 字段，不解析内嵌的完整历史。
     * 旧实现逐文件 loadSnapshot（全量 JSON.parse），快照含全量历史时列表读取是 O(总历史)；
     * conversationId 是 HistorySnapshot 的第 2 个字段、固定出现在 history 数组之前
     * （字段顺序由本模块写入保证），正则匹配头部前 64KB 即可确定性取到。解析失败视为不归属。
     */
    private async snapshotBelongsToConversation(dirUri: any, fileName: string, conversationId: string): Promise<boolean> {
        try {
            const content = await this.vscode.workspace.fs.readFile(this.vscode.Uri.joinPath(dirUri, fileName));
            const head = Buffer.from(content).toString('utf8').slice(0, 64 * 1024);
            const match = /"conversationId"\s*:\s*"([^"]*)"/.exec(head);
            return match !== null && match[1] === conversationId;
        } catch {
            return false;
        }
    }
}

