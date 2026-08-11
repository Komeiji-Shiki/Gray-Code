/**
 * SubAgent 运行时事件总线的持久化职责（落盘队列 / 节流 / 恢复 / 淘汰）。
 *
 * 拆分说明：从 runEventBus.ts 迁出（纯移动，逻辑一字未改）。继承 SubAgentRunEventBusCore：
 * 事件发布/订阅核心、run 快照与状态、transcript 写入口在基类中，本类只负责落盘。
 */

import type { Content } from '../../../modules/conversation/types';
import type { SubAgentTranscriptData } from '../../../modules/conversation/storage';
import { SubAgentRunEventBusCore } from './SubAgentRunEventBusCore';
import { buildLastSentHistoryProjection, extractContentPreview, restoreLastSentHistory } from './transcript';
import { ensureSnapshotProtocolFields } from './protocol';
import {
    MAX_FLUSH_RETRY_ATTEMPTS,
    MAX_RETAINED_SNAPSHOTS,
    PERSIST_THROTTLE_MS,
    SUBAGENT_RUNS_METADATA_KEY,
    TERMINAL_RUN_STATUSES,
    type SubAgentRunConversationStore,
    type SubAgentRunPersistedRecord,
    type SubAgentRunSnapshot
} from './types';

function normalizePersistedMap(raw: unknown): Record<string, SubAgentRunPersistedRecord> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return {};
    }
    return raw as Record<string, SubAgentRunPersistedRecord>;
}

export class SubAgentRunEventBusPersistence extends SubAgentRunEventBusCore {
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

    private markStaleRecordInterrupted(record: SubAgentRunPersistedRecord): boolean {
        if (TERMINAL_RUN_STATUSES.has(record.status)) return false;
        record.status = 'interrupted';
        record.updatedAt = Date.now();
        return true;
    }

    /**
     * 按容量淘汰内存中最旧的可恢复 run 快照。
     *
     * 只淘汰同时满足以下条件的 run：已进入终态、拥有 conversationId 与 store（即已持久化，可再次恢复）。
     * 运行中的 run 和无持久化归属的 run 永不淘汰。
     */
    protected override evictSnapshotsIfNeeded(): void {
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
            // L-tsub 修复：淘汰快照时一并清理该 run 的 persistErrors / transcriptLoadPromises，
            //          避免残留引用（错误记录、未完成/已完成的加载 Promise 条目）长期驻留内存；
            //          在途加载 Promise 仍会正常 settle（其 finally 删除不存在的条目为 no-op）。
            this.lastPersistAt.delete(snapshot.runId);
            this.persistErrors.delete(snapshot.runId);
            this.transcriptLoadPromises.delete(snapshot.runId);
            overflow--;
        }
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
            // 修改原因（M-tsub）：加载是异步的，await 期间续跑/transcript 修改可能已把更新的
            //          内容写入内存快照；直接整体覆盖会把较新的内存内容退回成持久化里的旧版本，
            //          随后 flushPersist 再把这份陈旧数据写回磁盘（数据回退）。
            // 修改方式：加载前后比较 contentRevision/updatedAt，加载期间版本已前进则跳过覆盖
            //          （只置 transcriptLoaded，避免下次重复加载）。
            const revisionBefore = snapshot.contentRevision;
            const updatedAtBefore = snapshot.updatedAt;
            const external = await store.loadSubAgentTranscript(snapshot.conversationId, runId);
            if (snapshot.contentRevision > revisionBefore || snapshot.updatedAt > updatedAtBefore) {
                snapshot.transcriptLoaded = true;
                return snapshot;
            }
            snapshot.contents = Array.isArray(external?.contents) ? external.contents : [];
            const lastSentHistory = external ? restoreLastSentHistory(external) : undefined;
            if (Array.isArray(lastSentHistory)) {
                snapshot.lastSentHistory = JSON.parse(JSON.stringify(lastSentHistory)) as Content[];
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
                    ? { lastSentHistory: JSON.parse(JSON.stringify(legacyLastSentHistory)) as Content[] }
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

    /**
     * 请求把 run 落盘。
     *
     * @param immediate run 状态变更（含终态）跳过节流窗口立即写入；内容类变更按 PERSIST_THROTTLE_MS 合并。
     */
    protected override enqueuePersist(runId: string, immediate = false): void {
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
                const raw = await store.getCustomMetadata(conversationId, SUBAGENT_RUNS_METADATA_KEY);
                const persistedMap = normalizePersistedMap(raw);
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
                persistedMap[runId] = record;

                await store.setCustomMetadata(conversationId, SUBAGENT_RUNS_METADATA_KEY, persistedMap);
                this.persistErrors.delete(runId);
            })
            .catch(error => {
                this.pendingPersists.delete(runId);
                this.persistErrors.set(runId, error);
                console.warn('[SubAgentRunEventBus] Failed to persist SubAgent run:', error);
            });

        this.persistQueues.set(conversationId, next);
    }
}
