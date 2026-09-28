import path from 'node:path';
import { mkdir, mkdtemp, rm, writeFile, symlink } from 'node:fs/promises';
import type { ToolContext } from '@graycode/core';
import type { PlatformApplication } from '../../../apps/server/src/application';
import { WorkspaceFiles } from '../../../apps/server/src/workspace/files';
import { NodeFileHost } from '../../../apps/server/src/workspace/fileHost';
import { createLiteralSearchTool } from '../../../apps/server/src/workspace/literalSearchTool';
import { createSearchDeclaration } from '../../../backend/tools/search/declarationRuntime';
import { createFindFilesRuntime } from '../../../backend/tools/search/findFilesRuntime';
import { DEFAULT_SEARCH_IN_FILES_CONFIG, DEFAULT_FIND_FILES_CONFIG } from '../../../backend/modules/settings/types';
import { createGitIgnoreFilter } from '../../../backend/tools/search/gitIgnoreFilter';

let directory: string;
beforeEach(async () => {
  await mkdir('.tmp', { recursive: true });
  directory = await mkdtemp(path.resolve('.tmp', 'search-ignore-'));
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
async function put(file: string, text = 'needle') {
  await mkdir(path.dirname(path.join(directory, file)), { recursive: true });
  await writeFile(path.join(directory, file), text);
}
function fixture(roots?: Array<{ name: string; directory: string }>) {
  const app = { files: new WorkspaceFiles(), product: { runtimeSettings: () => ({
    getSearchInFilesConfig: () => DEFAULT_SEARCH_IN_FILES_CONFIG,
    getFindFilesConfig: () => DEFAULT_FIND_FILES_CONFIG,
  }) } } as unknown as PlatformApplication;
  const context = { actorId: 'owner', runId: 'search-ignore', signal: new AbortController().signal,
    workspace: { id: 'project', name: 'Fixture', directory, roots, deviceId: 'local' },
    progress: () => {}, askUser: async () => { throw new Error('unused'); } } satisfies ToolContext;
  const host = new NodeFileHost(app, context);
  return { host, basic: createLiteralSearchTool(host), advanced: createSearchDeclaration(host).createSearchInFilesTool(), find: createFindFilesRuntime(host).createFindFilesTool() };
}

test('三种查找遵循相同配置与嵌套gitignore，显式纳入不进入.git或符号链接', async () => {
  await Promise.all([
    put('.gitignore', '.tmp/\n/root-only.txt\n*.log\nblocked/\n'),
    put('src/.gitignore', '!keep.log\n/local.txt\n'),
    ...['src/main.txt', 'src/keep.log', 'src/deep/local.txt', 'src/root-only.txt', 'root-only.txt', 'src/omit.log', 'src/local.txt', '.tmp/a.txt', 'dist/a.txt', '.git/config', 'blocked/child.txt'].map(file => put(file)),
    put('blocked/.gitignore', '!child.txt'),
  ]);
  await symlink(path.join(directory, 'src'), path.join(directory, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const expected = ['src/deep/local.txt', 'src/keep.log', 'src/main.txt', 'src/root-only.txt'];
  const { basic, advanced, find } = fixture();
  expect((await basic.handler({ query: 'needle' })).data.matches.map((m: any) => m.path).sort()).toEqual(expected);
  expect((await advanced.handler({ query: 'needle' })).data.results.map((m: any) => m.file).sort()).toEqual(expected);
  expect((await find.handler({ patterns: ['**/*.txt', '**/*.log'] })).data.results.flatMap((m: any) => m.files).sort()).toEqual(expected);
  for (const result of [await basic.handler({ query: 'needle', includeIgnored: true }), await advanced.handler({ query: 'needle', includeIgnored: true })]) {
    const paths = (result.data.matches ?? result.data.results).map((m: any) => m.path ?? m.file);
    expect(paths).toEqual(expect.arrayContaining(['.tmp/a.txt', 'dist/a.txt', 'blocked/child.txt', 'src/omit.log', 'root-only.txt']));
    expect(paths.some((p: string) => p.startsWith('.git/') || p.startsWith('linked/'))).toBe(false);
    expect(result.data.respectsGitIgnore).toBe(false);
  }
  const all = await find.handler({ patterns: ['**/*.txt'], includeIgnored: true, exclude: '**/dist/**' });
  expect(all.data.results[0].files).toContain('.tmp/a.txt');
  expect(all.data.results[0].files).not.toContain('dist/a.txt');
});

test('从子目录或单文件开始仍加载祖先规则，不读取工作区外gitignore', async () => {
  await Promise.all([put('.gitignore', 'blocked/\n*.log'), put('blocked/.gitignore', '!child.txt'), put('blocked/child.txt'), put('src/a.log'), put('src/b.txt')]);
  const { basic, advanced } = fixture();
  expect((await basic.handler({ query: 'needle', directory: 'blocked' })).data.matches).toEqual([]);
  expect((await basic.handler({ query: 'needle', directory: 'src' })).data.matches.map((m: any) => m.path)).toEqual(['src/b.txt']);
  expect((await advanced.handler({ query: 'needle', path: 'src/a.log' })).data.results).toEqual([]);
  expect((await advanced.handler({ query: 'needle', path: 'src/a.log', includeIgnored: true })).data.results).toHaveLength(1);
});

test('多根独立加载规则，分页跨根无重复遗漏，查询之后的规则变化生效', async () => {
  await Promise.all([put('one/.gitignore', 'hidden.txt'), put('one/hidden.txt'), put('one/a.txt'), put('two/hidden.txt'), put('two/b.txt')]);
  const roots = ['one', 'two'].map(name => ({ name, directory: path.join(directory, name) }));
  const { basic } = fixture(roots);
  const full = (await basic.handler({ query: 'needle' })).data.matches;
  expect(full.map((m: any) => m.path).sort()).toEqual(['@one/a.txt', '@two/b.txt', '@two/hidden.txt']);
  const paged: unknown[] = [];
  for (let offset = 0; offset < full.length; offset++) paged.push(...(await basic.handler({ query: 'needle', offset, limit: 1 })).data.matches);
  expect(paged).toEqual(full);
  await put('one/.gitignore', '*.txt');
  expect((await basic.handler({ query: 'needle' })).data.matches.map((m: any) => m.path)).not.toContain('@one/a.txt');
});

test('忽略规则读取错误可见，目录过滤器只加载一次并跳过被排除父目录', async () => {
  const read = jest.fn(async (file: string) => file === path.join(directory, '.gitignore') ? 'blocked/\n*.log' : undefined);
  const filter = createGitIgnoreFilter(directory, read);
  const root = await filter(directory);
  expect(root!('a.log', false)).toBe(true);
  expect(await filter(path.join(directory, 'blocked'))).toBeNull();
  await filter(directory);
  expect(read).toHaveBeenCalledTimes(1);
  const broken = createGitIgnoreFilter(directory, async () => { throw new Error('EACCES'); });
  await expect(broken(directory)).rejects.toThrow('EACCES');
});

test('替换与搜索共用忽略规则，显式纳入只扩大已审阅文件范围', async () => {
  await Promise.all([put('.gitignore', '.tmp/'), put('src/a.txt'), put('.tmp/b.txt')]);
  const { host, advanced } = fixture();
  const review = jest.spyOn(host, 'review').mockResolvedValue({ wasAccepted: true, wasInterrupted: false, diffContentId: 'fixture', autoSaveError: undefined, pendingDiffId: 'fixture' });
  const ordinary = await advanced.handler({ mode: 'replace', query: 'needle', replace: 'updated' });
  expect(ordinary.data).toMatchObject({ filesModified: 1, includeIgnored: false, respectsGitIgnore: true });
  expect(review.mock.calls.map(([input]) => input.absolutePath)).toEqual([path.join(directory, 'src/a.txt')]);
  review.mockClear();
  const explicit = await advanced.handler({ mode: 'replace', query: 'needle', replace: 'updated', includeIgnored: true });
  expect(explicit.data).toMatchObject({ filesModified: 2, includeIgnored: true, respectsGitIgnore: false });
  expect(review.mock.calls.map(([input]) => input.absolutePath).sort()).toEqual([path.join(directory, 'src/a.txt'), path.join(directory, '.tmp/b.txt')].sort());
});
