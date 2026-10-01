import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { DocumentSymbol, SymbolInformation } from 'vscode-languageserver-protocol';
import type { ToolContext } from '../src/runtime/tools';
import type { PlatformApplication } from '../../../apps/server/src/application';
import { languageTools } from '../../../apps/server/src/development/tools';
import { createGetSymbolsToolDeclaration } from '../../../backend/tools/lsp/declarations';

function documentSymbol(name: string, kind: DocumentSymbol['kind'], start: number, end: number, children: DocumentSymbol[] = [], column = 0): DocumentSymbol {
  return { name, kind, range: { start: { line: start - 1, character: column }, end: { line: end - 1, character: column + 1 } },
    selectionRange: { start: { line: start - 1, character: column }, end: { line: start - 1, character: column + 1 } }, children };
}

const provider = jest.fn();
const app = {
  languages: { toolRequest: provider },
  actor: () => ({ role: 'owner' }),
  product: { runtimeSettings: () => ({ getReadFileConfig: () => ({ outsideWorkspaceAccess: 'deny' }) }) }
} as unknown as PlatformApplication;
let directory: string;
let context: ToolContext;
const tool = languageTools(app).find(value => value.declaration.name === 'get_symbols')!;
const call = (args: Record<string, unknown> = {}) => tool.execute({ paths: ['main.ts'], ...args }, context) as Promise<any>;

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'graycode-symbol-outline-'));
  await writeFile(path.join(directory, 'main.ts'), 'export class Root { method() { const local = 1; } }');
  context = { runId: 'symbols', actorId: 'owner', conversationId: 'symbols', signal: new AbortController().signal,
    workspace: { id: 'project', name: 'project', directory, deviceId: 'local' }, askUser: jest.fn(), progress: jest.fn() };
  provider.mockReset();
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

test('平台默认简洁提纲只返回顶层；隐藏的子树不是500预算截断', async () => {
  provider.mockResolvedValue([
    documentSymbol('aLast', 12, 900, 910),
    documentSymbol('zRoot', 5, 1, 800, Array.from({ length: 700 }, (_, index) => documentSymbol(`member${index}`, 7, index + 2, index + 2)))
  ]);
  const result = await call();
  expect(provider).toHaveBeenCalledWith(context, path.join(directory, 'main.ts'), expect.any(String), 'textDocument/documentSymbol');
  expect(result).toMatchObject({ success: true, data: { maxDepth: 1, totalSymbolCount: 2, truncated: false } });
  expect(result.data.results[0]).toMatchObject({ symbolCount: 2, availableSymbolCount: 702, collapsedSymbolCount: 700, filteredSymbolCount: 0, truncated: false });
  expect(result.data.results[0].symbols.map((symbol: any) => symbol.name)).toEqual(['zRoot', 'aLast']);
  expect(result.data.results[0].symbols[0]).toMatchObject({ kind: 'class', line: 1, column: 1, depth: 1, childCount: 700, childrenCollapsed: true });
  expect(result.data.results[0].symbols[0].children).toBeUndefined();
});

test('平台显式展开按源行列排序，并且保留真正的层级与折叠状态', async () => {
  provider.mockResolvedValue([documentSymbol('Root', 5, 1, 30, [
    documentSymbol('aLast', 6, 20, 25), documentSymbol('aLaterColumn', 7, 5, 5, [], 12),
    documentSymbol('zEarlierColumn', 7, 5, 5, [], 2),
    documentSymbol('zMethod', 6, 8, 15, [documentSymbol('local', 13, 10, 10)])
  ])]);
  const result = await call({ maxDepth: 2 });
  expect(result.data).toMatchObject({ maxDepth: 2, totalSymbolCount: 5, truncated: false });
  const root = result.data.results[0].symbols[0];
  expect(root.childrenCollapsed).toBeUndefined();
  expect(root.children.map((symbol: any) => symbol.name)).toEqual(['zEarlierColumn', 'aLaterColumn', 'zMethod', 'aLast']);
  expect(root.children[2]).toMatchObject({ depth: 2 });
  expect(root.children[2]).not.toHaveProperty('childCount');
  expect(root.children[2]).not.toHaveProperty('childrenCollapsed');
  const expanded = await call({ maxDepth: 3 });
  expect(expanded.data.results[0]).toMatchObject({ symbolCount: 5, availableSymbolCount: 6, collapsedSymbolCount: 0, filteredSymbolCount: 1, truncated: false });
  expect(expanded.data.results[0].symbols[0].children[2]).not.toHaveProperty('children');
});

