/**
 * SubAgent 运行事件协议辅助（freshness 字段补齐 / 事件盖章 / manifest 派生 / live-only 判定）。
 *
 * 拆分说明：从 runEventBus.ts 迁出（纯移动，逻辑一字未改）。事件协议
 * （subagentMonitor.event / manifest 前端契约）逐字保留。
 */

import type {
    SubAgentRunEvent,
    SubAgentRunManifest,
    SubAgentRunSnapshot
} from './types';
import { extractContentPreview } from './transcript';

export function ensureSnapshotProtocolFields(snapshot: SubAgentRunSnapshot): void {
    // 修改原因：旧 conversation metadata 中没有 contentRevision/eventSequence，新协议读取历史 run 时不能让字段变成 undefined。
    // 修改方式：在所有 snapshot 进入事件总线时统一补齐协议字段，并把非数字值归零。
    // 修改目的：manifest、window、event 的 freshness 判断在新旧数据上使用同一语义。
    snapshot.contentRevision = Number.isFinite(snapshot.contentRevision) ? snapshot.contentRevision : 0;
    snapshot.eventSequence = Number.isFinite(snapshot.eventSequence) ? snapshot.eventSequence : 0;
    snapshot.contextCompactions = Array.isArray(snapshot.contextCompactions) ? snapshot.contextCompactions : [];
}

export function stampRunEvent(snapshot: SubAgentRunSnapshot, event: SubAgentRunEvent): SubAgentRunEvent {
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

export function toManifest(snapshot: SubAgentRunSnapshot): SubAgentRunManifest {
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

export function isLiveOnlyEvent(event: SubAgentRunEvent): boolean {
    // 修改原因：llm_delta 是高频流式热路径，写入 snapshot.events 会让内存事件列表和 Monitor postMessage 随输出长度 O(n²) 膨胀。
    // 修改方式：把 llm_delta 标记为仅实时广播事件，不进入持久事件 journal，也不触发 metadata 落盘。
    // 修改目的：SubAgent Monitor 能实时消费 delta，但历史恢复仍只依赖最终 contents 快照。
    return event.type === 'llm_delta';
}
