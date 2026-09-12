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

test.each<ChannelConfig['type']>(['openai', 'openai-responses', 'anthropic', 'gemini', 'gemini-interactions'])('%s 的完整请求只保留最近图片，文字与原图记录不变', type => {
  const request: GenerateRequest = { configId: 'images', history: history(), dynamicContextStrategy: 'preserve' as const,
    promptContext: { historyPlacement: 'entry' as const, beforeHistoryMessages: [{ role: 'user', parts: [{ text: '上下文中的文字' }, image('CONTEXT_OLDER_IMAGE')] }], afterHistoryMessages: [] } };
  const original = structuredClone(request);
  const formatter = new FormatterRegistry().get(type)!;
  const serialized = JSON.stringify(formatter.buildRequest(request, config(type, { maxInputImages: 2 })).body);
  expect(serialized).not.toContain('OLDER_IMAGE');
  for (const text of ['RECENT_ONE', 'RECENT_TWO', '最早的文字也要保留', '中间的回答', '当前文字', '上下文中的文字']) expect(serialized).toContain(text);
  expect(serialized).not.toContain('maxInputImages'); expect(request).toEqual(original);
});

test.each<ChannelConfig['type']>(['gemini', 'gemini-interactions'])('%s 沿用旧上限，明确设为零可取消限制', type => {
  const formatter = new FormatterRegistry().get(type)!;
  const request = { configId: 'images', history: history() };
  request.history[0].parts = [{ text: '最早的文字也要保留' }, image('OLDER_IMAGE')];
  const legacy = config(type, { options: { maxImages: 1 }, optionsEnabled: { maxImages: true } });
  const limited = JSON.stringify(formatter.buildRequest(request, legacy).body);
  expect(limited).toContain('RECENT_TWO'); expect(limited).not.toContain('RECENT_ONE');
  const unlimited = JSON.stringify(formatter.buildRequest(request, { ...legacy, maxInputImages: 0 }).body);
  expect(unlimited).toContain('OLDER_IMAGE'); expect(unlimited).toContain('RECENT_ONE');
});
