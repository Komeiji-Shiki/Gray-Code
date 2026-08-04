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
  type SubAgentRunSnapshot
} from '../../../backend/tools/subagents';
import type { SubAgentRunConversationStore } from '../../../backend/tools/subagents/runEventBus';
import { WEBVIEW_CLIENT_IDS } from '../../../webview/runtime/WebviewClientRegistry';
import { createMonitorEventPayload } from '../../../webview/SubAgentMonitorPanel';

const LLM_DELTA_FLUSH_MS = 50;

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
  private focusRunId?: string;
  private focusConversationId?: string;
  private clientDispose?: { dispose(): void };
  private readonly unsubscribe: () => void;
  private readonly pendingLlmDeltaEvents = new Map<string, SubAgentRunEvent[]>();
  private llmDeltaFlushTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly host: SubAgentMonitorBridgeSeam) {
    this.unsubscribe = subAgentRunEventBus.subscribe((event, snapshot) => {
      this.postEvent(event, snapshot);
    });
  }

  setVisible(visible: boolean): void {
    this.visible = !!visible;
    if (!this.visible) {
      this.clearLlmDeltaQueue();
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
    // 面板折叠时丢弃高频正文增量；低频状态事件继续推送，重新打开后由前端按 revision 校准
    if (!this.visible && event.type === 'llm_delta') {
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
        manifest: subAgentRunEventBus.getManifest(snapshot.runId),
        focusRunId: this.focusRunId,
        focusConversationId: this.focusConversationId,
        activeRunIds: subAgentRunController.getActiveRunIds()
      }
    });
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
          manifest: subAgentRunEventBus.getManifest(runId),
          focusRunId: this.focusRunId,
          focusConversationId: this.focusConversationId,
          activeRunIds: subAgentRunController.getActiveRunIds()
        }
      });
    }
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