test('平台 kinds 只筛选已展开的层级，省略父节点但不丢失匹配的后代', async () => {
  provider.mockResolvedValue([documentSymbol('Root', 5, 1, 20, [documentSymbol('method', 6, 5, 15, [documentSymbol('local', 13, 8, 8)])])]);
  const folded = await call({ kinds: ['method'] });
  expect(folded.data.results[0]).toMatchObject({ symbols: [], symbolCount: 0, collapsedSymbolCount: 2, filteredSymbolCount: 1, truncated: false });
  const filtered = await call({ maxDepth: 2, kinds: ['method', 'method'] });
  expect(filtered.data.kinds).toEqual(['method']);
  expect(filtered.data.results[0]).toMatchObject({ symbolCount: 1, availableSymbolCount: 3, collapsedSymbolCount: 1, filteredSymbolCount: 1, truncated: false });
  expect(filtered.data.results[0].symbols).toMatchObject([{ name: 'method', depth: 2 }]);
  expect(filtered.data.results[0].symbols[0]).not.toHaveProperty('childrenCollapsed');
});

test('平台接受 SymbolInformation 平列表，但不根据范围包含和容器名猜测不存在的层级', async () => {
  const flat = (name: string, start: number, end: number, uri = 'file:///main.ts'): SymbolInformation => ({ name, kind: 12, containerName: 'fake',
    location: { uri, range: { start: { line: start, character: 0 }, end: { line: end, character: 1 } } } });
  provider.mockResolvedValue([flat('aChild', 5, 7), flat('aLast', 30, 35), flat('zRoot', 0, 20), flat('separateFile', 2, 3, 'file:///other.ts'),
    flat('equal1', 40, 41), flat('equal2', 40, 41)]);
  const folded = await call();
  expect(folded.data.results[0]).toMatchObject({ symbolCount: 6, availableSymbolCount: 6, collapsedSymbolCount: 0, hierarchyAvailable: false, truncated: false });
  expect(folded.data.results[0].symbols.map((symbol: any) => symbol.name)).toEqual(['zRoot', 'separateFile', 'aChild', 'aLast', 'equal1', 'equal2']);
  const expanded = await call({ maxDepth: 2 });
  expect(expanded.data.results[0].symbols).toEqual(folded.data.results[0].symbols);
  expect(expanded.data.results[0].symbols.every((symbol: any) => symbol.depth === 1 && !symbol.children)).toBe(true);
  const filtered = await call({ kinds: ['class'] });
  expect(filtered.data.results[0]).toMatchObject({ symbols: [], hierarchyAvailable: false, filteredSymbolCount: 6, truncated: false });
});

test.each([
  { count: 500, flat: false }, { count: 501, flat: false },
  { count: 500, flat: true }, { count: 501, flat: true }
])('平台总预算按实际输出计数并且在源排序后应用：%j', async ({ count, flat }) => {
  provider.mockResolvedValue(Array.from({ length: count }, (_, index) => {
    const symbol = documentSymbol(`symbol${index}`, 13, index + 1, index + 1);
    return flat ? { name: symbol.name, kind: symbol.kind, location: { uri: 'file:///main.ts', range: symbol.range } } : symbol;
  }).reverse());
  const result = await call({ maxDepth: 1000 });
  expect(result.data).toMatchObject({ totalSymbolCount: 500, truncated: count > 500 });
  expect(result.data.results[0]).toMatchObject({ symbolCount: 500, availableSymbolCount: count, collapsedSymbolCount: 0, truncated: count > 500 });
  expect(result.data.results[0].symbols[0].name).toBe('symbol0');
  expect(result.data.results[0].symbols[499].name).toBe('symbol499');
});

