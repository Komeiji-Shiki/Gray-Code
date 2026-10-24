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
function messages(history: Content[], toolMediaUserMessageEnabled = false) {
  return new OpenAIFormatter().buildRequest({ configId: 'openai-test', history, dynamicContextStrategy: 'preserve' },
    createOpenAIConfig({ toolMode: 'function_call', multimodalToolsEnabled: true, toolMediaUserMessageEnabled })).body.messages;
}

test('图片直接随对应工具结果发送，并保持后续请求的已有图片前缀', () => {
  const history: Content[] = [{ role: 'user', parts: [{ text: '观察两个页面' }] }, call(['a', 'b']), screenshot('a'), screenshot('b')];
  const original = structuredClone(history); const request = messages(history);
  expect(request.map((message: any) => message.role)).toEqual(['user', 'assistant', 'tool', 'tool']);
  expect(request[2].tool_call_id).toBe('a'); expect(request[3].tool_call_id).toBe('b');
  expect(request[2].content).toEqual([
    { type: 'text', text: '{"success":true}' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,SYNTHETIC_a' } },
  ]);
  expect(request[3].content).toEqual([
    { type: 'text', text: '{"success":true}' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,SYNTHETIC_b' } },
  ]);
  expect(messages([...history, call(['c']), screenshot('c')]).slice(0, request.length)).toEqual(request);
  expect(history).toEqual(original);
});

test('严格兼容模式下 tool 消息只带文本，整批结果之后追加一条标明来源的 user 消息', () => {
  const history: Content[] = [{ role: 'user', parts: [{ text: '观察两个页面' }] }, call(['a', 'b']), screenshot('a'), screenshot('b')];
  const request = messages(history, true);
  expect(request.map((message: any) => message.role)).toEqual(['user', 'assistant', 'tool', 'tool', 'user']);
  expect(request[2]).toMatchObject({ tool_call_id: 'a', content: '{"success":true}' });
  expect(request[3]).toMatchObject({ tool_call_id: 'b', content: '{"success":true}' });
  expect(request[4].content).toEqual([
    { type: 'text', text: 'Attachments returned by browser_read (a):' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,SYNTHETIC_a' } },
    { type: 'text', text: 'Attachments returned by browser_read (b):' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,SYNTHETIC_b' } },
  ]);
  // 后续调用追加在已有附件消息之后，旧请求前缀保持不变。
  const next = messages([...history, call(['c']), screenshot('c')], true);
  expect(next.slice(0, request.length)).toEqual(request);
  expect(next.slice(request.length).map((message: any) => message.role)).toEqual(['assistant', 'tool', 'user']);
});

test('嵌套在工具结果里的附件跟随各自的调用，纯文本结果不追加 user 消息', () => {
  const nested: Content = { role: 'user', isFunctionResponse: true, parts: [
    { functionResponse: { id: 'n', name: 'read_file', response: { success: true },
      parts: [{ inlineData: { mimeType: 'image/png', data: 'NESTED' } }] } },
  ] };
  const plain: Content = { role: 'user', isFunctionResponse: true, parts: [
    { functionResponse: { id: 'p', name: 'read_file', response: { success: true } } },
  ] };
  const inline = messages([call(['n']), nested]);
  expect(inline[1].content).toContainEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,NESTED' } });
  const strict = messages([call(['n']), nested, call(['p']), plain], true);
  expect(strict.map((message: any) => message.role)).toEqual(['assistant', 'tool', 'user', 'assistant', 'tool']);
  expect(strict[2].content[0]).toEqual({ type: 'text', text: 'Attachments returned by read_file (n):' });
  expect(strict[4].content).toBe('{"success":true}');
});

test('工具图片能力保留多模态开关，并支持三种工具模式', () => {
  for (const mode of ['function_call', 'xml', 'json'] as const) {
    expect(getMultimodalCapability('openai', mode, true)).toMatchObject({ supportsImages: true, supportsHistoryMultimodal: true });
    expect(getMultimodalCapability('openai', mode, false)).toMatchObject({ supportsImages: false, supportsHistoryMultimodal: false });
  }
});
