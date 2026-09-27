import path from 'node:path';
import { WorkspaceFiles } from '../../../apps/server/src/workspace/files';

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};
afterEach(() => jest.restoreAllMocks());

test('并发打开同一文档时，慢磁盘读取不能覆盖已经更新的草稿', async () => {
  const files = new WorkspaceFiles();
  const workspace = { id: 'project', name: 'fixture', deviceId: 'local', directory: path.resolve('.tmp') };
  jest.spyOn(files, 'resolve').mockResolvedValue(path.join(workspace.directory, 'fixture.txt'));
  const firstRead = deferred<{ text: string; hash: string }>(), secondRead = deferred<{ text: string; hash: string }>();
  const read = jest.spyOn(files as any, 'readAbsolute').mockReturnValueOnce(firstRead.promise).mockReturnValueOnce(secondRead.promise);
  const first = files.openDocument(workspace, 'fixture.txt', 'client');
  const second = files.openDocument(workspace, 'fixture.txt', 'client');
  await Promise.resolve();
  firstRead.resolve({ text: '磁盘原文', hash: 'original-hash' });
  const opened = await first;
  const edited = await files.updateDocument(workspace, 'fixture.txt', 'client', '用户新输入', opened.version);
  secondRead.resolve({ text: '磁盘原文', hash: 'original-hash' });
  await second;
  const current = await files.openDocument(workspace, 'fixture.txt', 'client');
  expect(current).toMatchObject({ text: '用户新输入', version: edited.version, dirty: true });
  expect(read).toHaveBeenCalledTimes(1);
});

test('同文件的打开队列仍按客户端分别建立草稿', async () => {
  const files = new WorkspaceFiles();
  const workspace = { id: 'project', name: 'fixture', deviceId: 'local', directory: path.resolve('.tmp') };
  jest.spyOn(files, 'resolve').mockResolvedValue(path.join(workspace.directory, 'fixture.txt'));
  jest.spyOn(files as any, 'readAbsolute').mockResolvedValue({ text: '磁盘原文', hash: 'original-hash' });
  const [first, second] = await Promise.all(['first', 'second'].map(client => files.openDocument(workspace, 'fixture.txt', client)));
  await files.updateDocument(workspace, 'fixture.txt', 'first', '第一窗口草稿', first.version);
  expect(await files.openDocument(workspace, 'fixture.txt', 'second')).toEqual(second);
  const draft = files.clientDocument('first', workspace.id, 'fixture.txt')!;
  expect(draft.text).toBe('第一窗口草稿');
  draft.text = '调用方修改副本';
  expect(files.clientDocument('first', workspace.id, 'fixture.txt')!.text).toBe('第一窗口草稿');
  expect(files.clientDocument('second', workspace.id, 'fixture.txt')).toEqual(second);
  expect(files.clientDocument('first', 'other-project', 'fixture.txt')).toBeUndefined();
});
