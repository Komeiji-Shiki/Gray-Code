import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import type { ToolContext } from '../src/runtime/tools';
import type { PlatformApplication } from '../../../apps/server/src/application';
import { languageTools } from '../../../apps/server/src/development/tools';
import { fixture } from './fixtures';

const provider = jest.fn();
const app = { languages: { toolRequest: provider }, actor: () => ({ role: 'owner' }),
  product: { runtimeSettings: () => ({ getReadFileConfig: () => ({ outsideWorkspaceAccess: 'deny' }) }) }
} as unknown as PlatformApplication;
const tool = languageTools(app).find(value => value.declaration.name === 'goto_definition')!;
let f: Awaited<ReturnType<typeof fixture>>;
let context: ToolContext;
const location = (file: string) => ({ targetUri: pathToFileURL(path.join(f.source, file)).toString(),
  targetRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } });
const call = (args = {}) => tool.execute({ path: 'main.ts', line: 1, ...args }, context) as Promise<any>;
beforeEach(async () => {
  f = await fixture(); provider.mockReset();
  await Promise.all([writeFile(path.join(f.source, 'main.ts'), 'const main = 1;'),
    writeFile(path.join(f.source, 'first.ts'), 'a'.repeat(40000)), writeFile(path.join(f.source, 'second.ts'), 'b'.repeat(40000)),
    writeFile(path.join(f.source, 'huge.ts'), 'x'.repeat(70000))]);
  context = { actorId: 'owner', runId: 'definition-test', workspace: { id: 'workspace', name: 'fixture', deviceId: 'local', directory: f.source },
    signal: new AbortController().signal, progress: jest.fn(), askUser: jest.fn() };
});
afterEach(async () => { await f.cleanup(); });

test('正文总预算把下一条完整定义留给下一页，不跳过位置', async () => {
  provider.mockResolvedValue([location('first.ts'), location('second.ts'), location('huge.ts')]);
  const first = await call();
  expect(first.data).toMatchObject({ definitionCount: 1, totalCount: 3, nextOffset: 1, truncationReasons: ['outputBudget'] });
  expect(first.data.definitions[0].path).toBe('first.ts');
  const second = await call({ offset: first.data.nextOffset });
  expect(second.data).toMatchObject({ definitionCount: 1, nextOffset: 2 });
  expect(second.data.definitions[0].path).toBe('second.ts');
  const third = await call({ offset: second.data.nextOffset });
  expect(third.data.definitions[0]).toMatchObject({ path: 'huge.ts', contentTruncated: true });
  expect(third.data.definitions[0].content).toHaveLength(60000);
  expect(third.data.nextOffset).toBeUndefined();
});

test('默认最多500个位置，保留提供器顺序，空页和越界页可终止', async () => {
  provider.mockResolvedValue(Array.from({ length: 501 }, () => location('main.ts')));
  expect((await call()).data).toMatchObject({ definitionCount: 500, totalCount: 501, nextOffset: 500, maxResults: 500 });
  expect((await call({ offset: 500 })).data).toMatchObject({ definitionCount: 1, totalCount: 501, truncated: false });
  const beyond = await call({ offset: 900 });
  expect(beyond.data).toMatchObject({ definitionCount: 0, totalCount: 501, truncated: false });
  expect(beyond.data.nextOffset).toBeUndefined();
  provider.mockResolvedValue(null);
  expect((await call()).data).toMatchObject({ definitionCount: 0, totalCount: 0, truncated: false });
});

test('分页不读取页外目标，返回页仍应用工作区外读取策略', async () => {
  provider.mockResolvedValue([location('main.ts'), location('../outside.ts')]);
  const first = await call({ maxResults: 1 });
  expect(first.data.definitions[0].content).toContain('const main');
  const denied = await call({ offset: 1 });
  expect(denied.data.definitions[0].content).toContain('不允许访问工作区外');
});

test.each([{ maxResults: 501 }, { maxResults: 0 }, { offset: -1 }])('先拒绝无效参数：%j', async args => {
  await expect(call(args)).rejects.toThrow(); expect(provider).not.toHaveBeenCalled();
});
