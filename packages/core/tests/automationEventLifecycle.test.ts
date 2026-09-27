import fs from 'node:fs';
import path from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { addAbortSignal, PassThrough } from 'node:stream';
import type { AutomationRecord } from '@graycode/contracts';
import type { PlatformApplication } from '../../../apps/server/src/application';
import { AutomationEventSources } from '../../../apps/server/src/automations/events';

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
let root: string, source: AutomationEventSources, record: AutomationRecord, fail: jest.Mock, receive: jest.Mock;
beforeEach(async () => {
  const temporary = path.resolve('.tmp'); await mkdir(temporary, { recursive: true });
  root = await mkdtemp(path.join(temporary, 'automation-events-')); await writeFile(path.join(root, 'input.txt'), '初始内容');
  record = { id: 'file-event', actorId: 'owner', kind: 'event', status: 'active', event: {
    trigger: { type: 'file_changed', workspaceId: 'project', path: 'input.txt', debounceMs: 100 }, busyPolicy: 'latest', restartPolicy: 'resume',
  } } as AutomationRecord;
  fail = jest.fn(async () => {});
  receive = jest.fn(async (_id, _event, change) => { record.eventSourceState = change.next; });
  source = new AutomationEventSources({ workspace: () => ({ id: 'project', directory: root }),
    files: { resolveGranted: async () => path.join(root, 'input.txt') }, publish() {},
  } as unknown as PlatformApplication, { records: () => [record], receive, baseline: async () => {}, fail });
});
afterEach(async () => {
  await source.close(); jest.restoreAllMocks();
  if (path.dirname(root) !== path.resolve('.tmp') || !path.basename(root).startsWith('automation-events-')) throw new Error('Unsafe fixture cleanup path.');
  await rm(root, { recursive: true, force: true });
});

function delayedRead() {
  const started = deferred(), stream = new PassThrough();
  const read = jest.spyOn(fs, 'createReadStream').mockImplementation((_file, options) => {
    const signal = typeof options === 'object' ? options?.signal : undefined;
    const value = read.mock.calls.length === 1 ? stream : new PassThrough();
    if (signal) addAbortSignal(signal, value);
    if (value !== stream) value.end('后续内容');
    started.resolve(); return value as unknown as fs.ReadStream;
  });
  return { started: started.promise, stream, read };
}

test('关闭会中止监听队列中的慢读取，且不将正常退出记录为事件失败', async () => {
  const delayed = delayedRead();
  const syncing = source.sync(); await delayed.started;
  const closing = source.close();
  try {
    await new Promise(resolve => setImmediate(resolve));
    expect(delayed.stream.destroyed).toBe(true);
    await Promise.all([syncing, closing]);
    expect(fail).not.toHaveBeenCalled(); expect(receive).not.toHaveBeenCalled();
  } finally { delayed.stream.end(); await Promise.all([syncing, closing]); }
});

test('尚在校验配置的文件读取也由关闭操作中止并等待结束', async () => {
  const delayed = delayedRead();
  const reading = source.sourceState('owner', record.event!); void reading.catch(() => {});
  await delayed.started;
  const closing = source.close();
  try {
    await new Promise(resolve => setImmediate(resolve));
    expect(delayed.stream.destroyed).toBe(true);
    await expect(reading).rejects.toMatchObject({ name: 'AbortError' });
    await closing; expect(delayed.stream.closed).toBe(true);
  } finally { delayed.stream.end(); await reading.catch(() => {}); await closing; }
});

test('实际文件流在打开句柄后取消，关闭会等待原生句柄释放', async () => {
  await writeFile(path.join(root, 'input.txt'), Buffer.alloc(512 * 1024, 97));
  const opened = deferred(), nativeRead = fs.createReadStream;
  let stream!: fs.ReadStream;
  jest.spyOn(fs, 'createReadStream').mockImplementation((file, options) => {
    stream = nativeRead(file, options); stream.once('open', opened.resolve); return stream;
  });
  const reading = source.sourceState('owner', record.event!); void reading.catch(() => {});
  await opened.promise;
  await source.close();
  await expect(reading).rejects.toMatchObject({ name: 'AbortError' });
  expect(stream.closed).toBe(true);
});

test('上一轮定期校验未完成时合并重叠请求，结束后仍允许新的校验', async () => {
  await source.sync(); receive.mockClear();
  const delayed = delayedRead();
  const first = source.reconcile(); await delayed.started;
  const overlapping = source.reconcile(); delayed.stream.end('后续内容');
  await Promise.all([first, overlapping]);
  expect(delayed.read).toHaveBeenCalledTimes(1);
  expect(receive).toHaveBeenCalledTimes(1);
  await source.reconcile(); expect(delayed.read).toHaveBeenCalledTimes(2);
  expect(receive).toHaveBeenCalledTimes(1);
});
