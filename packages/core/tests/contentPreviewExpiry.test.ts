import type { PlatformApplication } from '../../../apps/server/src/application';
import { ContentPreviews } from '../../../apps/server/src/workspace/previews';

const client = { actorId: 'owner', clientId: 'preview-client' };
let previews: ContentPreviews, currentId: string;
beforeEach(() => {
  jest.useFakeTimers({ now: 1_000_000 });
  previews = new ContentPreviews({ requireOwner() {}, publish(event: { previewId: string }) { currentId = event.previewId; } } as unknown as PlatformApplication);
});
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });
// 返回过期错误并不证明正文已释放，检查服务仍持有的缓存条目。
const retained = () => ((previews as any).values as Map<string, unknown>).size;

test('没有后续预览请求时，到期也会释放文本和整组附件', () => {
  previews.show(client, { content: '临时正文' }, false);
  previews.show(client, { gallery: [{ name: 'a', data: 'YQ==' }, { name: 'b', data: 'Yg==' }], index: 0 }, true);
  expect(retained()).toBe(3);
  const id = currentId;
  jest.advanceTimersByTime(600_001);
  expect(() => previews.get(client, id)).toThrow('预览已经过期');
  expect(retained()).toBe(0);
  expect(jest.getTimerCount()).toBe(0);
});

test('较早预览到期不影响新图片组，关闭最后一项后撤销清理计时器', () => {
  previews.show(client, { content: '较早正文' }, false); const old = currentId;
  jest.advanceTimersByTime(60_000);
  previews.show(client, { gallery: [{ name: 'a', data: 'YQ==' }, { name: 'b', data: 'Yg==' }], index: 0 }, true);
  expect(jest.getTimerCount()).toBe(1);
  const current = previews.get(client, currentId);
  if (!('group' in current)) throw new Error('图片组信息缺失');
  const ids = current.group.items.map(item => item.id);
  jest.advanceTimersByTime(540_001);
  expect(() => previews.get(client, old)).toThrow('预览已经过期');
  expect(retained()).toBe(2);
  expect(previews.get(client, ids[1]).data).toBe('Yg==');
  for (const id of ids) previews.close(client, id);
  expect(retained()).toBe(0);
  expect(jest.getTimerCount()).toBe(0);
});

test('释放服务时立即清空正文与计时器，迟到打开请求不重新建立缓存', () => {
  previews.show(client, { content: '临时正文' }, false);
  previews.dispose();
  expect(retained()).toBe(0); expect(jest.getTimerCount()).toBe(0);
  expect(() => previews.show(client, { content: '迟到请求' }, false)).toThrow('预览服务已经关闭');
  expect(retained()).toBe(0); expect(jest.getTimerCount()).toBe(0);
});
