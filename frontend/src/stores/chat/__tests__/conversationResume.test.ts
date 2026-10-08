import { expect, test, vi } from 'vitest';
import { createChatState, appendMessage } from '../state';
import { handleStreamChunk } from '../streamHandler';
import { synchronizeRemoteConversation } from '../remoteReconnect';
import { switchTab } from '../tabActions';
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

test.each(['缓冲溢出', '后台新运行'])('%s 后切回只同步历史与运行快照，草稿保留且不重启任务', async reason => {
  const previousHost = window.__GRAYCODE_HOST;
  window.__GRAYCODE_HOST = { kind: 'desktop' } as NonNullable<typeof previousHost>;
  const state = createChatState();
  state.openTabs.value = [{ id: 'tab-a', conversationId: 'conversation', title: 'A', isStreaming: true },
    { id: 'tab-b', conversationId: 'other', title: 'B', isStreaming: false }];
  state.activeTabId.value = 'tab-a'; state.currentConversationId.value = 'conversation';
  state.activeStreamId.value = 'old-stream'; state.streamingMessageId.value = 'old-placeholder';
  state.isStreaming.value = true; state.isWaitingForResponse.value = true;
  state.inputValue.value = '后台完成后再发的草稿';
  state.attachments.value = [{ id: 'draft', name: 'draft.txt' }] as any;
  const attachments = state.attachments.value;
  appendMessage(state, { id: 'old-placeholder', role: 'assistant', content: '切走时的前缀', timestamp: 1, streaming: true, localOnly: true });
  let recovery: Promise<boolean> | undefined;
  const context = { state, currentModelName: () => '模型', addCheckpoint: vi.fn(), updateConversationAfterMessage: vi.fn(),
    processQueue: vi.fn(), processQueueAfterAction: vi.fn(), requestConversationResync: vi.fn((id: string) => {
      recovery = synchronizeRemoteConversation(state, id);
    }) } as any;
  const send = sendToExtension as unknown as ReturnType<typeof vi.fn>;
  send.mockClear();
  send.mockImplementation(async (type: string) => {
    if (type === 'conversation.getMessagesPaged') return { total: 1, messages: [{ id: 'user', role: 'user', parts: [{ text: '原任务' }] }] };
    if (type === 'chat.resumeConversationStream') {
      setTimeout(() => handleStreamChunk({ type: 'chunk', conversationId: 'conversation', backgroundRun: true,
        streamId: 'background:current', resumeSnapshot: true,
        chunk: { delta: [], done: false, contentSnapshot: { id: 'live', role: 'model', parts: [{ text: '完整前缀和后台进度' }] } } }, context), 0);
      return { active: true };
    }
    return { success: true, checkpoints: [], graph: null };
  });
  try {
    switchTab(state, 'tab-b', vi.fn(), context);
    if (reason === '缓冲溢出') {
      for (let index = 0; index < 2002; index++) handleStreamChunk({ type: 'chunk', conversationId: 'conversation',
        streamId: 'old-stream', chunk: { delta: [{ text: String(index) }], done: false } }, context);
    } else {
      handleStreamChunk({ type: 'complete', conversationId: 'conversation', streamId: 'old-stream' }, context);
      handleStreamChunk({ type: 'chunk', conversationId: 'conversation', streamId: 'background:new', backgroundRun: true,
        chunk: { delta: [{ text: '新的自动续跑' }], done: false } }, context);
    }
    expect(state.sessionSnapshots.value.get('tab-a')?.needsStreamResync).toBe(true);
    expect(state.backgroundStreamBuffers.value.get('conversation')).toEqual([]);
    switchTab(state, 'tab-a', vi.fn(), context);
    expect(context.requestConversationResync).toHaveBeenCalledTimes(1);
    expect(await recovery).toBe(true);
    expect(state.allMessages.value.map(message => message.content)).toEqual(['原任务', '完整前缀和后台进度']);
    expect(state.inputValue.value).toBe('后台完成后再发的草稿'); expect(state.attachments.value).toBe(attachments);
    expect(state.isStreaming.value).toBe(true);
    expect(send.mock.calls.every(([type]) => !['chatStream', 'cancelStream', 'retryStream'].includes(type))).toBe(true);
  } finally { window.__GRAYCODE_HOST = previousHost; }
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
