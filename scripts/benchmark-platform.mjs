import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { PlatformStorage } from '@graycode/core';

// Reproducible synthetic workload. No real history, model requests, or source migration.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryRoot = path.join(root, '.tmp');
await fs.mkdir(temporaryRoot, { recursive: true });
const directory = await fs.mkdtemp(path.join(temporaryRoot, 'platform-benchmark-'));
const legacy = path.join(directory, 'legacy');
const data = path.join(directory, 'new');
await fs.mkdir(legacy);
let seed = 0x47524350;
function randomByte() { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed & 255; }
const attachment = Buffer.from(Array.from({ length: 128 * 1024 }, randomByte)).toString('base64');
const messages = Array.from({ length: 10_000 }, (_, i) => ({
  id: `message_${i}`, parentId: i ? `message_${i - 1}` : null,
  role: i % 2 ? 'model' : 'user', timestamp: 1_700_000_000_000 + i,
  parts: [{ text: `文件 src/module-${i % 41}.ts，修订 ${i}\n${Array.from({ length: 12 }, (_, j) =>
    `const value_${j} = ${i * 17 + j}; // preserve source line and whitespace`).join('\n')}\n` },
  ...(i % 100 === 0 ? [{ inlineData: { mimeType: 'application/octet-stream', data: attachment } }] : [])],
}));
const metadata = id => ({ id, title: `Benchmark ${id}`, createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000 });
async function size(directory) {
  let bytes = 0;
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    bytes += entry.isDirectory() ? await size(file) : (await fs.stat(file)).size;
  }
  return bytes;
}
const timed = async work => { const start = performance.now(); const result = await work(); return { milliseconds: performance.now() - start, result }; };
const segments = [];
for (let start = 0; start < messages.length; start += 200) {
  const file = `${String(start / 200).padStart(6, '0')}.ndjson`;
  const items = messages.slice(start, start + 200);
  await fs.writeFile(path.join(legacy, file), items.map(item => JSON.stringify(item)).join('\n') + '\n');
  segments.push({ file, startIndex: start, endIndex: start + items.length - 1, count: items.length });
}
await fs.writeFile(path.join(legacy, 'history.index.json'), JSON.stringify({ version: 1, totalMessages: messages.length, segments }));
await fs.writeFile(path.join(legacy, 'main.meta.json'), JSON.stringify(metadata('main')));

const store = await PlatformStorage.open(data);
try {
  await store.createConversation(metadata('main'));
  const append = await timed(async () => {
    for (let start = 0; start < messages.length; start += 128) await store.appendHistory('main', messages.slice(start, start + 128));
  });
  await store.collectGarbage();
  await store.checkpoint();
  const singleBytes = await size(data);
  assert.deepEqual((await store.readHistory('main', { limit: 50 })).messages, messages.slice(-50));
  const pageSamples = [];
  for (let i = 0; i < 30; i++) pageSamples.push((await timed(() => store.readHistory('main', { limit: 50 }))).milliseconds);
  pageSamples.sort((a, b) => a - b);
  const forks = await timed(async () => {
    for (let i = 0; i < 100; i++) await store.forkConversation('main', metadata(`fork_${i}`), { beforeIndex: 9000 });
  });
  await store.checkpoint();
  const forkBytes = await size(data);
  assert.deepEqual((await store.readHistory('fork_99', { limit: 50 })).messages, messages.slice(8950, 9000));
  const verification = await store.verify();
  assert.equal(verification.ok, true);
  const baselineBytes = await size(legacy);
  const round = number => Math.round(number * 100) / 100;
  const report = {
    node: process.version, platform: process.platform, architecture: process.arch,
    sqlite: (await store.statistics()).sqliteVersion,
    workload: { messages: messages.length, repeatedBinaryBytes: 128 * 1024, attachmentOccurrences: 100, forks: 100, forkPrefix: 9000 },
    ndjsonBytes: baselineBytes, platformBytesAfterCheckpoint: singleBytes,
    reductionPercent: round(100 * (1 - singleBytes / baselineBytes)),
    appendMilliseconds: round(append.milliseconds),
    warmTail50MedianMilliseconds: round(pageSamples[15]), warmTail50P95Milliseconds: round(pageSamples[28]),
    fork100Milliseconds: round(forks.milliseconds), fork100AdditionalBytes: forkBytes - singleBytes,
    verification,
    limits: 'Synthetic local workload; warm page reads; physical sizes include SQLite and external files after checkpoint. NDJSON is a serialized size baseline, not an old-adapter latency benchmark. Fork cost excludes a legacy full-copy comparison. No cold-cache, power-loss or Electron packaging validation.',
  };
  await fs.writeFile(path.join(temporaryRoot, 'platform-benchmark-latest.json'), JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
} finally {
  await store.close();
  if (path.dirname(directory) !== temporaryRoot || !path.basename(directory).startsWith('platform-benchmark-')) throw new Error('Unsafe benchmark cleanup path.');
  await fs.rm(directory, { recursive: true, force: true });
}
