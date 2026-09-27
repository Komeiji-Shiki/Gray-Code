import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import type { ToolContext } from '../src/runtime/tools';
import type { PlatformApplication } from '../../../apps/server/src/application';
import { languageTools } from '../../../apps/server/src/development/tools';
import { createFindReferencesToolDeclaration } from '../../../backend/tools/lsp/declarations';
import { MAX_REFERENCE_CONTENT_CHARS } from '../../../backend/tools/lsp/referencePage';

const provider = jest.fn();
const actor = jest.fn(() => ({ role: 'owner' }));
const app = {
  languages: { toolRequest: provider }, actor,
  product: { runtimeSettings: () => ({ getReadFileConfig: () => ({ outsideWorkspaceAccess: 'deny' }) }) }
} as unknown as PlatformApplication;
let directory: string;
let context: ToolContext;
const tool = languageTools(app).find(value => value.declaration.name === 'find_references')!;
const call = (args: Record<string, unknown> = {}) => tool.execute({ path: 'main.ts', line: 1, ...args }, context) as Promise<any>;
const reference = (file: string, line: number, column = 0) => ({ uri: pathToFileURL(path.join(directory, file)).href,
  range: { start: { line, character: column }, end: { line, character: column + 1 } } });

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'graycode-reference-pages-'));
  await writeFile(path.join(directory, 'main.ts'), 'export const source = 1;');
  await writeFile(path.join(directory, 'a.ts'), Array.from({ length: 510 }, (_, index) => `value ${index}`).join('\n'));
  await writeFile(path.join(directory, 'b.ts'), 'first\nsecond\nthird');
  context = { runId: 'references', actorId: 'owner', conversationId: 'references', signal: new AbortController().signal,
    workspace: { id: 'project', name: 'project', directory, deviceId: 'local' }, askUser: jest.fn(), progress: jest.fn() };
  provider.mockReset(); actor.mockClear();
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

test('平台跨页按路径/行列稳定排序，provider顺序变化不重复或漏掉引用', async () => {
  const locations = [reference('b.ts', 1), reference('a.ts', 10, 2), reference('a.ts', 10, 1), reference('a.ts', 1)];
  provider.mockResolvedValueOnce(locations).mockResolvedValueOnce([...locations].reverse());
  const first = await call({ maxResults: 2, context: 0 });
  expect(provider).toHaveBeenCalledWith(context, path.join(directory, 'main.ts'), expect.any(String), 'textDocument/references',
    { position: { line: 0, character: 0 }, context: { includeDeclaration: true } });
  expect(first.data).toMatchObject({ totalCount: 4, totalFileCount: 2, returnedCount: 2, fileCount: 1, nextOffset: 2, truncated: true, truncationReasons: ['maxResults'] });
  expect(first.data.references[0]).toMatchObject({ path: 'a.ts', count: 2, references: [{ line: 2, column: 1 }, { line: 11, column: 2 }] });
  const last = await call({ maxResults: 2, offset: first.data.nextOffset, context: 0 });
  expect(last.data).toMatchObject({ totalCount: 4, totalFileCount: 2, returnedCount: 2, fileCount: 2, truncated: false });
  expect(last.data.nextOffset).toBeUndefined();
  expect(last.data.references.map((group: any) => [group.path, group.references[0].line, group.references[0].column])).toEqual([['a.ts', 11, 3], ['b.ts', 2, 1]]);
});

test('平台 countOnly 保留全部统计，不打开引用文件也不为工作区外正文请求确认', async () => {
  provider.mockResolvedValue([reference('a.ts', 0), reference('a.ts', 1), reference('../outside.ts', 0)]);
  const result = await call({ countOnly: true, maxResults: 1, offset: 100 });
  expect(result.data).toMatchObject({ totalCount: 3, totalFileCount: 2, returnedCount: 0, fileCount: 0, references: [], truncated: false });
  expect(result.data.nextOffset).toBeUndefined();
  // FileReadAccess 每次 resolve 都检查 actor；只查源文件说明统计没有展开任何引用正文。
  expect(actor).toHaveBeenCalledTimes(1);
  expect(context.askUser).not.toHaveBeenCalled();
});

