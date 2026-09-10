import { expect, test, vi } from 'vitest';
import { createChatState, appendMessage } from '../state';
import { handleStreamChunk } from '../streamHandler';
import { synchronizeRemoteConversation } from '../remoteReconnect';
import { sendToExtension } from '@/utils/vscode';
vi.mock('@/utils/vscode', () => ({ sendToExtension: vi.fn(async () => ({})) }));

test('装载历史后接续模型快照，随后增量和完成记录只保留一份消息', () => {
  const state = createChatState(); state.currentConversationId.value = 'conversation'; state.isLoading.value = true;
  const context = { state, currentModelName: () => '测试模型', addCheckpoint: vi.fn(), updateConversationAfterMessage: vi.fn(), processQueue: vi.fn(), processQueueAfterAction: vi.fn() } as any;
  const base = { conversationId: 'conversation', backgroundRun: true, streamId: 'background:running' };
  handleStreamChunk({ ...base, type: 'chunk', chunk: { delta: [{ text: '装载期间的增量' }], done: false } }, context);
  expect(state.allMessages.value).toHaveLength(0);
  appendMessage(state, { id: 'user', role: 'user', content: '当前任务', timestamp: 1, backendIndex: 0 });
  handleStreamChunk({ ...base, type: 'chunk', resumeSnapshot: true, chunk: { delta: [], done: false, contentSnapshot: { role: 'model', parts: [{ text: '完整前缀' }] } } }, context);
  handleStreamChunk({ ...base, type: 'chunk', chunk: { delta: [{ text: '和后续内容' }], done: false } }, context);
  expect(state.allMessages.value.at(-1)?.content).toBe('完整前缀和后续内容');
  handleStreamChunk({ ...base, type: 'complete', content: { id: 'saved-model', role: 'model', parts: [{ text: '完整前缀和后续内容' }] } }, context);
  expect(state.allMessages.value.map(message => message.id)).toEqual(['user', 'saved-model']); expect(state.isStreaming.value).toBe(false);
});

test('事件过期后等待真正的快照再接收增量，并保留未发送的输入和附件', async () => {
  const state = createChatState(); state.currentConversationId.value = 'conversation';
  state.activeStreamId.value = 'old-stream'; state.isStreaming.value = true; state.isWaitingForResponse.value = true;
  state.inputValue.value = '仍在编辑的输入'; state.editorNodes.value = [{ type: 'text', text: '仍在编辑的输入' }];
  state.attachments.value = [{ id: 'draft-file', name: 'draft.txt' }] as any;
  const attachments = state.attachments.value;
  const context = { state, currentModelName: () => '测试模型', addCheckpoint: vi.fn(), updateConversationAfterMessage: vi.fn(), processQueue: vi.fn(), processQueueAfterAction: vi.fn() } as any;
  const send = sendToExtension as unknown as ReturnType<typeof vi.fn>;
  send.mockImplementation(async (type: string) => {
    if (type === 'conversation.getMessagesPaged') return { total: 1, messages: [{ id: 'user', role: 'user', parts: [{ text: '当前任务' }] }] };
    if (type === 'chat.resumeConversationStream') {
      setTimeout(() => {
        expect(state.isLoading.value).toBe(true);
        handleStreamChunk({ conversationId: 'conversation', backgroundRun: true, streamId: 'old-stream', type: 'chunk', chunk: { delta: [{ text: '过期增量' }], done: false } }, context);
        const base = { conversationId: 'conversation', backgroundRun: true, streamId: 'background:current' };
        handleStreamChunk({ ...base, type: 'chunk', resumeSnapshot: true, chunk: { delta: [], done: false, contentSnapshot: { id: 'live', role: 'model', parts: [{ text: '最新前缀' }] } } }, context);
        handleStreamChunk({ ...base, type: 'chunk', chunk: { delta: [{ text: '与新内容' }], done: false } }, context);
      }, 0);
      return { active: true };
    }
    return { success: true, checkpoints: [], graph: null };
  });
  expect(await synchronizeRemoteConversation(state, 'conversation')).toBe(true);
  expect(state.allMessages.value.at(-1)?.content).toBe('最新前缀与新内容');
  expect(state.inputValue.value).toBe('仍在编辑的输入'); expect(state.attachments.value).toBe(attachments);
  expect(state.isLoading.value).toBe(false); expect(state.isStreaming.value).toBe(true);
  expect(send.mock.calls.every(([type]) => !['chatStream', 'cancelStream', 'retryStream'].includes(type))).toBe(true);
});

test('离线期间已经完成的任务恢复为已完成显示，旧流式占位被最新历史替换', async () => {
  const state = createChatState(); state.currentConversationId.value = 'conversation';
  state.activeStreamId.value = 'old-stream'; state.isStreaming.value = true; state.isWaitingForResponse.value = true;
  state.inputValue.value = '完成后再发送的草稿';
  appendMessage(state, { id: 'old-placeholder', role: 'assistant', content: '旧内容', timestamp: 1, backendIndex: 0, streaming: true, localOnly: true });
  (sendToExtension as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (type: string) => {
    if (type === 'conversation.getMessagesPaged') return { total: 1, messages: [{ id: 'saved-final', role: 'model', parts: [{ text: '离线期间完成的结果' }] }] };
    if (type === 'chat.resumeConversationStream') return { active: false, latestMessageId: 'saved-final' };
    return { success: true, checkpoints: [], graph: null };
  });
  expect(await synchronizeRemoteConversation(state, 'conversation')).toBe(true);
  expect(state.allMessages.value.map(message => message.id)).toEqual(['saved-final']);
  expect(state.allMessages.value[0].content).toBe('离线期间完成的结果'); expect(state.inputValue.value).toBe('完成后再发送的草稿');
  expect(state.isStreaming.value).toBe(false); expect(state.isWaitingForResponse.value).toBe(false); expect(state.activeStreamId.value).toBeNull();
});
