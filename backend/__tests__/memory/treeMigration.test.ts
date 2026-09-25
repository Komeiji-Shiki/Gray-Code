/**
 * TREE 摘要文件旧宽度（288B/条）→ 当前宽度（TREE_REC=1024B/条）迁移回归测试：
 * 1. 旧宽度摘要文件在首次访问时无损迁移（摘要文本不变，文件变为当前宽度对齐）
 * 2. 迁移幂等：新实例再次访问不重复重写
 * 3. 当前宽度文件不受影响（字节不变）
 * 4. 旧宽度 + 撕裂尾巴：完整记录迁移，尾巴丢弃
 * 5. 288 对齐但内容不合法（垃圾）：不迁移、不抛错（fail-open），读取视为无摘要
 *
 * 说明：树迁移挂在读取路径（treeGet / pending）与 repairLog（写路径）上，
 * 这里通过 MemoryManager 内部 store 直接验证树文件的字节级结果，
 * 避免 wake 的 cover 算法在不同 T 下选择不同块而让断言依赖算法细节。
 */
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { MemoryManager } from '../../modules/memory/MemoryManager';
import { TREE_REC } from '../../modules/memory/types';

/** 旧 TREE 固定宽度（TREE_REC=288 时代） */
const LEGACY_TREE_REC = 288;

/** 构造一条旧宽度（288B）树摘要记录（正文 + 空格填充 + 换行） */
function legacyTreeRecord(text: string): Buffer {
    const rec = Buffer.alloc(LEGACY_TREE_REC);
    const line = Buffer.from(text, 'utf-8');
    if (line.length > LEGACY_TREE_REC - 1) throw new Error(`fixture too long: ${line.length} bytes`);
    line.copy(rec);
    rec.fill(0x20, line.length, LEGACY_TREE_REC - 1);
    rec[LEGACY_TREE_REC - 1] = 0x0a;
    return rec;
}

/** 构造一条上一代宽度（1024B）的 LOG 记录 */
function legacyLogRecord1024(id: number, date: string, text: string): Buffer {
    const rec = Buffer.alloc(1024);
    const line = Buffer.from(`#${id} ${date} ${text}`, 'utf-8');
    if (line.length > 1023) throw new Error(`fixture too long: ${line.length} bytes`);
    line.copy(rec);
    rec.fill(0x20, line.length, 1023);
    rec[1023] = 0x0a;
    return rec;
}

/** 建一个只有 TREE/<size> 文件的记忆目录（LOG 为空），返回目录与文件路径 */
function makeDirWithLegacyTree(size: number, contents: Buffer[]): { dir: string; treePath: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-tree-'));
    fs.mkdirSync(path.join(dir, 'TREE'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'LOG.txt'), '');
    const treePath = path.join(dir, 'TREE', String(size));
    fs.writeFileSync(treePath, Buffer.concat(contents));
    return { dir, treePath };
}

/** 取内部存储层（树读写的直接入口） */
function storeOf(mm: MemoryManager): any {
    return (mm as any).store;
}

