import type { ToolContext } from '@graycode/core';
import { workspaceTools } from '../../../apps/server/src/workspace/tools';

const context = { workspace: { id: 'project', directory: '/project' }, signal: new AbortController().signal } as ToolContext;
function toolsFixture() {
  const entries = [
    { name: 'a.txt', path: 'a.txt', kind: 'file' },
    { name: 'nested', path: 'nested', kind: 'directory' },
    { name: 'node_modules', path: 'node_modules', kind: 'directory' },
  ];
  const files = {
    list: jest.fn(async (_workspace, directory) => directory === '.' ? entries : [{ name: 'b.txt', path: 'nested/b.txt', kind: 'file' }]),
    read: jest.fn(async (_workspace, file) => ({ text: file === 'a.txt' ? 'hit hit\r\nhit\r\n' : 'hit\nother', hash: 'hash' })),
  };
  const tools = workspaceTools(files as any, {} as any, {} as any);
  return { files, tools, search: tools.find(tool => tool.declaration.name === 'search_files')! };
}

describe('独立平台轻量搜索与工具选择说明', () => {
  test('按匹配行分页，去掉CR，跨目录续查且恰好一页不误报', async () => {
    const { search, files } = toolsFixture();
    const first = (await search.execute({ query: 'hit', limit: 2 }, context)).data as any;
    expect(first).toMatchObject({ offset: 0, nextOffset: 2, truncated: true });
    expect(first.matches.map((item: any) => item.text)).toEqual(['hit hit', 'hit']);
    const second = (await search.execute({ query: 'hit', limit: 1, offset: first.nextOffset }, context)).data as any;
    expect(second).toMatchObject({ offset: 2, truncated: false, matches: [{ path: 'nested/b.txt', line: 1, text: 'hit' }] });
    expect(second.nextOffset).toBeUndefined();
    const all = (await search.execute({ query: 'hit', limit: 100 }, context)).data as any;
    expect([...first.matches, ...second.matches]).toEqual(all.matches);
    expect(files.list.mock.calls.some(([, directory]) => directory === 'node_modules')).toBe(false);
  });

  test('严格字面量且没有关键词回退，超过末页为空', async () => {
    const { search } = toolsFixture();
    expect(((await search.execute({ query: 'hit other' }, context)).data as any).matches).toEqual([]);
    expect(((await search.execute({ query: 'hit|other' }, context)).data as any).matches).toEqual([]);
    expect((await search.execute({ query: 'hit', offset: 20 }, context)).data).toMatchObject({ matches: [], truncated: false });
  });

  test.each([-1, 0.5, Infinity, '1'])('无效 offset %s 被拒绝', async offset => {
    const { search } = toolsFixture();
    await expect(search.execute({ query: 'hit', offset }, context)).rejects.toThrow('offset');
  });

  test('扫描上限给出缩小目录建议，而不是无效续查位置', async () => {
    const files = {
      list: async () => Array.from({ length: 20_001 }, (_, index) => ({ name: `${index}.txt`, path: `${index}.txt`, kind: 'file' })),
      read: jest.fn(async () => ({ text: '', hash: 'hash' })),
    };
    const search = workspaceTools(files as any, {} as any, {} as any).find(tool => tool.declaration.name === 'search_files')!;
    const result = (await search.execute({ query: 'missing' }, context)).data as any;
    expect(result).toMatchObject({ scanned: 20_000, truncated: true, truncationReasons: ['scanLimit'] });
    expect(result.nextOffset).toBeUndefined();
    expect(result.continuationHint).toContain('narrow directory');
    expect(files.read).toHaveBeenCalledTimes(20_000);
  });

  test('文件读取中的取消不会被当作跳过的文件', async () => {
    const { files, search } = toolsFixture();
    const abort = new AbortController();
    files.read.mockImplementation(async () => { abort.abort(new Error('cancelled')); throw new Error('read cancelled'); });
    await expect(search.execute({ query: 'hit' }, { ...context, signal: abort.signal })).rejects.toThrow('cancelled');
  });

  test('声明说明互补能力和正确的进程会话来源', () => {
    const { tools } = toolsFixture();
    const description = (name: string) => tools.find(tool => tool.declaration.name === name)!.declaration.description;
    expect(description('workspace_files')).toContain('read_file');
    expect(description('workspace_files')).toContain('expectedHash');
    expect(description('workspace_files')).toContain('apply_diff');
    expect(description('search_files')).toContain('search_in_files');
    expect(description('run_command')).toContain('execute_command');
    expect(description('process_session')).toContain('taskId');
  });
});
