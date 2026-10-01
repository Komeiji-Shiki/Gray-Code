import path from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { ToolContext } from '@graycode/core';
import type { PlatformApplication } from '../../../apps/server/src/application';
import { WorkspaceFiles } from '../../../apps/server/src/workspace/files';
import { NodeFileHost } from '../../../apps/server/src/workspace/fileHost';
import { createLiteralSearchTool } from '../../../apps/server/src/workspace/literalSearchTool';
import { createSearchDeclaration } from '../../../backend/tools/search/declarationRuntime';
import { DEFAULT_SEARCH_IN_FILES_CONFIG } from '../../../backend/modules/settings/types';

let directory: string;
beforeEach(async () => {
  await mkdir('.tmp', { recursive: true });
  directory = await mkdtemp(path.resolve('.tmp', 'search-pages-'));
  await mkdir(path.join(directory, 'nested'));
  await Promise.all([
    writeFile(path.join(directory, 'a.ts'), 'hit first\r\nhit second\r\n'),
    writeFile(path.join(directory, 'nested', 'b.ts'), 'other\nhit third\n'),
  ]);
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

function tools(maxFindFiles = DEFAULT_SEARCH_IN_FILES_CONFIG.maxFindFiles) {
  const files = new WorkspaceFiles();
  const app = { files, product: { runtimeSettings: () => ({
    getSearchInFilesConfig: () => ({ ...DEFAULT_SEARCH_IN_FILES_CONFIG, maxFindFiles }),
    getFindFilesConfig: () => ({ excludePatterns: [] }),
  }) } } as unknown as PlatformApplication;
  const context = { actorId: 'owner', runId: 'search-pages', signal: new AbortController().signal,
    workspace: { id: 'project', name: 'Fixture', directory, deviceId: 'local' },
    progress: () => {}, askUser: async () => { throw new Error('unused'); } } satisfies ToolContext;
  const advanced = createSearchDeclaration(new NodeFileHost(app, context)).createSearchInFilesTool();
  const basic = createLiteralSearchTool(new NodeFileHost(app, context));
  return { advanced, basic };
}

test('真实 Node 文件宿主中，两种搜索分页无重复、无遗漏并保留各自顺序', async () => {
  const { advanced, basic } = tools();
  const variants = [
    { query: (offset: number, limit: number) => advanced.handler({ query: 'hit', offset, maxResults: limit }), key: 'results' },
    { query: (offset: number, limit: number) => basic.handler({ query: 'hit', offset, limit }), key: 'matches' },
  ];
  for (const variant of variants) {
    const complete = (await variant.query(0, 100)).data as any;
    const paged: unknown[] = [];
    let offset = 0;
    for (let page = 0; page < 4; page++) {
      const result = (await variant.query(offset, 1)).data as any;
      paged.push(...result[variant.key]);
      if (result.nextOffset === undefined) { expect(result.truncated).toBe(false); break; }
      expect(result.nextOffset).toBeGreaterThan(offset);
      offset = result.nextOffset;
    }
    expect(paged).toEqual(complete[variant.key]);
    expect(paged).toHaveLength(3);
  }
});

test('真实流式宿主不受旧 maxFindFiles 限制，匹配与分页可到达后面的目录', async () => {
  const { advanced } = tools(1);
  const found = (await advanced.handler({ query: 'hit third', pattern: '**/*.ts' })).data;
  expect(found).toMatchObject({ count: 1, truncated: false });
  expect(found.results[0].file).toBe('nested/b.ts');
  const next = (await advanced.handler({ query: 'hit', offset: 2, maxResults: 1 })).data;
  expect(next).toMatchObject({ count: 1, offset: 2, truncated: false });
  expect(next.results[0].file).toBe('nested/b.ts');
});
