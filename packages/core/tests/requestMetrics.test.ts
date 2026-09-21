import { modelRequestMetrics } from '../../../apps/server/src/model/requestMetrics';

test.each([
  { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,cG5n' } }] }], tools: [{ type: 'function' }] },
  { input: [{ type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,cG5n' }] }], tools: [{ type: 'function' }] },
  { messages: [{ role: 'user', content: [{ type: 'tool_result', content: [{ type: 'image', source: { type: 'base64', data: 'cG5n' } }] }] }], tools: [{}] },
  { contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data: 'cG5n' } }] }], tools: [{ functionDeclarations: [{}] }] },
])('从实际协议内容块计数，不改变请求结构：%j', body => {
  const before = JSON.stringify(body);
  expect(modelRequestMetrics(body)).toEqual({ inputItems: 1, inputImages: 1, nativeTools: 1 });
  expect(JSON.stringify(body)).toBe(before);
});

test('JSON 工具参数、文本中的图片例子和音频不算作图片输入', () => {
  expect(modelRequestMetrics({ messages: [
    { role: 'assistant', content: [{ type: 'tool_use', input: { type: 'image', source: {} } }] },
    { role: 'user', content: '[{"type":"image_url"}]' },
    { role: 'user', parts: [{ inlineData: { mimeType: 'audio/wav', data: 'aA==' } }] },
  ] })).toEqual({ inputItems: 3, inputImages: 0, nativeTools: 0 });
});
