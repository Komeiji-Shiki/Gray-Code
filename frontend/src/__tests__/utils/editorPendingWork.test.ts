import { afterEach, expect, test, vi } from 'vitest';
import { PendingDocumentChanges } from '../../../../apps/client/src/pendingDocumentChanges';
import { ModelReadyWaiters } from '../../../../apps/client/src/modelReadyWaiters';

afterEach(() => vi.useRealTimers());
test('慢速宿主下连续输入只排队最新全文，发送中的修改仍按版本顺序完成', async () => {
  const jobs: (() => Promise<void>)[] = []; const sent: string[] = [];
  const buffer = new PendingDocumentChanges<object>((_doc, job) => { jobs.push(job); }, async (_doc, text) => { sent.push(text); });
  const doc = {};
  for (let i = 1; i <= 100; i++) buffer.push(doc, String(i));
  expect(jobs).toHaveLength(1); await jobs.shift()!(); expect(sent).toEqual(['100']);
  buffer.push(doc, '101'); await jobs.shift()!(); expect(sent).toEqual(['100', '101']);
});
test('保存边界冻结旧快照，保存之后的输入保留在保存操作之后', async () => {
  const jobs: (() => Promise<void>)[] = []; const sent: string[] = [];
  const buffer = new PendingDocumentChanges<object>((_doc, job) => { jobs.push(job); }, async (_doc, text) => { sent.push(text); });
  const doc = {};
  buffer.push(doc, 'before'); buffer.barrier(doc); jobs.push(async () => { sent.push('[save]'); }); buffer.push(doc, 'after');
  await jobs.shift()!(); // 旧任务不得移除保存之后的新待发快照。
  buffer.push(doc, 'after-2');
  while (jobs.length) await jobs.shift()!();
  expect(sent).toEqual(['before', '[save]', 'after-2']);
});
test('不同文档独立合并，失败后后续编辑仍能进入队列', async () => {
  const jobs: (() => Promise<void>)[] = [];
  const apply = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
  const buffer = new PendingDocumentChanges<object>((_doc, job) => { jobs.push(job); }, apply);
  const a = {}, b = {}; buffer.push(a, 'a'); buffer.push(b, 'b');
  await expect(jobs.shift()!()).rejects.toThrow('offline'); buffer.push(a, 'retry');
  while (jobs.length) await jobs.shift()!();
  expect(apply.mock.calls.map(([_doc, text]) => text)).toEqual(['a', 'b', 'retry']);
});
test('同一模型的并发等待全部完成，解除计时器', async () => {
  vi.useFakeTimers(); const waiters = new ModelReadyWaiters(() => new Error('not ready'));
  const a = waiters.wait('file'), b = waiters.wait('file'); expect(a).toBe(b);
  waiters.resolve('file', 42); await expect(Promise.all([a, b])).resolves.toEqual([42, 42]);
  expect(vi.getTimerCount()).toBe(0); waiters.dispose();
});
test('超时可重试，卸载拒绝所有待处理等待并清理计时器', async () => {
  vi.useFakeTimers(); const waiters = new ModelReadyWaiters(() => new Error('not ready'), 100);
  const first = expect(waiters.wait('file')).rejects.toThrow('not ready'); await vi.advanceTimersByTimeAsync(100); await first;
  const again = waiters.wait('file'); waiters.resolve('file', 7); await expect(again).resolves.toBe(7);
  const pending = expect(waiters.wait('other')).rejects.toThrow('not ready'); waiters.dispose(); await pending;
  expect(vi.getTimerCount()).toBe(0);
});
