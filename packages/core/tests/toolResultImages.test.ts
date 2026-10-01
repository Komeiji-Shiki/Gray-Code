import type { PlatformMessage } from '@graycode/contracts';
import { PlatformApplication } from '../../../apps/server/src/application';
import { activeContextHistory } from '../../../apps/server/src/context/compaction';
import { fixture } from './fixtures';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRzUAAAAASUVORK5CYII=';

// 回归：设置页新建的渠道保存着 multimodalToolsEnabled: false（平台已不提供这个开关），
// 每轮请求前的历史整理曾据此删除工具结果中的图片，模型只能读到文本元数据；用户手动发送的图片不受影响。
test.each(['anthropic', 'openai', 'openai-responses', 'gemini'] as const)('%s 渠道的工具结果图片进入模型请求', async protocol => {
  const f = await fixture(); await f.store.close();
  const app = await PlatformApplication.open({ dataDirectory: f.data,
    models: { generate: async () => ({ role: 'model', parts: [{ text: 'unused' }] }) } });
  try {
    const draft = await app.product.draft();
    const providerId = await draft.configs.createConfig({ type: protocol, name: '工具图片夹具', enabled: true,
      url: 'http://127.0.0.1:1', model: 'fixture', apiKey: '', timeout: 1000, multimodalToolsEnabled: false });
    await app.product.save(draft);
    const config = (await app.product.channel(providerId))!;
    const history: PlatformMessage[] = [
      { id: 'ask', role: 'user', isUserInput: true, parts: [{ text: '看看这张图' }] },
      { id: 'call', role: 'model', parts: [{ functionCall: { id: 'read-image', name: 'read_file', args: { path: 'sample.png' } } }] },
      { id: 'result', role: 'user', isFunctionResponse: true, parts: [
        { functionResponse: { id: 'read-image', name: 'read_file', response: { success: true, data: { path: 'sample.png', mimeType: 'image/png' } } } },
        { inlineData: { mimeType: 'image/png', data: PNG } }] },
    ];
    const messages = activeContextHistory(history, config);
    expect(messages.flatMap(message => message.parts).some(part => (part.inlineData as { data?: string } | undefined)?.data === PNG)).toBe(true);
    const { body } = await app.modelAdapter.preview({ providerId, conversationId: 'tool-images', systemPrompt: '', messages, tools: [],
      signal: new AbortController().signal });
    expect(JSON.stringify(body)).toContain(PNG);
    if (protocol === 'anthropic') {
      const blocks = body.messages.flatMap((message: any) => message.content ?? []);
      expect(blocks.filter((block: any) => block.type === 'image' && block.source?.data === PNG)).toHaveLength(1);
    }
  } finally { await app.close(); await f.cleanup(); }
});
