import { OpenAIFormatter } from '../../modules/channel';
import { getMultimodalCapability } from '../../tools/shared/multimodal';
import type { Content } from '../../modules/conversation/types';
import { createOpenAIConfig } from '../__fixtures__/channelFixtures';

const screenshot = (id: string): Content => ({ role: 'user', isFunctionResponse: true, parts: [
  { functionResponse: { id, name: 'browser_read', response: { success: true } } },
  { inlineData: { mimeType: 'image/png', data: 'SYNTHETIC_' + id } },
] });
const call = (ids: string[]): Content => ({ role: 'model', parts: ids.map(id => (
  { functionCall: { id, name: 'browser_read', args: { action: 'screenshot' } } }
)) });
function messages(history: Content[]) {
  return new OpenAIFormatter().buildRequest({ configId: 'openai-test', history, dynamicContextStrategy: 'preserve' },
    createOpenAIConfig({ toolMode: 'function_call', multimodalToolsEnabled: true })).body.messages;
}

test('同批工具全部配对后发送图片，并保持后续请求的已有图片前缀', () => {
  const history: Content[] = [{ role: 'user', parts: [{ text: '观察两个页面' }] }, call(['a', 'b']), screenshot('a'), screenshot('b')];
  const original = structuredClone(history); const request = messages(history);
  expect(request.map((message: any) => message.role)).toEqual(['user', 'assistant', 'tool', 'tool', 'user', 'user']);
  expect(request[2].tool_call_id).toBe('a'); expect(request[3].tool_call_id).toBe('b');
  expect(request[4].content).toContainEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,SYNTHETIC_a' } });
  expect(request[5].content).toContainEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,SYNTHETIC_b' } });
  expect(messages([...history, call(['c']), screenshot('c')]).slice(0, request.length)).toEqual(request);
  expect(history).toEqual(original);
});

test('工具图片能力保留多模态开关，并支持三种工具模式', () => {
  for (const mode of ['function_call', 'xml', 'json'] as const) {
    expect(getMultimodalCapability('openai', mode, true)).toMatchObject({ supportsImages: true, supportsHistoryMultimodal: true });
    expect(getMultimodalCapability('openai', mode, false)).toMatchObject({ supportsImages: false, supportsHistoryMultimodal: false });
  }
});
