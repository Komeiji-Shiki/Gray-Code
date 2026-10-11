import { readFile, writeFile } from 'node:fs/promises';
import { legacyMemoryImportFixture } from '../__fixtures__/legacyMemoryImport';
import { LOG_REC } from '../../modules/memory/types';

describe('旧 LOG 只读导入平台数据库', () => {
    let memory: Awaited<ReturnType<typeof legacyMemoryImportFixture>>;
    beforeEach(async () => { memory = await legacyMemoryImportFixture(); });
    afterEach(async () => { await memory.cleanup(); });

    test('320字节旧记录完整导入，保留多字节文本和原文件', async () => {
        const texts = ['alpha', 'x'.repeat(270), '记忆-β'];
        const original = await memory.writeLog(texts, 320);
        expect((await memory.run()).issues).toEqual([]);
        const entries = await memory.entries();
        expect(entries.map(entry => entry.text)).toEqual(texts);
        expect(entries.map(entry => entry.id)).toEqual([0, 1, 2]);
        expect(entries.every(entry => entry.date === '2024-01-01')).toBe(true);
        expect(await readFile(memory.logPath)).toEqual(original);
    });

    test('重复导入幂等，不重复写记录，也不改写来源', async () => {
        const original = await memory.writeLog(['a', 'b'], 320);
        expect((await memory.run()).imported).toEqual([memory.directory]);
        expect((await memory.run()).skipped).toEqual([memory.directory]);
        expect(await memory.entries()).toHaveLength(2);
        expect(await readFile(memory.logPath)).toEqual(original);
    });

    test('旧格式有撕裂尾巴时报告错误，保留完整来源供用户处理', async () => {
        const original = await memory.writeLog(['a', 'b'], 320, Buffer.from('partial-garbage-tail'));
        expect((await memory.run()).issues.length).toBeGreaterThan(0);
        expect(await memory.entries()).toEqual([]);
        expect(await readFile(memory.logPath)).toEqual(original);
    });

    test('当前格式直接导入，来源字节保持不变', async () => {
        const original = await memory.writeLog(['hello', 'world'], LOG_REC);
        expect((await memory.run()).issues).toEqual([]);
        expect((await memory.entries()).map(entry => entry.text)).toEqual(['hello', 'world']);
        expect(await readFile(memory.logPath)).toEqual(original);
    });

    test('5120字节的歧义尺寸按内容识别为16条320字节记录', async () => {
        const texts = Array.from({ length: 16 }, (_, index) => `memory-${index}`);
        const original = await memory.writeLog(texts, 320);
        expect((await memory.run()).issues).toEqual([]);
        expect((await memory.entries()).map(entry => entry.text)).toEqual(texts);
        expect(await readFile(memory.logPath)).toEqual(original);
    });

    test('320字节对齐的垃圾不会被当作有效记忆导入', async () => {
        const garbage = Buffer.alloc(640, 0x78);
        await writeFile(memory.logPath, garbage);
        expect((await memory.run()).issues.length).toBeGreaterThan(0);
        expect(await memory.entries()).toEqual([]);
        expect(await readFile(memory.logPath)).toEqual(garbage);
    });

    test('导入后 wake 与 recall 输出完整', async () => {
        await memory.writeLog(['alpha-1', 'beta-2', 'alpha-3'], 320);
        expect((await memory.run()).issues).toEqual([]);
        const engine = await memory.engine();
        const wake = await engine.wake();
        expect(wake.totalMemories).toBe(3);
        expect(wake.blocks.map(block => block.text.slice(11))).toEqual(['alpha-1', 'beta-2', 'alpha-3']);
        const recall = await engine.recall('alpha');
        expect(recall.totalHits).toBe(2);
        expect(recall.lines.map(line => line.split(' ').slice(2).join(' '))).toEqual(['alpha-1', 'alpha-3']);
    });

    test('导入后可继续追加、编辑和删除', async () => {
        await memory.writeLog(['a', 'b', 'c'], 320);
        expect((await memory.run()).issues).toEqual([]);
        const engine = await memory.engine();
        expect((await engine.note('d')).id).toBe(3);
        await engine.updateEntry(0, 'A');
        expect((await engine.listEntries()).map(entry => entry.text)).toEqual(['A', 'b', 'c', 'd']);
        await engine.deleteEntry(1);
        expect((await engine.listEntries()).map(entry => entry.text)).toEqual(['A', 'c', 'd']);
    });

    test('1024字节上一代记录无损导入', async () => {
        const texts = ['alpha', 'x'.repeat(600), '记忆-β'];
        const original = await memory.writeLog(texts, 1024);
        expect((await memory.run()).issues).toEqual([]);
        expect((await memory.entries()).map(entry => entry.text)).toEqual(texts);
        expect(await readFile(memory.logPath)).toEqual(original);
    });

    test('4096字节歧义尺寸按内容识别为4条1024字节记录', async () => {
        const texts = ['m0', 'm1', 'm2', 'm3'];
        const original = await memory.writeLog(texts, 1024);
        expect((await memory.run()).issues).toEqual([]);
        expect((await memory.entries()).map(entry => entry.text)).toEqual(texts);
        expect(await readFile(memory.logPath)).toEqual(original);
    });

    test('1024字节旧记录有撕裂尾巴时不修复或发布部分数据', async () => {
        const original = await memory.writeLog(['a', 'b'], 1024, Buffer.from('partial-garbage-tail'));
        expect((await memory.run()).issues.length).toBeGreaterThan(0);
        expect(await memory.entries()).toEqual([]);
        expect(await readFile(memory.logPath)).toEqual(original);
    });
});