test.each([499, 600])('显式展开共享每文件500预算，类型筛选不消耗预算：%i个成员', async count => {
  provider.mockResolvedValue([documentSymbol('Root', 5, 1, 900, Array.from({ length: count }, (_, index) => documentSymbol(`method${index}`, 6, index + 2, index + 2)))]);
  const expanded = await call({ maxDepth: 2 });
  expect(expanded.data.results[0]).toMatchObject({ symbolCount: 500, availableSymbolCount: count + 1, collapsedSymbolCount: 0, truncated: count > 499 });
  expect(expanded.data.results[0].symbols[0].children).toHaveLength(499);
  const filtered = await call({ maxDepth: 2, kinds: ['class'] });
  expect(filtered.data.results[0]).toMatchObject({ symbolCount: 1, availableSymbolCount: count + 1, collapsedSymbolCount: 0, filteredSymbolCount: count, truncated: false });
});

test('多文件混合失败、空结果与成功依输入顺序聚合，且仍限制最多20文件', async () => {
  await writeFile(path.join(directory, 'empty.ts'), '');
  await writeFile(path.join(directory, 'provider-error.ts'), '');
  provider.mockImplementation(async (_context, absolute: string) => {
    if (absolute.endsWith('provider-error.ts')) throw new Error('provider unavailable');
    return absolute.endsWith('empty.ts') ? null : [documentSymbol('Root', 5, 1, 3, [documentSymbol('hidden', 7, 2, 2)])];
  });
  const result = await call({ paths: ['main.ts', 'missing.ts', 'empty.ts', 'provider-error.ts'] });
  expect(result).toMatchObject({ success: false, data: { successCount: 2, failCount: 2, totalCount: 4, totalSymbolCount: 1, truncated: false } });
  expect(result.data.results.map((file: any) => file.path)).toEqual(['main.ts', 'missing.ts', 'empty.ts', 'provider-error.ts']);
  expect(result.data.results[2]).toMatchObject({ symbols: [], symbolCount: 0, availableSymbolCount: 0, collapsedSymbolCount: 0, truncated: false });
  expect(result.error).toContain('provider unavailable');
  provider.mockClear();
  const capped = await call({ paths: Array.from({ length: 21 }, () => 'main.ts') });
  expect(capped.data).toMatchObject({ successCount: 20, totalCount: 21, totalSymbolCount: 20, truncated: true });
  expect(capped.data.results).toHaveLength(20);
  // 同一次批量调用的重复路径共享提纲，返回条目和20条预算仍按输入计数。
  expect(provider).toHaveBeenCalledTimes(1);
});

test.each([{ maxDepth: 0 }, { maxDepth: 1.5 }, { maxDepth: '2' }, { kinds: 'class' }, { kinds: ['not_a_kind'] }])('平台拒绝无效提纲参数：%j', async options => {
  await expect(call(options)).rejects.toThrow(/maxDepth|kinds/);
  expect(provider).not.toHaveBeenCalled();
});

test.each(['zh-CN', 'en'])('%s 工具声明公开深度、类型筛选与主动折叠/预算区别', language => {
  const declaration = createGetSymbolsToolDeclaration({ language });
  const properties = declaration.parameters.properties as Record<string, any>;
  expect(properties.maxDepth).toMatchObject({ type: 'integer', minimum: 1, default: 1 });
  expect(properties.kinds.items.enum).toContain('method');
  for (const identifier of ['maxDepth', 'kinds', 'depth', 'collapsedSymbolCount', 'truncated']) expect(declaration.description).toContain(identifier);
  expect(declaration.description).not.toMatch(/全部符号|Get all symbols/);
});
