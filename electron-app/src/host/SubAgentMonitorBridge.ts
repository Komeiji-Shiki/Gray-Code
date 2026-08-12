/**
 * SubAgentMonitorBridge.ts
 *
 * 子代理 Monitor 的内嵌面板桥（替代独立 BrowserWindow 方案）。
 *
 * 用户预期：Monitor 在主窗口内做一个分区（右侧内嵌面板），而不是独立窗口占用任务栏。
 * 本桥在主进程/后端侧：
 *  - 订阅 subAgentRunEventBus，把瘦身后的 subagentMonitor.event/manifest 推送到主窗口渲染进程
 *    （仅当面板可见时推送高频 llm_delta；面板折叠时丢弃，打开后由前端重新校准窗口）；
 *  - 处理 subagents.monitorReady / subagents.monitor.getRunWindow / subagents.monitor.setVisible
 *    （其余消息委托 BackendHost.routeMonitorMessage 走统一 MessageRouter）；
 *  - openRun() 在“打开详情”时更新焦点并推送导航 manifest，前端据此切换 run。
 */

import {
  subAgentRunController,
  subAgentRunEventBus,
  type SubAgentRunEvent,
  type SubAgentRunManifest,
  type SubAgentRunSnapshot
} from '../../../backend/tools/subagents';
import type { SubAgentRunConversationStore } from '../../../backend/tools/subagents/runEventBus';
import { WEBVIEW_CLIENT_IDS } from '../../../webview/runtime/WebviewClientRegistry';
import { createMonitorEventPayload } from '../../../webview/SubAgentMonitorPanel';

const LLM_DELTA_FLUSH_MS = 50;
// 面板折叠时非 delta 事件（tool_*/content_snapshot/usage/run_* 等）的合并窗口：
// 不可见时逐条 postMessage 会把渲染进程 IPC 打满（并发 8-10 个子代理可达每秒数百条），
// 合并到窗口粒度后降至每 run 每窗口 1 条；恢复可见后由 manifest 校准（前端 revision 判据）。
const NON_DELTA_FLUSH_MS = 100;
// manifest 轻量缓存容量上限（与 VSCode 版 SubAgentMonitorPanel.MANIFEST_CACHE_MAX 对齐）
const MANIFEST_CACHE_MAX = 100;

export interface SubAgentMonitorBridgeSeam {
  /** 路由非 lifecycle 消息（pauseRun/exitRun/deleteRunMessage/retryRunFromMessage 等） */
  routeMonitorMessage(message: any): Promise<boolean>;
  /** 注册 monitor webview client（runScope 由后端路由使用），返回 Disposable */
  registerMonitorClient(
    runId?: string,
    conversationId?: string,
    sendTo?: (message: any) => void
  ): { dispose(): void };
  /** 父对话历史仓库（用于恢复历史 run 的 transcript） */
  getConversationStore(): SubAgentRunConversationStore;
  /** 推送消息到主窗口渲染进程 */
  postToRenderer(message: any): void;
}

export class SubAgentMonitorBridge {
  /** 面板是否可见（由前端 subagents.monitor.setVisible 通知） */
  private visible = false;
  /** 前端是否已挂载 Monitor（subagents.monitorReady 到达前不推送任何事件——面板从未打开时逐条构造+postMessage 纯属浪费，并发子代理时会把 IPC 打满） */
  private monitorMounted = false;
  private focusRunId?: string;
  private focusConversationId?: string;
  private clientDispose?: { dispose(): void };
  private readonly unsubscribe: () => void;
  private readonly pendingLlmDeltaEvents = new Map<string, SubAgentRunEvent[]>();
  private llmDeltaFlushTimer?: ReturnType<typeof setTimeout>;
  /** 面板折叠时按 runId 合并的非 delta 事件（每 run 只保留窗口内最新一条） */
  private readonly pendingNonDeltaEvents = new Map<string, SubAgentRunEvent>();
  private nonDeltaFlushTimer?: ReturnType<typeof setTimeout>;
  /** updatedAt 未变化的 manifest 复用缓存（避免每条事件都重新派生轻量 manifest） */
  private readonly manifestCache = new Map<string, { manifest: SubAgentRunManifest; updatedAt: number }>();

  constructor(private readonly host: SubAgentMonitorBridgeSeam) {
    this.unsubscribe = subAgentRunEventBus.subscribe((event, snapshot) => {
      this.postEvent(event, snapshot);
    });
  }

  setVisible(visible: boolean): void {
    this.visible = !!visible;
    if (!this.visible) {
      this.clearLlmDeltaQueue();
      this.clearNonDeltaQueue();
    } else {
      // 恢复可见：折叠期间的事件被合并/丢弃，补一次纯状态同步（不覆盖用户在面板内的选中）
      this.postManifest({ navigate: false });
    }
  }

  /** “打开详情”入口：更新焦点 run 并推送导航 manifest（前端未挂载时由 monitorReady 兜底） */
  openRun(runId?: string, conversationId?: string): void {
    this.focusRunId = runId;
    this.focusConversationId = conversationId;
    this.registerClient(runId, conversationId);
    this.postManifest({ navigate: true });
  }