describe('MemoryManager TREE 旧宽度迁移', () => {
    test('旧宽度摘要文件：读取时无损迁移，摘要文本不变', async () => {
        const { dir, treePath } = makeDirWithLegacyTree(2, [
            legacyTreeRecord('first summary'),
            legacyTreeRecord('second summary'),
        ]);
        try {
            const mm = new MemoryManager(dir);
            await mm.init();
            const store = storeOf(mm);
            expect(await store.treeGet(0, 2)).toBe('first summary');
            expect(await store.treeGet(2, 4)).toBe('second summary');

            // 文件已重写为当前宽度对齐（2 条记录）
            const buf = fs.readFileSync(treePath);
            expect(buf.length).toBe(2 * TREE_REC);
            expect(buf.length % LEGACY_TREE_REC).not.toBe(0);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('迁移幂等：新实例再次访问不重复重写', async () => {
        const { dir, treePath } = makeDirWithLegacyTree(2, [legacyTreeRecord('a'), legacyTreeRecord('b')]);
        // 通过 require 拿到底层 CJS 模块对象（与 memoryManagerFixes.test.ts 同法）
        const fsPromises = require('fs/promises') as typeof import('fs/promises');
        const realRename = fsPromises.rename;
        const renameSpy = jest.spyOn(fsPromises, 'rename').mockImplementation(async (...args: any[]) => {
            return (realRename as any)(...(args as [any, any]));
        });
        try {
            const mm = new MemoryManager(dir);
            await mm.init();
            await storeOf(mm).treeGet(0, 2); // 第一次：迁移（rename 一次）
            const sizeAfterFirst = fs.statSync(treePath).size;
            expect(sizeAfterFirst).toBe(2 * TREE_REC);
            expect(renameSpy).toHaveBeenCalledTimes(1);

            // 新实例（模拟下次会话）：文件已是当前宽度，不再重写
            const mm2 = new MemoryManager(dir);
            await mm2.init();
            expect(await storeOf(mm2).treeGet(0, 2)).toBe('a');
            expect(fs.statSync(treePath).size).toBe(sizeAfterFirst);
            expect(renameSpy).toHaveBeenCalledTimes(1);
        } finally {
            renameSpy.mockRestore();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('当前宽度文件不受影响（字节不变）', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-tree-'));
        try {
            const mm = new MemoryManager(dir, { entryChars: 280 } as any);
            await mm.init();
            await mm.note('a');
            await mm.note('b');
            await mm.compress('0-1', 'ab');
            const treePath = path.join(dir, 'TREE', '2');
            const before = fs.readFileSync(treePath);
            expect(before.length % TREE_REC).toBe(0);

            const mm2 = new MemoryManager(dir);
            await mm2.init();
            expect(await storeOf(mm2).treeGet(0, 2)).toBe('ab');
            expect(fs.readFileSync(treePath).equals(before)).toBe(true);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('旧宽度 + 撕裂尾巴：完整记录迁移，尾巴丢弃', async () => {
        const { dir, treePath } = makeDirWithLegacyTree(2, [
            legacyTreeRecord('keep-me'),
            Buffer.from('partial-tail'),
        ]);
        try {
            const mm = new MemoryManager(dir);
            await mm.init();
            expect(await storeOf(mm).treeGet(0, 2)).toBe('keep-me');
            expect(fs.statSync(treePath).size).toBe(TREE_REC);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('288 对齐但内容不合法（垃圾）：不迁移、不抛错，读取视为无摘要', async () => {
        const garbage = Buffer.alloc(LEGACY_TREE_REC, 0x58); // 'X' × 288：末字节非 0x0a
        const { dir, treePath } = makeDirWithLegacyTree(2, [garbage]);
        try {
            const mm = new MemoryManager(dir);
            await mm.init();
            // 迁移中止（内容不合法）→ 按当前宽度解析长度不足一条 → 视为无摘要
            expect(await storeOf(mm).treeGet(0, 2)).toBeNull();
            // 文件保持原样（fail-open，不丢数据）
            expect(fs.readFileSync(treePath).equals(garbage)).toBe(true);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('未迁移的旧宽度文件按当前宽度读取时不会把拼接内容当摘要', async () => {
        // 构造 3 条旧宽度记录（864 字节）：按当前宽度 1024 读取首槽会读满 1024 字节，
        // 拼进后续记录及其换行——isValidTreeSummary 必须判定为无效（返回 null），
        // 而不是把跨记录拼接的乱码当成摘要展示。
        const { dir, treePath } = makeDirWithLegacyTree(2, [
            legacyTreeRecord('one'),
            legacyTreeRecord('two'),
            legacyTreeRecord('three'),
        ]);
        try {
            // 绕过迁移：直接把文件读出来验证「按当前宽度读取」的判定（模拟迁移失败的边界）
            const mm = new MemoryManager(dir);
            await mm.init();
            const buf = fs.readFileSync(treePath);
            const raw = buf.subarray(0, TREE_REC).toString('utf-8');
            const { isValidTreeSummary } = require('../../modules/memory/logFormat');
            expect(raw.includes('\n')).toBe(true);          // 拼接内容里含记录尾换行
            expect(isValidTreeSummary(raw)).toBe(false);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('旧格式 LOG + 旧格式 TREE：同时迁移后摘要可直接读取（不触发重新压缩）', async () => {
        const texts = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-tree-'));
        try {
            fs.mkdirSync(path.join(dir, 'TREE'), { recursive: true });
            fs.writeFileSync(
                path.join(dir, 'LOG.txt'),
                Buffer.concat(texts.map((t, i) => legacyLogRecord1024(i, '2024-01-01', t)))
            );
            fs.writeFileSync(path.join(dir, 'TREE', '2'),
                Buffer.concat(['s02', 's24', 's46', 's68'].map(t => legacyTreeRecord(t))));
            fs.writeFileSync(path.join(dir, 'TREE', '4'),
                Buffer.concat(['s04', 's48'].map(t => legacyTreeRecord(t))));
            fs.writeFileSync(path.join(dir, 'TREE', '8'), legacyTreeRecord('s08'));

            const mm = new MemoryManager(dir, { wakeLines: 100 } as any);
            await mm.init();
            // LOG 迁移（读取触发）：旧宽度记录丢失
            expect((await mm.listEntries()).map(e => e.text)).toEqual(texts);

            const store = storeOf(mm);
            expect(await store.treeGet(0, 2)).toBe('s02');
            expect(await store.treeGet(0, 4)).toBe('s04');
            expect(await store.treeGet(0, 8)).toBe('s08');

            for (const size of [2, 4, 8]) {
                const buf = fs.readFileSync(path.join(dir, 'TREE', String(size)));
                expect(buf.length % TREE_REC).toBe(0);
                expect(buf.length % LEGACY_TREE_REC).not.toBe(0);
            }
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
