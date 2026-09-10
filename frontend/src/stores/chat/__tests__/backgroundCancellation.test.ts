import { describe, expect, test, vi } from 'vitest';
import { createChatState, appendMessage } from '../state';
import { handleStreamChunk } from '../streamHandler';
import { cancelStream, cancelStreamAndRejectTools } from '../toolActions';
vi.mock('@/utils/vscode', () => ({ sendToExtension: vi.fn(async () => ({ cancelled: true })) }));

describe('后台任务取消后迟到的输出', () => {
  test.each([cancelStream, cancelStreamAndRejectTools])('取消保存运行标识，旧输出不能重新开启流式状态，新运行仍可进入', async cancel => {
    const state = createChatState(); state.currentConversationId.value = 'conversation';
    state.activeStreamId.value = 'old-run'; state.streamingMessageId.value = 'old-message'; state.isStreaming.value = true;
    appendMessage(state, { id: 'old-message', role: 'assistant', content: '已生成内容', streaming: true, timestamp: 1, backendIndex: 0 });
    await cancel(state, {} as any);
    expect(state._lastCancelledStreamId.value).toMatchObject({ conversationId: 'conversation', messageId: 'old-message', streamId: 'old-run' });
    const context = { state, currentModelName: () => '隔离模型', addCheckpoint: vi.fn(), updateConversationAfterMessage: vi.fn(), processQueue: vi.fn(), processQueueAfterAction: vi.fn() } as any;
    handleStreamChunk({ type: 'chunk', conversationId: 'conversation', backgroundRun: true, streamId: 'old-run' }, context);
    expect(state.isStreaming.value).toBe(false); expect(state.activeStreamId.value).toBeNull();
    handleStreamChunk({ type: 'chunk', conversationId: 'conversation', backgroundRun: true, streamId: 'new-run' }, context);
    expect(state.isStreaming.value).toBe(true); expect(state.activeStreamId.value).toBe('new-run');
    expect(state.allMessages.value.map(message => message.id)).toEqual(['old-message', 'placeholder:new-run']);
  });
});