  async handleMessage(message: any): Promise<void> {
    if (!message || typeof message !== 'object') return;
    const { type, data, requestId } = message || {};

    if (type === 'subagents.monitorReady') {
      this.monitorMounted = true;
      await this.loadConversationSnapshotsIfPossible(this.focusConversationId);
      this.host.postToRenderer({
        type: 'response',
        requestId,
        success: true,
        data: this.createManifestPayload(true)
      });
      return;
    }

    if (type === 'subagents.monitor.getRunWindow') {
      const runId = typeof data?.runId === 'string' ? data.runId.trim() : '';
      if (!runId) {
        this.host.postToRenderer({
          type: 'error',
          requestId,
          success: false,
          error: { code: 'SUBAGENT_MONITOR_WINDOW_INVALID_INPUT', message: 'runId is required' }
        });
        return;
      }
      await this.loadConversationSnapshotsIfPossible(
        typeof data?.conversationId === 'string' ? data.conversationId : this.focusConversationId
      );
      const contentWindow = subAgentRunEventBus.getContentWindow(runId, data?.options || {});
      if (!contentWindow) {
        this.host.postToRenderer({
          type: 'error',
          requestId,
          success: false,
          error: { code: 'SUBAGENT_RUN_NOT_FOUND', message: `SubAgent run not found: ${runId}` }
        });
        return;
      }
      this.host.postToRenderer({
        type: 'response',
        requestId,
        success: true,
        data: {
          window: contentWindow,
          manifest: subAgentRunEventBus.getManifest(runId),
          activeRunIds: subAgentRunController.getActiveRunIds()
        }
      });
      return;
    }

    if (type === 'subagents.monitor.setVisible') {
      this.setVisible(data?.visible === true);
      this.host.postToRenderer({
        type: 'response',
        requestId,
        success: true,
        data: { visible: this.visible }
      });
      return;
    }

    await this.host.routeMonitorMessage(message);
  }

  dispose(): void {
    this.unsubscribe();
    this.clearLlmDeltaQueue();
    this.clearNonDeltaQueue();
    this.clientDispose?.dispose();
    this.clientDispose = undefined;
  }

  private registerClient(runId?: string, conversationId?: string): void {
    this.clientDispose?.dispose();
    this.clientDispose = this.host.registerMonitorClient(runId, conversationId, (msg) => {
      this.host.postToRenderer(msg);
    });
  }

  private postEvent(event: SubAgentRunEvent, snapshot: SubAgentRunSnapshot): void {
    // 前端尚未挂载 Monitor（monitorReady 未到达）：没有任何监听器在消费，逐条构造
    // 事件载荷并 postMessage 纯属浪费——并发子代理时每秒数百条 IPC 会把渲染进程打满（崩溃根因）。
    if (!this.monitorMounted) {
      return;
    }
    if (!this.visible) {
      // 面板折叠：丢弃高频正文增量；其余事件合并到窗口粒度（恢复可见后前端按 revision 校准）
      if (event.type === 'llm_delta') {
        return;
      }
      this.enqueueNonDelta(event);
      return;
    }
    if (event.type === 'llm_delta') {
      this.enqueueLlmDelta(event);
      return;
    }
    this.postToWindow({
      type: 'subagentMonitor.event',
      data: {
        event: createMonitorEventPayload(event, snapshot),
        manifest: this.getCachedManifest(snapshot.runId),
        focusRunId: this.focusRunId,
        focusConversationId: this.focusConversationId,
        activeRunIds: subAgentRunController.getActiveRunIds()
      }
    });
  }

  /** 面板折叠时把非 delta 事件按 runId 合并（每 run 保留窗口内最新一条），到窗口粒度后一次 flush */
  private enqueueNonDelta(event: SubAgentRunEvent): void {
    this.pendingNonDeltaEvents.set(event.runId, event);
    if (!this.nonDeltaFlushTimer) {
      this.nonDeltaFlushTimer = setTimeout(() => this.flushNonDeltaEvents(), NON_DELTA_FLUSH_MS);
      (this.nonDeltaFlushTimer as { unref?: () => void }).unref?.();
    }
  }

  private flushNonDeltaEvents(): void {
    this.nonDeltaFlushTimer = undefined;
    if (this.pendingNonDeltaEvents.size === 0) {
      return;
    }
    const batches = Array.from(this.pendingNonDeltaEvents.entries());
    this.pendingNonDeltaEvents.clear();
    for (const [runId, event] of batches) {
      const snapshot = subAgentRunEventBus.getSnapshot(runId);
      if (!snapshot) continue;
      this.postToWindow({
        type: 'subagentMonitor.event',
        data: {
          event: createMonitorEventPayload(event, snapshot),
          manifest: this.getCachedManifest(runId),
          focusRunId: this.focusRunId,
          focusConversationId: this.focusConversationId,
          activeRunIds: subAgentRunController.getActiveRunIds()
        }
      });
    }
  }

