import * as fs from 'node:fs/promises';
import path from 'node:path';
import { importLegacyHistory, PlatformStorage, validateLegacyImportPaths } from '@graycode/core';
import { fixture, message, metadata } from './fixtures';

describe('legacy history import into platform storage', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  beforeEach(async () => { f = await fixture(); });
  afterEach(async () => { await f.cleanup(); });

  async function writeLegacy(id: string, messages: unknown[]) {
    const directory = path.join(f.source, 'conversations');
    await fs.writeFile(path.join(directory, `${id}.meta.json`), JSON.stringify(metadata(id)));
    await fs.writeFile(path.join(directory, `${id}.json`), JSON.stringify(messages));
  }

  test('imports array history losslessly, assigns stable missing identities, and preserves source bytes', async () => {
    const values = [
      { role: 'user', parts: [{ text: '保留空白\r\n  内容 🐱' }] },
      { ...message(1), parts: [
        { functionCall: { id: 'call_1', name: 'search', args: { q: 'query' } }, thoughtSignature: ' exact-signature\n' },
        { inlineData: { mimeType: 'image/png', data: Buffer.from('binary fixture').toString('base64') } },
      ] },
      { role: 'user', parts: [{ functionResponse: { id: 'call_1', name: 'search', response: { success: true } } }] },
    ];
    await writeLegacy('old', values);
    const file = path.join(f.source, 'conversations', 'old.json');
    const original = await fs.readFile(file);
    const result = await importLegacyHistory(f.store, f.source);
    expect(result).toMatchObject({ imported: ['old'], skipped: [], issues: [], pendingArtifacts: [], readyForCutover: true });
    const page = await f.store.readHistory('old');
    expect(page.messages[0]).toMatchObject(values[0]);
    expect(page.messages[0].id).toMatch(/^legacy_/);
    expect(page.messages[1]).toMatchObject(values[1]);
    expect(page.messages[2].parentId).toBe('message_1');
    expect(await fs.readFile(file)).toEqual(original);
    await f.store.appendHistory('old', [message(5, '新版继续')]);
    expect((await importLegacyHistory(f.store, f.source)).skipped).toEqual(['old']);
    expect((await f.store.readHistory('old')).total).toBe(4);
  });

  test('imports segmented committed prefixes and ignores uncommitted tail garbage', async () => {
    const root = path.join(f.source, 'conversations');
    const directory = path.join(root, 'segmented');
    await fs.mkdir(path.join(directory, 'history'), { recursive: true });
    await fs.writeFile(path.join(root, 'segmented.meta.json'), JSON.stringify(metadata('segmented')));
    await fs.writeFile(path.join(directory, 'history.index.json'), JSON.stringify({ version: 1, segmentSize: 200, totalMessages: 3,
      segments: [{ file: '000000.ndjson', startIndex: 0, endIndex: 2, count: 3 }],
    }));
    await fs.writeFile(path.join(directory, 'history', '000000.ndjson'), `${[0, 1, 2].map(i => JSON.stringify(message(i))).join('\n')}\n{uncommitted invalid tail`);
    const report = await importLegacyHistory(f.store, f.source);
    expect(report.issues).toEqual([]);
    expect((await f.store.readHistory('segmented')).messages.map(item => item.id)).toEqual(['message_0', 'message_1', 'message_2']);
  });

  test('resumes a committed migration batch after interruption without publishing partial history', async () => {
    await writeLegacy('resume', Array.from({ length: 270 }, (_, i) => message(i)));
    const interrupted = await importLegacyHistory(f.store, f.source, { onProgress: () => { throw new Error('simulated interruption'); } });
    expect(interrupted.issues).toHaveLength(1);
    expect(await f.store.getConversation('resume')).toBeNull();
    await f.store.close();
    f.store = await PlatformStorage.open(f.data);
    const resumed = await importLegacyHistory(f.store, f.source);
    expect(resumed.imported).toEqual(['resume']);
    expect(resumed.issues).toEqual([]);
    expect((await f.store.readHistory('resume', { limit: 1000 })).messages.map(item => item.id)).toEqual(Array.from({ length: 270 }, (_, i) => `message_${i}`));
  });

  test('rejects malformed history without replacing an existing target or pretending it is empty', async () => {
    await writeLegacy('bad', [message(0), { unexpected: true }]);
    await writeLegacy('collision', [message(1)]);
    await f.store.createConversation(metadata('collision'));
    await f.store.appendHistory('collision', [message(99)]);
    const report = await importLegacyHistory(f.store, f.source);
    expect(report.issues.map(issue => issue.conversationId)).toEqual(['bad', 'collision']);
    expect(report.readyForCutover).toBe(false);
    expect(await f.store.getConversation('bad')).toBeNull();
    expect((await f.store.readHistory('collision')).messages).toEqual([message(99)]);
  });

  test('detects a source change and leaves the staged conversation unpublished', async () => {
    await writeLegacy('changing', Array.from({ length: 130 }, (_, i) => message(i)));
    const metadataFile = path.join(f.source, 'conversations', 'changing.meta.json');
    let changed = false;
    const pendingWrites: Promise<void>[] = [];
    const result = await importLegacyHistory(f.store, f.source, { onProgress: () => {
      if (!changed) {
        changed = true;
        pendingWrites.push(fs.writeFile(metadataFile, JSON.stringify({ ...metadata('changing'), title: 'changed' })));
      }
    } });
    await Promise.all(pendingWrites);
    expect(result.readyForCutover).toBe(false);
    expect(result.issues[0].code).toBe('SOURCE_CHANGED');
    expect(await f.store.getConversation('changing')).toBeNull();
  });

  test('reports unsupported sidecars so history import cannot be mistaken for complete platform migration', async () => {
    await writeLegacy('a', [message(0)]);
    await fs.mkdir(path.join(f.source, 'conversations', 'a'));
    await fs.writeFile(path.join(f.source, 'conversations', 'a', 'branches.json'), '{}');
    await fs.writeFile(path.join(f.source, 'conversations', 'a.usage.json'), '{}');
    await writeLegacy('unselected', [message(1)]);
    await fs.mkdir(path.join(f.source, 'checkpoints'));
    const result = await importLegacyHistory(f.store, f.source, { conversationIds: ['a'] });
    expect(result.imported).toEqual(['a']);
    // 用量附属文件已被附属阶段识别并导入（conversation-usage + 原样存档），不再是未处理项；
    // 未被转换器认领的分支图与检查点目录仍挂为未处理，阻止误判为可切换。
    expect(result.artifacts?.usage).toEqual(['a']);
    expect(result.pendingArtifacts).toEqual(expect.arrayContaining(['checkpoints', 'conversations/a',
      'conversations/unselected.json', 'conversations/unselected.meta.json']));
    expect(result.pendingArtifacts).not.toContain('conversations/a.usage.json');
    expect(result.readyForCutover).toBe(false);
  });

  test('refuses escaping index paths and overlapping source/destination', async () => {
    const directory = path.join(f.source, 'conversations', 'unsafe');
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(f.source, 'conversations', 'unsafe.meta.json'), JSON.stringify(metadata('unsafe')));
    await fs.writeFile(path.join(directory, 'history.index.json'), JSON.stringify({ version: 1, totalMessages: 1,
      segments: [{ file: '../escape.ndjson', startIndex: 0, endIndex: 0, count: 1 }],
    }));
    const result = await importLegacyHistory(f.store, f.source);
    expect(result.issues[0].code).toBe('CORRUPT_DATA');
    await expect(importLegacyHistory(f.store, f.data)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const nested = path.join(f.source, 'new', 'destination');
    await expect(validateLegacyImportPaths(f.source, nested)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(fs.stat(nested)).rejects.toMatchObject({ code: 'ENOENT' });
    const escapedId = await importLegacyHistory(f.store, f.source, { conversationIds: ['../../outside'] });
    expect(escapedId.issues[0].code).toBe('INVALID_INPUT');
  });
});
