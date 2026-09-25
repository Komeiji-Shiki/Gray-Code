import { PlatformApplication } from '../../../apps/server/src/application';
import { ApplicationRouter } from '../../../apps/server/src/transport/router';
import { fixture } from './fixtures';

function image(name: string, content: string) {
  return { name, mimeType: 'image/png', data: Buffer.from(content).toString('base64') };
}

async function open() {
  const f = await fixture(); await f.store.close();
  const app = await PlatformApplication.open({ dataDirectory: f.data });
  const router = new ApplicationRouter(app);
  const owner = { actorId: 'owner', clientId: 'preview-ui' };
  const published: Record<string, any>[] = [];
  app.subscribe(event => { if (event.type === 'workspace.preview') published.push(event); });
  return {
    app,
    published,
    call: (type: string, data = {}) => router.call(owner, 'ui.request', { type, data }) as Promise<any>,
    finish: async () => { await app.close(); await f.cleanup(); },
  };
}

test('图片组预览：批量注册、组信息读取与组内切换', async () => {
  const f = await open();
  try {
    const first = image('one.png', 'first-image');
    const second = image('two.png', 'second-image');
    const third = image('three.png', 'third-image');
    await f.call('previewAttachment', { gallery: [first, second, third], index: 1 });
    expect(f.published.at(-1)?.previewId).toBeTruthy();
    const current = await f.call('preview.get', { id: f.published.at(-1)!.previewId });
    expect(current.title).toBe('two.png');
    expect(current.data).toBe(second.data);
    expect(current.group.index).toBe(1);
    expect(current.group.items.map((item: any) => item.title)).toEqual(['one.png', 'two.png', 'three.png']);
    // 组内任意图片都能按 id 取回原数据，供查看器左右切换。
    const sibling = await f.call('preview.get', { id: current.group.items[2].id });
    expect(sibling.data).toBe(third.data);
    expect(sibling.group.index).toBe(2);
    // 单次注册只广播当前查看的一张。
    expect(f.published).toHaveLength(1);
  } finally { await f.finish(); }
});

test('单图与文本预览保持单条路径，不携带组信息', async () => {
  const f = await open();
  try {
    const solo = image('solo.png', 'solo-image');
    await f.call('previewAttachment', { name: solo.name, mimeType: solo.mimeType, data: solo.data });
    const single = await f.call('preview.get', { id: f.published.at(-1)!.previewId });
    expect(single.group).toBeUndefined();
    expect(single.data).toBe(solo.data);
    await f.call('showContextContent', { title: 'notes', content: '文本预览', language: 'markdown' });
    const text = await f.call('preview.get', { id: f.published.at(-1)!.previewId });
    expect(text.content).toBe('文本预览');
    expect(text.group).toBeUndefined();
  } finally { await f.finish(); }
});

test('容量淘汰以组为单位：最早的组整体失效，最新注册保持可用', async () => {
  const f = await open();
  try {
    const ids: string[] = [];
    for (let i = 0; i < 8; i++) {
      await f.call('previewAttachment', { name: `p${i}.png`, mimeType: 'image/png', data: image('p', `payload-${i}`).data });
      ids.push(f.published.at(-1)!.previewId);
    }
    // 第 9 组注册后越过组数上限，最早的单项组被整体淘汰。
    await f.call('previewAttachment', { gallery: [image('g1', 'group-one'), image('g2', 'group-two')], index: 0 });
    const latest = f.published.at(-1)!.previewId;
    await expect(f.call('preview.get', { id: ids[0] })).rejects.toThrow('预览已经过期');
    await f.call('preview.get', { id: ids[7] });
    const current = await f.call('preview.get', { id: latest });
    expect(current.group.items).toHaveLength(2);
  } finally { await f.finish(); }
});

test('图片组在淘汰中整体保留或整体删除', async () => {
  const f = await open();
  try {
    const groups: string[][] = [];
    for (let i = 0; i < 8; i++) {
      await f.call('previewAttachment', { gallery: [image(`a${i}`, `pair-${i}-a`), image(`b${i}`, `pair-${i}-b`)], index: 0 });
      const current = await f.call('preview.get', { id: f.published.at(-1)!.previewId });
      groups.push(current.group.items.map((item: any) => item.id));
    }
    expect(groups[0]).toHaveLength(2);
    await f.call('previewAttachment', { gallery: [image('x', 'x'), image('y', 'y')], index: 1 });
    // 越过上限后最早的组两张图一起失效，第二组不受影响。
    await expect(f.call('preview.get', { id: groups[0][0] })).rejects.toThrow('预览已经过期');
    await expect(f.call('preview.get', { id: groups[0][1] })).rejects.toThrow('预览已经过期');
    await f.call('preview.get', { id: groups[1][0] });
  } finally { await f.finish(); }
});

test('图片组输入校验：索引越界与坏 Base64 被拒绝', async () => {
  const f = await open();
  try {
    await expect(f.call('previewAttachment', { gallery: [image('a', 'aaa')], index: 2 })).rejects.toThrow('预览数据无效');
    await expect(f.call('previewAttachment', { gallery: [{ name: 'bad.png', mimeType: 'image/png', data: '!!!!' }], index: 0 }))
      .rejects.toThrow('附件 Base64 格式无效');
    await expect(f.call('previewAttachment', { gallery: 'nope' })).rejects.toThrow('附件超过 50 MiB 或格式无效');
  } finally { await f.finish(); }
});

test('组内单张关闭后组信息同步收缩，其他入口仍可读取', async () => {
  const f = await open();
  try {
    await f.call('previewAttachment', { gallery: [image('a', 'aaa'), image('b', 'bbb')], index: 0 });
    const current = await f.call('preview.get', { id: f.published.at(-1)!.previewId });
    const [firstId, secondId] = current.group.items.map((item: any) => item.id);
    await f.call('preview.close', { id: secondId });
    const refreshed = await f.call('preview.get', { id: firstId });
    expect(refreshed.group.items.map((item: any) => item.id)).toEqual([firstId]);
    expect(refreshed.group.index).toBe(0);
    await expect(f.call('preview.get', { id: secondId })).rejects.toThrow('预览已经过期');
  } finally { await f.finish(); }
});
