import { beforeEach, expect, test, vi } from 'vitest';
import { createChatState } from '../state';
import { applyConversationModelConfig, setConfigId, setSelectedReasoningEffort } from '../configActions';

const send = vi.hoisted(() => vi.fn());
vi.mock('@/utils/vscode', () => ({ sendToExtension: send }));
beforeEach(() => {
  send.mockReset(); send.mockImplementation(async (type: string, data: any) => type === 'config.getConfig'
    ? { id: data.configId, name: '测试渠道', type: 'openai', model: 'model' } : { success: true });
});

test('思考选择只保存当前对话，并能恢复或清除覆盖值', async () => {
  const state = createChatState(); state.currentConversationId.value = 'first'; state.configId.value = 'channel'; state.selectedModelId.value = 'model';
  await setSelectedReasoningEffort(state, 'high');
  const request = send.mock.calls.at(-1)!;
  expect(request).toEqual(['conversation.setCustomMetadata', { conversationId: 'first', key: 'inputModelConfig', value: { configId: 'channel', modelId: 'model', reasoningEffort: 'high' } }]);
  state.selectedReasoningEffort.value = '';
  await applyConversationModelConfig(state, 'first', request[1].value); expect(state.selectedReasoningEffort.value).toBe('high');
  await setConfigId(state, 'another-channel'); expect(state.selectedReasoningEffort.value).toBe('high');
  await setSelectedReasoningEffort(state, ''); expect(send.mock.calls.at(-1)![1].value.reasoningEffort).toBeUndefined();
  state.selectedReasoningEffort.value = 'high';
  // 对齐 switchConversation：只有先切到目标会话，才应用其配置；迟到的其他会话配置应忽略。
  await applyConversationModelConfig(state, 'second', {}); expect(state.selectedReasoningEffort.value).toBe('high');
  state.currentConversationId.value = 'second';
  await applyConversationModelConfig(state, 'second', {}); expect(state.selectedReasoningEffort.value).toBe('');
  expect(send.mock.calls.some(([type]) => ['config.updateConfig', 'platform.settings.update'].includes(type))).toBe(false);
});