test.each([500, 501])('平台兼容默认500预算并可继续取余下引用：%i', async count => {
  provider.mockResolvedValue(Array.from({ length: count }, (_, index) => reference('a.ts', index)).reverse());
  const first = await call({ context: 0 });
  expect(first.data).toMatchObject({ totalCount: count, returnedCount: 500, maxResults: 500, offset: 0, truncated: count > 500 });
  expect(first.data.nextOffset).toBe(count > 500 ? 500 : undefined);
  const tail = await call({ offset: 500, context: 0 });
  expect(tail.data).toMatchObject({ returnedCount: count - 500, truncated: false });
  expect(tail.data.nextOffset).toBeUndefined();
});

test.each([null, []])('平台空provider结果和越界页不提供无进展的nextOffset：%j', async raw => {
  provider.mockResolvedValue(raw);
  const empty = await call();
  expect(empty.data).toMatchObject({ totalCount: 0, totalFileCount: 0, returnedCount: 0, fileCount: 0, references: [], truncated: false });
  expect(empty.data.nextOffset).toBeUndefined();
  provider.mockResolvedValue([reference('a.ts', 0)]);
  const beyond = await call({ offset: 10 });
  expect(beyond.data).toMatchObject({ totalCount: 1, totalFileCount: 1, returnedCount: 0, references: [], truncated: false });
  expect(beyond.data.nextOffset).toBeUndefined();
});

test('平台长片段预算在完整引用之间分页，不跳过中间引用', async () => {
  await writeFile(path.join(directory, 'a.ts'), ['x'.repeat(35_000), 'y'.repeat(35_000), 'last'].join('\n'));
  provider.mockResolvedValue([reference('a.ts', 0), reference('a.ts', 1), reference('a.ts', 2)]);
  const first = await call({ context: 0 });
  expect(first.data).toMatchObject({ returnedCount: 1, nextOffset: 1, truncated: true, truncationReasons: ['outputBudget'] });
  const last = await call({ context: 0, offset: first.data.nextOffset });
  expect(last.data).toMatchObject({ returnedCount: 2, truncated: false });
  expect(last.data.references[0].references.map((item: any) => item.line)).toEqual([2, 3]);
});

test('平台超长单条明确标记contentTruncated，读取最后一条时仍能结束分页', async () => {
  await writeFile(path.join(directory, 'a.ts'), 'x'.repeat(MAX_REFERENCE_CONTENT_CHARS + 1));
  provider.mockResolvedValue([reference('a.ts', 0)]);
  const result = await call({ context: 0 });
  expect(result.data).toMatchObject({ returnedCount: 1, truncated: true, truncationReasons: ['outputBudget'] });
  expect(result.data.nextOffset).toBeUndefined();
  expect(result.data.references[0].references[0]).toMatchObject({ line: 1, contentTruncated: true });
  expect(result.data.references[0].references[0].content).toHaveLength(MAX_REFERENCE_CONTENT_CHARS);
  expect(result.data.continuationHint).toContain('read_file');
});

test('引用不可读仍占一条分页位置，不绕过文件读取策略，也不造成空页死循环', async () => {
  provider.mockResolvedValue([reference('../outside.ts', 0), reference('a.ts', 0)]);
  const first = await call({ maxResults: 1 });
  expect(first.data).toMatchObject({ returnedCount: 1, nextOffset: 1, totalCount: 2 });
  expect(first.data.references[0].references[0].content).toContain('不允许访问工作区外');
  const last = await call({ maxResults: 1, offset: first.data.nextOffset });
  expect(last.data).toMatchObject({ returnedCount: 1, truncated: false });
  expect(last.data.references[0].path).toBe('a.ts');
});

test.each([{ maxResults: 0 }, { maxResults: 501 }, { maxResults: 1.5 }, { offset: -1 }, { offset: '1' }, { offset: Infinity }, { countOnly: 'true' }])('平台拒绝非法分页参数：%j', async options => {
  await expect(call(options)).rejects.toThrow(/maxResults|offset|countOnly/);
  expect(provider).not.toHaveBeenCalled();
});

test.each(['zh-CN', 'en'])('%s声明公开可选分页、统计和总计/当前页计数语义', language => {
  const declaration = createFindReferencesToolDeclaration({ language });
  expect(declaration.parameters.required).toEqual(['path', 'line']);
  expect(declaration.parameters.properties).toMatchObject({ maxResults: { type: 'integer', minimum: 1, maximum: 500, default: 500 }, offset: { type: 'integer', minimum: 0, default: 0 }, countOnly: { type: 'boolean', default: false } });
  for (const name of ['nextOffset', 'countOnly', 'totalCount', 'totalFileCount', 'returnedCount', 'fileCount', 'truncated', 'contentTruncated']) expect(declaration.description).toContain(name);
});
