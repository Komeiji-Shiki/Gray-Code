import { watch } from 'vue';
import type { ChatStoreState } from './types';
import { sendToExtension } from '../../utils/vscode';
import { clearAllSmoothForState } from './streamChunkHandlers';
import { loadCheckpoints, loadHistory } from './conversationActions';
import { loadBranchGraph } from './branchActions';

/** 只重建客户端的显示状态，输入草稿与核心任务保持不变。 */
export async function synchronizeRemoteConversation(state: ChatStoreState, conversationId: string): Promise<boolean> {
  if (state.currentConversationId.value !== conversationId) return false;
  clearAllSmoothForState(state);
  state.isLoading.value = true; state.isStreaming.value = false; state.isWaitingForResponse.value = false;
  state.streamingMessageId.value = null; state.activeStreamId.value = null; state._lastCancelledStreamId.value = null;
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
