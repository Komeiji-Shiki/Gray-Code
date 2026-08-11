/**
 * SubAgent 运行时事件总线核心（事件发布/订阅 + run 快照与状态 + transcript 写入口）。
 *
 * 拆分说明：从 runEventBus.ts 迁出（纯移动，逻辑一字未改）。持久化职责（落盘队列/节流/
 * 恢复/淘汰）在 persist.ts 的派生类中实现，核心通过 protected 抽象方法调用。
 */

import type { ITranscriptRepository } from '../../../modules/conversation/TranscriptRepository';
import type { Content } from '../../../modules/conversation/types';
import type { ToolProgressEvent } from '../../types';
import { SubAgentTranscriptRepository } from '../SubAgentTranscriptRepository';
import { deepClone } from '../../../core/deepClone';
import { bumpContentRevision, cloneContentsForWindow, extractContentPreview } from './transcript';
import { ensureSnapshotProtocolFields, isLiveOnlyEvent, stampRunEvent, toManifest } from './protocol';
import {
    DEFAULT_CONTENT_WINDOW_LIMIT,
    MAX_EVENTS_PER_RUN,
    TERMINAL_RUN_STATUSES,
    type SubAgentRunContentWindow,
    type SubAgentRunContentWindowOptions,
    type SubAgentRunConversationStore,
    type SubAgentRunEvent,
    type SubAgentRunListener,
    type SubAgentRunManifest,
    type SubAgentRunSnapshot
} from './types';

export abstract class SubAgentRunEventBusCore {
    private readonly listeners = new Set<SubAgentRunListener>();
    protected readonly snapshots = new Map<string, SubAgentRunSnapshot>();
    protected readonly stores = new Map<string, SubAgentRunConversationStore>();

    /**
     * 请求把 run 落盘（由 persist.ts 派生类实现）：
     * 内容类写入按 PERSIST_THROTTLE_MS 节流合并；run 状态变更（含终态）immediate 立即写入。
     */
    protected abstract enqueuePersist(runId: string, immediate?: boolean): void;

    /** 按容量淘汰内存中最旧的可恢复 run 快照（由 persist.ts 派生类实现，依赖持久化字段判断可淘汰性）。 */
    protected abstract evictSnapshotsIfNeeded(): void;

    getTranscriptRepository(runId: string): ITranscriptRepository {
        // 修改原因：SubAgent 子 transcript 需要与主聊天共享同一仓储抽象，而不暴露事件总线内部的 snapshot/persist 细节。
        // 修改方式：为指定 runId 创建一个绑定当前事件总线的 SubAgentTranscriptRepository。
        // 修改目的：调用方通过统一接口读写子 transcript，同时保留事件总线现有广播与 metadata 持久化语义。
        return new SubAgentTranscriptRepository(this, runId);
    }

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

    appendContent(runId: string, content: Content): SubAgentRunSnapshot | undefined {
        const snapshot = this.snapshots.get(runId);
        if (!snapshot) {
            return undefined;
        }
        ensureSnapshotProtocolFields(snapshot);
        const now = Date.now();
        snapshot.contents.push({
            ...content,
            timestamp: content.timestamp || now,
            index: snapshot.contents.length
        } as Content);
        this.commitContentChange(snapshot, now);
        return snapshot;
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

    private notify(event: SubAgentRunEvent, snapshot: SubAgentRunSnapshot): void {
        for (const listener of this.listeners) {
            listener(event, snapshot);
        }
    }
}