  private clearNonDeltaQueue(): void {
    if (this.nonDeltaFlushTimer) {
      clearTimeout(this.nonDeltaFlushTimer);
      this.nonDeltaFlushTimer = undefined;
    }
    this.pendingNonDeltaEvents.clear();
  }

  private enqueueLlmDelta(event: SubAgentRunEvent): void {
    const list = this.pendingLlmDeltaEvents.get(event.runId);
    if (list) {
      list.push(event);
    } else {
      this.pendingLlmDeltaEvents.set(event.runId, [event]);
    }
    if (!this.llmDeltaFlushTimer) {
      this.llmDeltaFlushTimer = setTimeout(() => this.flushLlmDeltas(), LLM_DELTA_FLUSH_MS);
      (this.llmDeltaFlushTimer as { unref?: () => void }).unref?.();
    }
  }

  private flushLlmDeltas(): void {
    this.llmDeltaFlushTimer = undefined;
    if (!this.visible || this.pendingLlmDeltaEvents.size === 0) {
      this.pendingLlmDeltaEvents.clear();
      return;
    }
    const batches = Array.from(this.pendingLlmDeltaEvents.entries());
    this.pendingLlmDeltaEvents.clear();

    for (const [runId, events] of batches) {
      const snapshot = subAgentRunEventBus.getSnapshot(runId);
      if (!snapshot) continue;
      const last = events[events.length - 1];
      const lastPayload = (last.payload || {}) as Record<string, unknown>;
      const mergedPayload: Record<string, unknown> = { ...lastPayload };
      const deltaParts: unknown[] = [];
      for (const event of events) {
        const rawDelta = (event.payload as Record<string, unknown> | undefined)?.delta;
        if (Array.isArray(rawDelta)) {
          deltaParts.push(...rawDelta);
        }
      }
      if (deltaParts.length > 0) {
        mergedPayload.delta = deltaParts;
      }
      const mergedEvent: SubAgentRunEvent = {
        ...last,
        runId,
        payload: mergedPayload
      };
      this.postToWindow({
        type: 'subagentMonitor.event',
        data: {
          event: createMonitorEventPayload(mergedEvent, snapshot),
          manifest: this.getCachedManifest(runId),
          focusRunId: this.focusRunId,
          focusConversationId: this.focusConversationId,
          activeRunIds: subAgentRunController.getActiveRunIds()
        }
      });
    }
  }

  /** 获取（并按需重建）指定 run 的轻量 manifest：updatedAt 未变化时直接复用缓存（对齐 VSCode 版 getCachedManifest） */
  private getCachedManifest(runId: string): SubAgentRunManifest | undefined {
    const manifest = subAgentRunEventBus.getManifest(runId);
    if (!manifest) {
      // manifest 可能为 undefined（run 尚未加载/已被清理）：顺带清理可能残留的过期缓存条目
      this.manifestCache.delete(runId);
      return undefined;
    }
    const cached = this.manifestCache.get(runId);
    if (cached && cached.updatedAt === manifest.updatedAt) {
      return cached.manifest;
    }
    this.manifestCache.set(runId, { manifest, updatedAt: manifest.updatedAt });
    // 容量上限：超出时按插入序淘汰最旧条目
    if (this.manifestCache.size > MANIFEST_CACHE_MAX) {
      const oldestRunId = this.manifestCache.keys().next().value;
      if (oldestRunId !== undefined) {
        this.manifestCache.delete(oldestRunId);
      }
    }
    return manifest;
  }

  private clearLlmDeltaQueue(): void {
    if (this.llmDeltaFlushTimer) {
      clearTimeout(this.llmDeltaFlushTimer);
      this.llmDeltaFlushTimer = undefined;
    }
    this.pendingLlmDeltaEvents.clear();
  }

  private postToWindow(message: any): void {
    this.host.postToRenderer(message);
  }

  private async loadConversationSnapshotsIfPossible(conversationId?: string): Promise<void> {
    if (!conversationId) {
      return;
    }
    try {
      await subAgentRunEventBus.loadConversationSnapshots(conversationId, this.host.getConversationStore());
    } catch (err) {
      console.error('[SubAgentMonitorBridge] loadConversationSnapshots failed:', err);
    }
  }

  /**
   * @param navigate 是否携带导航意图。true 表示"用户从主聊天打开了某个 run"；
   *                 false 用于纯状态同步，不得覆盖用户在面板内手动选中的 run。
   */
  private createManifestPayload(navigate: boolean): Record<string, any> {
    return {
      manifests: subAgentRunEventBus.getManifests(),
      focusRunId: navigate ? this.focusRunId : undefined,
      focusConversationId: this.focusConversationId,
      activeRunIds: subAgentRunController.getActiveRunIds()
    };
  }

  private postManifest(options: { navigate: boolean } = { navigate: true }): void {
    this.postToWindow({
      type: 'subagentMonitor.manifest',
      data: this.createManifestPayload(options.navigate)
    });
  }
}
