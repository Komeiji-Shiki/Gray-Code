import { readFile } from 'node:fs/promises';
import { legacyMemoryImportFixture } from '../__fixtures__/legacyMemoryImport';
import { TREE_REC } from '../../modules/memory/types';
import { isValidTreeRecord, pad } from '../../modules/memory/logFormat';

const legacyTreeRecords = (texts: string[]) => Buffer.concat(texts.map(text => pad(text, 288)));

describe('旧 TREE 只读导入平台数据库', () => {
    let memory: Awaited<ReturnType<typeof legacyMemoryImportFixture>>;
    beforeEach(async () => { memory = await legacyMemoryImportFixture(); });
    afterEach(async () => { await memory.cleanup(); });

    test('288字节摘要记录保留文本及各自区间，来源不被改写', async () => {
        await memory.writeLog(['a', 'b', 'c', 'd']);
        const original = legacyTreeRecords(['first summary', 'second summary']);
        const file = await memory.writeTree(2, original);
        expect((await memory.run()).issues).toEqual([]);
        expect(await memory.summaries()).toEqual([
            { lo: 0, hi: 2, text: 'first summary' },
            { lo: 2, hi: 4, text: 'second summary' },
        ]);
        expect(await readFile(file)).toEqual(original);
    });

    test('重复导入不重复创建摘要，不修改来源', async () => {
        await memory.writeLog(['a', 'b']);
        const original = legacyTreeRecords(['first summary']);
        const file = await memory.writeTree(2, original);
        expect((await memory.run()).imported).toEqual([memory.directory]);
        expect((await memory.run()).skipped).toEqual([memory.directory]);
        expect(await memory.summaries()).toHaveLength(1);
        expect(await readFile(file)).toEqual(original);
    });

    test('当前宽度摘要直接导入，字节保持不变', async () => {
        await memory.writeLog(['a', 'b']);
        const original = pad('ab', TREE_REC);
        const file = await memory.writeTree(2, original);
        expect((await memory.run()).issues).toEqual([]);
        expect(await memory.summaries()).toEqual([{ lo: 0, hi: 2, text: 'ab' }]);
        expect(await readFile(file)).toEqual(original);
    });

    test('旧宽度摘要有撕裂尾巴时报告问题并保留原文件', async () => {
        await memory.writeLog(['a', 'b']);
        const original = Buffer.concat([legacyTreeRecords(['first summary']), Buffer.from('partial-tail')]);
        const file = await memory.writeTree(2, original);
        expect((await memory.run()).issues.length).toBeGreaterThan(0);
        expect(await memory.summaries()).toEqual([]);
        expect(await readFile(file)).toEqual(original);
    });

    test('旧宽度识别使用的记录校验不会接受288字节对齐的垃圾', () => {
        const original = Buffer.alloc(576, 0x78);
        expect(isValidTreeRecord(original.subarray(0, 288))).toBe(false);
        expect(isValidTreeRecord(original.subarray(288))).toBe(false);
    });

    test('旧 LOG 与旧 TREE 同时导入后保留已有摘要', async () => {
        const log = await memory.writeLog(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], 1024);
        const originals: Array<[string, Buffer]> = [];
        for (const [width, texts] of [[2, ['s02', 's24', 's46', 's68']], [4, ['s04', 's48']], [8, ['s08']]] as const) {
            const bytes = legacyTreeRecords([...texts]);
            originals.push([await memory.writeTree(width, bytes), bytes]);
        }
        expect((await memory.run()).issues).toEqual([]);
        const summaries = await memory.summaries();
        expect(summaries).toHaveLength(7);
        expect(summaries.find(summary => summary.lo === 0 && summary.hi === 8)?.text).toBe('s08');
        expect(await readFile(memory.logPath)).toEqual(log);
        for (const [file, original] of originals) expect(await readFile(file)).toEqual(original);
    });
});
