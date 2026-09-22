import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { MemoryEmbeddings } from '../../../apps/server/src/memory/longTerm/embeddings';
import type { PlatformApplication } from '../../../apps/server/src/application';
import type { LongMemoryPolicy } from '@graycode/contracts';

let server: Server, embeddings: MemoryEmbeddings, config: NonNullable<LongMemoryPolicy['embedding']>;
let requests: string[][], malformed: boolean, extraDimension: boolean;
const vector = (text: string) => [text.length, [...text].reduce((sum, character) => sum + character.charCodeAt(0), 0)];
const run = (texts: string[]) => embeddings.embed('owner', config, texts, new AbortController().signal);
beforeEach(async () => {
  requests = []; malformed = false; extraDimension = false;
  server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    const { input } = JSON.parse(body) as { input: string[] }; requests.push(input);
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ data: input.map((text, index) => ({ index, embedding: malformed && index === 1 ? [1] : [...vector(text), ...(extraDimension ? [1] : [])] })).reverse(),
      usage: { prompt_tokens: input.length * 3, total_tokens: input.length * 3 } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  config = { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/embeddings`, model: 'fixture', dimensions: 2, documentPrefix: 'D:', queryPrefix: 'Q:' };
  const app = { settings: { credential: async () => null },
    product: { runtimeSettings: () => ({ getProxySettings: () => ({ enabled: false, url: '' }) }) } } as unknown as PlatformApplication;
  embeddings = new MemoryEmbeddings(app);
});
afterEach(async () => { embeddings.close(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });

test('只发送缺失且不同的文本，倒序响应按原始输入恢复，命中部分不计入新用量', async () => {
  await run(['one']);
  const result = await run(['one','two','two','one']);
  expect(requests).toEqual([['D:one'], ['D:two']]);
  expect(result.vectors.map(item => item.values)).toEqual(['D:one','D:two','D:two','D:one'].map(vector));
  expect(result.usage).toEqual({ input: 3, total: 3 });
  result.vectors[1].values[0] = -999;
  expect((await run(['two'])).vectors[0].values).toEqual(vector('D:two'));
  expect((await run(['one','two'])).usage).toEqual({ input: 0, total: 0 });
  expect(requests).toHaveLength(2);
});

test('批次完成前缓存发生淘汰，仍完整返回本次已经命中的向量', async () => {
  for (let batch = 0; batch < 4; batch++) await run(Array.from({ length: 32 }, (_, index) => `old-${batch * 32 + index}`));
  const fresh = Array.from({ length: 31 }, (_, index) => `new-${index}`);
  const result = await run(['old-0', ...fresh]);
  expect(requests[4]).toEqual(fresh.map(text => 'D:' + text));
  expect(result.vectors).toHaveLength(32);
  expect(result.vectors[0].values).toEqual(vector('D:old-0'));
  expect(result.vectors[31].values).toEqual(vector('D:new-30'));
});

test('错误批次不会把部分向量写入缓存，重试仍取得完整且正确的结果', async () => {
  malformed = true;
  await expect(run(['first','second'])).rejects.toThrow('有效浮点向量');
  expect(embeddings.cached('owner', config, 'first')).toBeUndefined();
  malformed = false;
  const result = await run(['first','second']);
  expect(requests).toEqual([['D:first','D:second'], ['D:first','D:second']]);
  expect(result.vectors.map(item => item.values)).toEqual(['D:first','D:second'].map(vector));
});


test('服务在未固定维度时改变输出，不会混用旧缓存和新维度', async () => {
  delete config.dimensions; await run(['old']); extraDimension = true;
  await expect(run(['old','new'])).rejects.toThrow('维度与缓存不一致');
  expect(embeddings.cached('owner', config, 'new')).toBeUndefined();
});
