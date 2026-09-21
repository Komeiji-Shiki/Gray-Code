import { FormatterRegistry } from '../../modules/channel/formatters';
import type { ChannelConfig } from '../../modules/config/types';
import type { Content } from '../../modules/conversation/types';
import type { GenerateRequest } from '../../modules/channel/types';

const image = (data: string) => ({ inlineData: { mimeType: 'image/png', data } });
const history = (): Content[] => [
  { role: 'user', parts: [{ text: '最早的文字也要保留', ...image('OLDER_IMAGE') }] },
  { role: 'model', parts: [{ text: '中间的回答' }] },
  { role: 'user', isUserInput: true, parts: [{ text: '当前文字' }, image('RECENT_ONE'), image('RECENT_TWO')] },
];
const config = (type: ChannelConfig['type'], extra = {}) => ({ id: 'images', name: '图片上限验证', type, enabled: true,
  url: 'http://127.0.0.1:1/v1', apiKey: '', model: 'fixture-model', timeout: 1000, preferStream: false, ...extra }) as ChannelConfig;

test.each<ChannelConfig['type']>(['openai', 'openai-responses', 'anthropic', 'gemini', 'gemini-interactions'])('%s 保留完整图片历史，新增图片不改变已有请求前缀', type => {
  const request: GenerateRequest = { configId: 'images', history: history(), dynamicContextStrategy: 'preserve' as const,
    promptContext: { historyPlacement: 'entry' as const, beforeHistoryMessages: [{ role: 'user', parts: [{ text: '上下文中的文字' }, image('CONTEXT_OLDER_IMAGE')] }], afterHistoryMessages: [] } };
  const original = structuredClone(request);
  const formatter = new FormatterRegistry().get(type)!;
  // 旧配置中的图片数量限制也不能再裁掉历史。
  const settings = config(type, { maxInputImages: 2 });
  const body = formatter.buildRequest(request, settings).body;
  const serialized = JSON.stringify(body);
  expect(serialized).toContain('OLDER_IMAGE');
  for (const text of ['RECENT_ONE', 'RECENT_TWO', '最早的文字也要保留', '中间的回答', '当前文字', '上下文中的文字']) expect(serialized).toContain(text);
  expect(serialized).not.toContain('maxInputImages'); expect(request).toEqual(original);
  const extended = formatter.buildRequest({ ...request, history: [...request.history,
    { role: 'model', parts: [{ text: '继续观察' }] }, { role: 'user', parts: [image('NEXT_IMAGE')] }] }, settings).body;
  const items = (value: any) => value.messages ?? value.contents ?? value.input;
  const previous = items(body);
  expect(Array.isArray(previous)).toBe(true);
  expect(items(extended).slice(0, previous.length)).toEqual(previous);
});

test.each<ChannelConfig['type']>(['gemini', 'gemini-interactions'])('%s 导入旧配置后也不自动删除图片', type => {
  const formatter = new FormatterRegistry().get(type)!;
  const request = { configId: 'images', history: history() };
  request.history[0].parts = [{ text: '最早的文字也要保留' }, image('OLDER_IMAGE')];
  const legacy = config(type, { options: { maxImages: 1 }, optionsEnabled: { maxImages: true } });
  const body = JSON.stringify(formatter.buildRequest(request, legacy).body);
  expect(body).toContain('OLDER_IMAGE'); expect(body).toContain('RECENT_ONE'); expect(body).toContain('RECENT_TWO');
});
