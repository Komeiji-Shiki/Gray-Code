import { metadata, message, fixture } from './fixtures';

describe('存储线程复用已解码的消息正文', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  beforeEach(async () => { f = await fixture(); });
  afterEach(async () => { await f.cleanup(); });

  test('重复读取、局部修改、替换和分叉都返回各自真实的内容，读取结果互不共享对象', async () => {
    await f.store.createConversation(metadata('cached'));
    // 相同正文在不同位置出现，验证按内容共享时消息身份和时间戳仍按各自位置恢复。
    const original = Array.from({ length: 300 }, (_, index) => ({ ...message(index, index % 3 ? `正文 ${index}` : '重复的正文'), id: `m${index}` }));
    await f.store.appendHistory('cached', original);
    const first = (await f.store.readFullHistory('cached')).messages;
    expect(first).toEqual(original);
    first[0].parts[0].text = '调用方修改的副本';
    expect((await f.store.readFullHistory('cached')).messages).toEqual(original);

    await f.store.forkConversation('cached', metadata('fork'), { beforeIndex: 200 });
    const state = await f.store.readConversationState('cached');
    await f.store.commitConversation({ conversationId: 'cached', expectedRevision: state.history.revision,
      messageUpdates: [{ index: 3, message: { ...original[3], parts: [{ text: '修订后的正文' }] } }] });
    const updated = (await f.store.readFullHistory('cached')).messages;
    expect(updated[3].parts).toEqual([{ text: '修订后的正文' }]);
    expect(updated[6]).toEqual(original[6]);
    expect((await f.store.readFullHistory('fork')).messages).toEqual(original.slice(0, 200));

    await f.store.replaceHistory('cached', [original[1], { ...original[2], parts: [{ text: '替换后的历史' }] }]);
    expect((await f.store.readFullHistory('cached')).messages).toEqual([original[1], { ...original[2], parts: [{ text: '替换后的历史' }] }]);
    expect((await f.store.readHistory('fork', { offset: 3, limit: 1 })).messages).toEqual([original[3]]);
  });

  test('超过缓存上限的大正文和大量历史仍能完整读取', async () => {
    await f.store.createConversation(metadata('large'));
    const large = Array.from({ length: 12 }, (_, index) => ({ ...message(index, `大正文 ${index} ` + 'x'.repeat(1_500_000)), id: `large-${index}` }));
    await f.store.appendHistory('large', large);
    for (let pass = 0; pass < 2; pass++) {
      const read = (await f.store.readFullHistory('large')).messages;
      expect(read.map(item => item.parts[0].text?.length)).toEqual(large.map(item => item.parts[0].text?.length));
      expect(read.map(item => item.id)).toEqual(large.map(item => item.id));
    }
  });
});
