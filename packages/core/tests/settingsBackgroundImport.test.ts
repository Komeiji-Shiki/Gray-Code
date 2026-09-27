import { PlatformApplication } from '../../../apps/server/src/application';
import { ApplicationRouter } from '../../../apps/server/src/transport/router';
import { SettingsTransfer } from '../../../apps/server/src/settings/transfer';
import { fixture } from './fixtures';

const originalId = '11111111-1111-4111-8111-111111111111';
const replacementId = '22222222-2222-4222-8222-222222222222';
const image = (id = originalId, text = 'fixture') => ({ id, name: text, mimeType: 'image/png',
  url: `graycode://app/assets/background/${id}`, dataUrl: `data:image/png;base64,${Buffer.from(text).toString('base64')}`,
  thumbnail: '', width: 1, height: 1 });

describe('背景资源随设置导入事务提交', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  let app: PlatformApplication;
  let router: ApplicationRouter;
  const ui = (type: string, data = {}, clientId = 'import-client') =>
    router.call({ actorId: 'owner', clientId }, 'ui.request', { type, data }) as Promise<any>;
  const open = async () => {
    app = await PlatformApplication.open({ dataDirectory: f.data, models: { generate: async () => { throw new Error('本测试不得调用模型。'); } } });
    router = new ApplicationRouter(app);
  };
  const payload = (backgrounds = [image()]) => ({ format: 'graycode-platform', version: 1,
    settings: { appearance: { ...app.settings.snapshot().settings.appearance, backgroundImage: backgrounds[0]?.url ?? '' } }, backgrounds });
  beforeEach(async () => { f = await fixture(); await f.store.close(); await open(); await ui('ui.settings.begin'); });
  afterEach(async () => { jest.restoreAllMocks(); await app.close(); await f.cleanup(); });

  test('导入可预览、可导出，其他客户端看不到未保存图片，撤销后没有资源记录', async () => {
    await ui('settings.importData', { value: payload() });
    const pictures = await ui('appearance.images.list');
    expect(pictures).toHaveLength(1);
    expect(pictures[0].url).toMatch(/^data:image\/png;base64,.+#/);
    expect((await ui('platform.settings.get')).appearance.backgroundImage).toBe(pictures[0].url);
    expect(await ui('appearance.images.list', {}, 'other-client')).toEqual([]);
    expect(await app.images.list()).toEqual([]);
    const exported = await ui('settings.exportData');
    expect(exported.backgrounds[0].dataUrl).toBe(image().dataUrl);
    expect(exported.settings.appearance.backgroundImage).toBe(exported.backgrounds[0].url);
    await ui('ui.settings.discard');
    expect(await ui('appearance.images.list')).toEqual([]);
    expect(await app.storage.listRecords('appearance-images')).toEqual([]);
    expect(await app.storage.listRecords('appearance-image-info')).toEqual([]);
  });

  test('保存同时提交资源和设置，清除临时字段，重启后仍可读取', async () => {
    await ui('settings.importData', { value: payload() });
    const [staged] = await ui('appearance.images.list');
    await ui('ui.settings.save');
    expect(app.settings.snapshot().settings.appearance.backgroundImage).toBe(`graycode://app/assets/background/${staged.id}`);
    expect(await app.images.get(staged.id)).toMatchObject({ name: 'fixture' });
    expect(await app.storage.getRecord('product-settings', 'main')).not.toHaveProperty('pendingBackgroundImages');
    await app.close(); await open();
    expect(Buffer.from((await app.images.get(staged.id))!.bytes).toString()).toBe('fixture');
  });

  test('便携替换遇到设置验证失败时，原图和原元数据均保留，修正后同批替换', async () => {
    await app.images.add(image(), originalId);
    const draft = await app.product.draft();
    await new SettingsTransfer(app).import(draft, payload([image(replacementId, 'replacement')]), true);
    draft.app.version = 2 as any;
    await expect(app.product.save(draft)).rejects.toThrow('Unsupported settings version');
    expect(await app.images.get(originalId)).not.toBeNull();
    expect(await app.images.get(replacementId)).toBeNull();
    expect((await app.images.list()).map(value => value.id)).toEqual([originalId]);
    draft.app.version = 1;
    await app.product.save(draft);
    expect(await app.images.get(originalId)).toBeNull();
    expect(Buffer.from((await app.images.get(replacementId))!.bytes).toString()).toBe('replacement');
  });

  test('过期草稿保存失败不会写入图片，重新导入后可正常保存', async () => {
    await ui('settings.importData', { value: payload() });
    const other = await app.product.draft(); other.app.appearance.fontSize = 18; await app.product.save(other);
    await expect(ui('ui.settings.save')).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    expect(await app.images.list()).toEqual([]);
    await ui('ui.settings.discard');
    await ui('settings.importData', { value: payload() }); await ui('ui.settings.save');
    expect(await app.images.list()).toHaveLength(1);
  });

  test('同 ID 的便携图片替换在事务写入失败时保留原图，原草稿可重试', async () => {
    await app.images.add(image(), originalId);
    const draft = await app.product.draft();
    await new SettingsTransfer(app).import(draft, payload([image(originalId, 'replacement')]), true);
    const commit = jest.spyOn(app.storage, 'commitRecords').mockRejectedValueOnce(new Error('fixture storage failure'));
    await expect(app.product.save(draft)).rejects.toThrow('fixture storage failure');
    expect(Buffer.from((await app.images.get(originalId))!.bytes).toString()).toBe('fixture');
    expect((await app.images.list())[0].name).toBe('fixture');
    commit.mockRestore();
    await app.product.save(draft);
    expect(Buffer.from((await app.images.get(originalId))!.bytes).toString()).toBe('replacement');
  });

  test('同内容图片保留不同身份，复制草稿后仍提交选中的图片', async () => {
    const first = image(originalId), second = image(replacementId);
    const draft = await app.product.draft();
    const value = payload([first, second]); value.settings.appearance.backgroundImage = second.url;
    await new SettingsTransfer(app).import(draft, value);
    const pictures = await app.images.list(draft.value.pendingBackgroundImages);
    expect(pictures[0].url).not.toBe(pictures[1].url);
    const copied = await app.product.draft(draft); await app.product.save(copied);
    expect(app.settings.snapshot().settings.appearance.backgroundImage).toBe(`graycode://app/assets/background/${pictures[1].id}`);
  });

  test('导入图片可在当前草稿中重命名和删除，撤销不产生资源', async () => {
    await ui('settings.importData', { value: payload() });
    const [staged] = await ui('appearance.images.list');
    await ui('appearance.images.rename', { id: staged.id, name: '新名称' });
    expect((await ui('appearance.images.list'))[0].name).toBe('新名称');
    await expect(ui('appearance.images.remove', { id: staged.id })).rejects.toThrow('设置草稿仍在使用');
    const settings = await ui('platform.settings.get'); settings.appearance.backgroundImage = '';
    await ui('platform.settings.update', { settings });
    await ui('appearance.images.remove', { id: staged.id });
    await ui('ui.settings.save');
    expect(await app.images.list()).toEqual([]);
  });
});
