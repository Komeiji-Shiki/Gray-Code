import type { DirectoryEntry, WorkspaceDefinition } from '@graycode/contracts';
import type { PlatformApplication } from '../../../apps/server/src/application';
import { inputFileHandlers, workspaceFileSearchKey, WorkspaceFileSearches } from '../../../apps/server/src/workspace/uiFiles';

const deferred = <T,>() => {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};
const workspace = { id: 'project', name: 'fixture', deviceId: 'local', directory: '/fixture' } as WorkspaceDefinition;
const client = { actorId: 'owner', clientId: 'window' };
// 每层两个子目录，深度足够时没有匹配的查询会遍历很多目录。
function tree(depth: number) {
  const entries = new Map<string, DirectoryEntry[]>();
  const fill = (directory: string, level: number) => {
    const prefix = directory === '.' ? '' : directory + '/';
    const children: DirectoryEntry[] = [{ name: `file${level}.ts`, path: `${prefix}file${level}.ts`, kind: 'file' }];
    if (level < depth) for (const name of ['a', 'b']) { children.push({ name, path: prefix + name, kind: 'directory' }); fill(prefix + name, level + 1); }
    entries.set(directory, children);
  };
  fill('.', 0);
  return entries;
}
function fixture(list: (directory: string) => Promise<DirectoryEntry[]>) {
  const listed: string[] = [];
  const app = {
    workspace: () => workspace,
    files: {
      editorContext: () => ({ openFiles: [], activeFile: undefined }),
      list: (_: WorkspaceDefinition, directory: string) => { listed.push(directory); return list(directory); },
    },
  } as unknown as PlatformApplication;
  return { app, listed };
}

test('中止后遍历在下一个目录前退出，未中止的结果与原先的广度优先顺序和上限一致', async () => {
  const entries = tree(4);
  const { app } = fixture(async directory => entries.get(directory) ?? []);
  const result = await inputFileHandlers(app, client, workspace).searchWorkspaceFiles({ query: 'file', limit: 5 }) as { files: { path: string }[] };
  expect(result.files.map(file => file.path)).toEqual(['file0.ts', 'a/file1.ts', 'b/file1.ts', 'a/a/file2.ts', 'a/b/file2.ts']);

  const controller = new AbortController();
  let calls = 0;
  const slow = fixture(async directory => { if (++calls === 3) controller.abort(); return entries.get(directory) ?? []; });
  const search = inputFileHandlers(slow.app, client, workspace, controller.signal).searchWorkspaceFiles({ query: 'missing' });
  await expect(search).rejects.toMatchObject({ name: 'AbortError' });
  expect(slow.listed).toEqual(['.', 'a', 'b']);
});

test('同一客户端的相同查询复用在途结果，新查询立即中止旧搜索', async () => {
  const searches = new WorkspaceFileSearches();
  const first = deferred<string>(), second = deferred<string>();
  const signals: AbortSignal[] = [];
  const start = jest.fn((signal: AbortSignal) => { signals.push(signal); return signals.length === 1 ? first.promise : second.promise; });
  const key = workspaceFileSearchKey({ query: ' Src ', limit: 50 });
  expect(key).toBe(workspaceFileSearchKey({ query: 'src', limit: 50 }));
  const a = searches.run('window', key, start);
  expect(searches.run('window', key, start)).toBe(a);
  expect(start).toHaveBeenCalledTimes(1);
  // 不同客户端互不影响。
  void searches.run('other', key, async () => 'other');
  expect(signals[0].aborted).toBe(false);

  const b = searches.run('window', workspaceFileSearchKey({ query: 'src/m', limit: 50 }), start);
  expect(signals[0].aborted).toBe(true);
  expect(start).toHaveBeenCalledTimes(2);
  first.reject(signals[0].reason); second.resolve('latest');
  await expect(a).rejects.toBeDefined();
  await expect(b).resolves.toBe('latest');

  // 结束后不再复用旧结果；调用方判定上下文已变化时也重新搜索。
  const c = searches.run('window', key, async () => 'fresh');
  await expect(c).resolves.toBe('fresh');
  const pending = deferred<string>();
  const d = searches.run('window', key, () => pending.promise);
  const e = searches.run('window', key, async () => 'context changed', () => false);
  expect(e).not.toBe(d);
  pending.resolve('stale');
  await expect(e).resolves.toBe('context changed');
});
