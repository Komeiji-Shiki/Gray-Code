import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ModelInput } from '@graycode/contracts';
import { PlatformApplication } from '../../../apps/server/src/application';
import { TokenCountService } from '../../../backend/modules/channel/TokenCountService';
import type { PromptPreviewResult } from '../../../shared/promptPreview';
import { fixture } from './fixtures';

describe('当前完整提示词的只读预览', () => {
  let f: Awaited<ReturnType<typeof fixture>>, app: PlatformApplication, providerId: string;
  let generated: ModelInput[];
  const client = { actorId: 'owner', clientId: 'preview-test' };
  beforeEach(async () => {
    f = await fixture(); await f.store.close(); generated = [];
    app = await PlatformApplication.open({ dataDirectory: f.data, documentsDirectory: f.root,
      models: { generate: async input => { generated.push(input); return { role: 'model', parts: [{ text: '完成验证。' }] }; } } });
    const draft = await app.product.draft();
    providerId = await draft.configs.createConfig({ name: '预览渠道', type: 'openai', url: 'http://127.0.0.1:1/v1', model: 'fixture-model',
      apiKey: '', enabled: true, contextManagementEnabled: false, timeout: 1000 });
    await draft.settings.savePromptMode({ id: 'preview-preset', name: '预览预设', template: '', promptAssemblyMode: 'entries', dynamicTemplate: '', dynamicTemplateEnabled: false,
      promptEntries: [
        { id: 'prefix', name: '固定要求', role: 'system', type: 'prompt', enabled: true, order: 0, content: '完整系统要求\n{{$CHARACTER_DESCRIPTION}}\n{{$WORLDBOOK_BEFORE_CHARACTER}}' },
        { id: 'files', name: '固定文件', role: 'user', type: 'prompt', enabled: true, order: 1, content: '{{$PINNED_FILES}}' },
        { id: 'chat-history', name: '历史', role: 'user', type: 'chat_history', enabled: true, order: 2, content: '' },
        { id: 'suffix', name: '最后要求', role: 'user', type: 'prompt', enabled: true, order: 3, content: '最后的预设条目。' },
      ] });
    await app.product.save(draft);
    const settings = app.settings.snapshot(); settings.settings.agents[0].toolNames = ['workspace_files'];
    settings.settings.workspaces.push({ id: 'preview-workspace', name: '预览项目', deviceId: 'local', directory: f.root });
    await app.settings.save({ settings: settings.settings, expectedRevision: settings.revision });
    await writeFile(path.join(f.root, 'context.txt'), '固定文件的完整内容。');
    await app.storage.createConversation({ id: 'preview-chat', actorId: 'owner', createdAt: Date.now(), updatedAt: Date.now(), workspaceId: 'preview-workspace',
      custom: { platformMode: 'chat', inputPinnedFiles: [{ id: 'pin', path: 'context.txt', workspaceUri: pathToFileURL(f.root).toString(), addedAt: 1, enabled: true }] } });
    await app.storage.appendHistory('preview-chat', [
      { id: 'original-user', role: 'user', isUserInput: true, parts: [{ text: '历史中的原始要求。' }] },
      { id: 'original-model', role: 'model', parts: [{ text: '之前的模型回复。' }] },
    ]);
  });
  afterEach(async () => { jest.restoreAllMocks(); await app.close(); await f.cleanup(); });
  const request = () => ({ conversationId: 'preview-chat', configId: providerId, modelOverride: 'fixture-model', promptModeId: 'preview-preset', message: '当前尚未发送的草稿。' });
  const preview = (data: Record<string, unknown> = request()) => app.productUi.call(client, 'prompt.preview', data) as Promise<PromptPreviewResult>;

  test('渠道图片上限保存后立即反映到预览，旧图片保留且切换渠道类型不丢失上限', async () => {
    const draft = await app.product.draft();
    await draft.configs.updateConfig(providerId, { maxInputImages: 1 }); await app.product.save(draft);
    expect((await app.product.channel(providerId))?.maxInputImages).toBe(1);
    await app.storage.appendHistory('preview-chat', [{ role: 'user', parts: [
      { text: '图片对应的文字', inlineData: { mimeType: 'image/png', data: 'OLDER_IMAGE' } },
      { inlineData: { mimeType: 'image/png', data: 'LATEST_IMAGE' } },
    ] }]);
    const before = await app.storage.readConversationState('preview-chat');
    const result = await preview();
    expect(result.notices.some(notice => notice.includes('最近 1 张图片'))).toBe(true);
    expect(JSON.stringify(result.body)).not.toContain('OLDER_IMAGE');
    expect(JSON.stringify(result.body)).toContain('LATEST_IMAGE'); expect(JSON.stringify(result.body)).toContain('图片对应的文字');
    expect(await app.storage.readConversationState('preview-chat')).toEqual(before);
    const changed = await app.product.draft(); await changed.configs.updateConfig(providerId, { type: 'anthropic' }); await app.product.save(changed);
    expect((await app.product.channel(providerId))?.maxInputImages).toBe(1);
  });

  test('包含历史、当前草稿、固定文件、工具和预设位置，实际发送复用同一内容', async () => {
    const before = await app.storage.readConversationState('preview-chat');
    const result = await preview();
    expect(await app.storage.readConversationState('preview-chat')).toEqual(before);
    expect(await app.storage.listRuns({})).toEqual([]); expect(generated).toEqual([]);
    const text = JSON.stringify(result.body);
    for (const content of ['完整系统要求', '历史中的原始要求', '之前的模型回复', '当前尚未发送的草稿', '固定文件的完整内容', 'workspace_files', '最后的预设条目']) expect({ content, included: text.includes(content) }).toMatchObject({ included: true });
    expect(result.estimatedTokens).toBeGreaterThan(0);
    const started = await app.productUi.call(client, 'chatStream', { ...request(), streamId: 'actual-send' }) as { runId: string };
    expect(await app.runtime.wait(started.runId)).toMatchObject({ status: 'completed' });
    expect(generated).toHaveLength(1);
    expect((await app.modelAdapter.preview(generated[0])).body).toEqual(result.body);
  });

  test('达到自动总结阈值时展示原始内容与变化说明，不调用总结或 Token API', async () => {
    const draft = await app.product.draft();
    await draft.configs.updateConfig(providerId, { contextManagementEnabled: true, contextManagementMode: 'summarize', maxContextTokens: 8000, contextThreshold: '50%' });
    await app.product.save(draft);
    await app.storage.appendHistory('preview-chat', Array.from({ length: 10 }, (_, index) => ({ id: `long-${index}`, role: index % 2 ? 'model' : 'user',
      isUserInput: index % 2 === 0, parts: [{ text: '需要在总结前保留的原始对话证据。'.repeat(1500) }] })));
    const before = await app.storage.readConversationState('preview-chat');
    const count = jest.spyOn(TokenCountService.prototype, 'countTokens').mockImplementation(async () => { throw new Error('预览不能调用远程计数'); });
    const result = await preview();
    expect(result.notices.join('')).toContain('自动总结'); expect(JSON.stringify(result.body)).toContain('需要在总结前保留的原始对话证据');
    expect(count).not.toHaveBeenCalled(); expect(generated).toEqual([]);
    expect(await app.storage.readConversationState('preview-chat')).toEqual(before); expect(await app.storage.listSnapshots('preview-chat')).toEqual([]);
  });

  test('角色和本次输入触发的世界书变量在预设内展开，激活结果可检查', async () => {
    const card = await app.characters.import({ name: '角色.json', data: Buffer.from(JSON.stringify({ spec: 'chara_card_v2', spec_version: '2.0', data: {
      name: '守灯人', description: '角色描述：守护海边灯塔。', personality: '冷静', scenario: '海岸', first_mes: '你好', mes_example: '',
      character_book: { name: '港口', entries: [{ id: 0, keys: ['灯塔'], content: '世界书：灯塔在每日黄昏点亮。', enabled: true, insertion_order: 1, position: 'before_char' }] },
    } })).toString('base64') });
    const state = await app.storage.readConversationState('preview-chat');
    await app.storage.commitConversation({ conversationId: 'preview-chat', expectedRevision: state.history.revision, expectedMetadataToken: state.metadataToken,
      metadata: { ...state.metadata, custom: { ...state.metadata.custom as object, platformMode: 'character', characterConfig: { kind: 'character', characterId: card.id,
        userName: '访客', persona: '', worldbookIds: [], regexIds: [], scanDepth: 2, worldTokenBudget: 1000, recursiveScan: false } } } });
    const before = await app.storage.readConversationState('preview-chat');
    const result = await preview({ ...request(), message: '灯塔什么时候亮？' });
    expect(JSON.stringify(result.body)).toContain('角色描述：守护海边灯塔'); expect(JSON.stringify(result.body)).toContain('世界书：灯塔在每日黄昏点亮');
    expect(JSON.stringify(result.character)).toContain('before_char'); expect(await app.storage.readConversationState('preview-chat')).toEqual(before);
  });

  test('新对话的草稿可以预览，不额外创建历史或任务', async () => {
    const before = await app.storage.listConversations();
    const result = await preview({ ...request(), conversationId: undefined });
    expect(JSON.stringify(result.body)).toContain('当前尚未发送的草稿');
    expect(await app.storage.listConversations()).toEqual(before); expect(await app.storage.listRuns({})).toEqual([]);
  });
});
