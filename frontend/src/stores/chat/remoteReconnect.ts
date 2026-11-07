import { watch } from 'vue';
import type { ChatStoreState } from './types';
import { sendToExtension } from '../../utils/vscode';
import { clearAllSmoothForState, resetTurnBaseTokenEstimate } from './streamChunkHandlers';
import { loadCheckpoints, loadHistory } from './conversationActions';
import { loadBranchGraph } from './branchActions';

/**
 * 远端视图过期记录：流式事件出现缺口或重新登录后先标记过期，当前或切回的对话再重建。
 * 同一对话同时只进行一次重建，成功后才清除标记，失败时下次切回会再试。
 */
export function createRemoteViewResync(state: ChatStoreState) {
  const stale = new Set<string>();
  const refreshes = new Map<string, Promise<void>>();
  function restore(conversationId: string): Promise<void> {
    const existing = refreshes.get(conversationId);
    if (existing) return existing;
    const operation = synchronizeRemoteConversation(state, conversationId).then(restored => {
      if (restored) stale.delete(conversationId);
    }).catch(error => {
      if (state.currentConversationId.value === conversationId) state.error.value = { code: 'RESYNC_ERROR', message: (error as Error).message };
    }).finally(() => { if (refreshes.get(conversationId) === operation) refreshes.delete(conversationId); });
    refreshes.set(conversationId, operation);
    return operation;
  }
  return {
    restore,
    isStale: (conversationId: string) => stale.has(conversationId),
    markStale: (conversationId: string) => { stale.add(conversationId); },
    forget: (conversationId: string) => { stale.delete(conversationId); },
    request(conversationId: string) {
      stale.add(conversationId);
      void restore(conversationId);
    },
  };
}
export type RemoteViewResync = ReturnType<typeof createRemoteViewResync>;

/** 只重建客户端的显示状态，输入草稿与核心任务保持不变。 */
export async function synchronizeRemoteConversation(state: ChatStoreState, conversationId: string): Promise<boolean> {
  if (state.currentConversationId.value !== conversationId) return false;
  clearAllSmoothForState(state);
  resetTurnBaseTokenEstimate(state, conversationId);
  state.isLoading.value = true; state.isStreaming.value = false; state.isWaitingForResponse.value = false;
  state.streamingMessageId.value = null; state.activeStreamId.value = null; state._lastCancelledStreamId.value = null;
  state.activeRunStatus.value = null;
  state.toolResponseCache.value = new Map();
  state.backgroundStreamBuffers.value.delete(conversationId);
  const tab = state.openTabs.value.find(tab => tab.conversationId === conversationId); if (tab) tab.isStreaming = false;
  let stopWatching: (() => void) | undefined; let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await loadHistory(state, true);
    if (state.currentConversationId.value !== conversationId) return false;
    let snapshotArrived!: (received: boolean) => void;
    const snapshot = new Promise<boolean>(resolve => { snapshotArrived = resolve; });
    stopWatching = watch([state.activeStreamId, state.currentConversationId], ([streamId, current]) => {
      if (current !== conversationId) snapshotArrived(false);
      else if (streamId) snapshotArrived(true);
    }, { flush: 'sync' });
    const restored = await sendToExtension<{ active: boolean; latestMessageId?: string }>('chat.resumeConversationStream', { conversationId });
    if (state.currentConversationId.value !== conversationId) return false;
    if (restored.active) {
      // HTTP 应答可能先于 SSE 快照到达，继续等待快照，期间忽略旧的后台增量。
      timeout = setTimeout(() => snapshotArrived(false), 10_000);
      if (!await snapshot) {
        if (state.currentConversationId.value !== conversationId) return false;
        throw new Error('任务快照尚未同步，请重新打开这段对话重试。');
      }
    } else if (restored.latestMessageId && !state.allMessages.value.some(message => message.id === restored.latestMessageId)) await loadHistory(state, true);
    if (state.currentConversationId.value !== conversationId) return false;
    await Promise.all([loadCheckpoints(state), loadBranchGraph(state)]);
    return state.currentConversationId.value === conversationId;
  } finally {
    stopWatching?.(); if (timeout) clearTimeout(timeout);
    if (state.currentConversationId.value === conversationId) state.isLoading.value = false;
  }
}
