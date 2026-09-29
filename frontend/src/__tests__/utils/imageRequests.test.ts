import { expect, test } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import { ImageRequests } from '../../components/common/markdown/imageRequests';

test('不同消息共享四个读取名额，同路径复用，过期排队图片不再读取', async () => {
  const queue = new ImageRequests<string>();
  const completions: (() => void)[] = []; let active = 0, peak = 0, count = 0, current = true;
  const load = () => { count++; peak = Math.max(peak, ++active); return new Promise<string>(resolve => completions.push(() => { active--; resolve('data'); })); };
  const promises = Array.from({ length: 12 }, (_, i) => queue.request(String(i), load, () => current, () => i));
  promises.push(queue.request('0', load, () => current, () => 0));
  expect(count).toBe(4); current = false; completions.splice(0).forEach(done => done());
  await flushPromises(); await Promise.all(promises);
  expect(count).toBe(4); expect(peak).toBe(4);
});
