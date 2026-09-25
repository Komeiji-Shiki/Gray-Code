import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import type { ToolContext } from '@graycode/core';
import { PlatformApplication } from '../../../apps/server/src/application';
import { ApplicationRouter } from '../../../apps/server/src/transport/router';
import { fixture } from './fixtures';

// 桌面与 Web 版渠道设置不提供“多模态工具”开关，read_file 必须默认按供应方协议读取图片/PDF。
// 回归场景：旧实现未把 multimodalEnabled / capability 注入工具上下文，
// 导致声明支持图片的 read_file 在执行时一律返回“多模态工具未启用”。
test('桌面 read_file 默认启用多模态，图片作为附件返回而不是提示渠道开关', async () => {
  const f = await fixture(); await f.store.close();
  const app = await PlatformApplication.open({ dataDirectory: f.data,
    models: { generate: async () => ({ role: 'model', parts: [{ text: 'unused' }] }) } });
  try {
    const draft = await app.product.draft();
    const providerId = await draft.configs.createConfig({ type: 'openai', name: '图片夹具', enabled: true,
      url: 'http://127.0.0.1:1/v1', model: 'fixture', apiKey: '', timeout: 1000 });
    await app.product.save(draft);
    const project = path.join(f.root, '工作区'); await mkdir(project, { recursive: true });
    await writeFile(path.join(project, 'sample.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    const client = { actorId: 'owner', clientId: 'read-file-multimodal' };
    const added = await new ApplicationRouter(app).call(client, 'workspaces.add', { directory: project, name: '工作区' }) as { id: string };
    const tool = app.tools.catalog(['read_file']).entries.get('read_file')!.tool;
    const context = { runId: 'read-fixture', conversationId: 'conv', toolCallId: 'call', actorId: 'owner',
      workspace: app.workspace('owner', added.id, []), signal: new AbortController().signal,
      modelSelection: { providerId }, progress: () => {}, askUser: async () => { throw new Error('unused'); } } as unknown as ToolContext;
    const result = await tool.execute({ path: 'sample.jpg' }, context) as { success: boolean; attachments?: Array<{ mimeType: string }> };
    expect(result.success).toBe(true);
    expect(result.attachments?.[0]).toMatchObject({ mimeType: 'image/jpeg' });
  } finally { await app.close(); await f.cleanup(); }
});
