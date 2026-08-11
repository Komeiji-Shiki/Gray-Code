/**
 * MemoryManager 回归测试：
 * 1. truncateLog 在锁内读取 logLen，与截断原子化（并发 note 追加的新记录被截断时计入 removed）
 * 2. compress 仅在 treePut 成功时置 said=true（块已存在/并行会话已处理时不误报 done:1）
 * 3. wake 缺失摘要时基于实际缺失的块构造提示（而非 nextNap 的第一个待压缩块）
 */
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { MemoryManager } from '../../modules/memory/MemoryManager';

// 通过 require 拿到底层 CJS 模块对象：`import * as fs from 'fs/promises'`
// 编译后是 __importStar 命名空间（只读 getter），jest.spyOn 无法直接在其上安装 mock。
const fsPromises = require('fs/promises') as typeof import('fs/promises');

describe('MemoryManager.truncateLog', () => {
    test('在锁内读取长度：并发 note 追加的新记录被截断时计入 removed', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-truncate-'));

        let gateEnabled = false;
        let gateReleased = false;
        let releaseAppend!: () => void;
        const appendGate = new Promise<void>(resolve => { releaseAppend = resolve; });
        const realAppendFile = fsPromises.appendFile;
        const appendSpy = jest.spyOn(fsPromises, 'appendFile').mockImplementation(async (...args: any[]) => {
            // 只拦截并发 note 的 LOG 追加（gateEnabled 开启后）：模拟其持锁停在写入前
            if (gateEnabled && typeof args[0] === 'string' && args[0].endsWith('LOG.txt')) {
                await appendGate;
            }
            return (realAppendFile as any)(...(args as [any, any, any]));
        });

        try {
            const mm = new MemoryManager(dir, { entryChars: 280 } as any);
            await mm.init();
            await mm.note('a');
            await mm.note('b');
            await mm.note('c');

            // 从 note('d') 开始拦截：它先获取锁并停在 appendFile 前（此时它读到的 T=3）
            gateEnabled = true;
            const notePromise = mm.note('d');
            await new Promise(resolve => setTimeout(resolve, 50));
            // truncateLog 并发启动：修复前在锁外读到过期 T=3，随后排队等待锁
            const truncatePromise = mm.truncateLog(1);
            await new Promise(resolve => setTimeout(resolve, 50));
            // 放行 note 追加（文件 T 变为 4）并释放锁
            gateReleased = true;
            releaseAppend();
            const [truncateResult] = await Promise.all([truncatePromise, notePromise]);

            // 修复后 T 在锁内读取为 4：新记录被截断但计入 removed（removed === 3 而非 2）
            expect(truncateResult.removed).toBe(3);
            const entries = await mm.listEntries();
            expect(entries.length).toBe(1);
            expect(entries[0].text).toBe('a');
        } finally {
            if (!gateReleased) releaseAppend();
            appendSpy.mockRestore();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }, 10000);
});

describe('MemoryManager.compress', () => {
    async function setup8(): Promise<{ mm: MemoryManager; dir: string }> {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-compress-'));
        const mm = new MemoryManager(dir, { entryChars: 280 } as any);
        await mm.init();
        for (const t of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) {
            await mm.note(t);
        }
        return { mm, dir };
    }

    test('块已存在（非下一个待压缩块）时 done=0，不误报已写入', async () => {
        const { mm, dir } = await setup8();
        try {
            expect((await mm.compress('0-1', 'ab')).done).toBe(1);
            expect((await mm.compress('2-3', 'cd')).done).toBe(1);
            expect((await mm.compress('4-5', 'ef')).done).toBe(1);
            expect((await mm.compress('6-7', 'gh')).done).toBe(1);
            expect((await mm.compress('0-3', 'abcd')).done).toBe(1);
            expect((await mm.compress('4-7', 'efgh')).done).toBe(1);

            // 现在待压缩的是 [0,8)：再次压缩已存在的 4-7 不应上报 done:1
            const again = await mm.compress('4-7', 'EFGH');
            expect(again.done).toBe(0);
            expect(again.pendingCompression?.blockId).toBe('0-7');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('只传 blockId 时明确拒绝缺失的 summary', async () => {
        const { mm, dir } = await setup8();
        try {
            await expect(mm.compress('0-1')).rejects.toThrow('summary is required');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('treePut 返回 false（并行会话已处理）时 done=0', async () => {
        const { mm, dir } = await setup8();
        try {
            jest.spyOn(mm as any, 'treePut').mockResolvedValue(false);
            const result = await mm.compress('0-1', 'ab');
            expect(result.done).toBe(0);
            expect(result.pendingCompression).not.toBeNull();
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('MemoryManager.wake', () => {
    test('缺失摘要时提示基于实际缺失的块构造（而非第一个待压缩块）', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-wake-'));
        try {
            const mm = new MemoryManager(dir, { entryChars: 280, wakeLines: 2 } as any);
            await mm.init();
            for (const t of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) {
                await mm.note(t);
            }
            // 只压缩 0-1：pending 的第一个是 [2,4)，但 wake 缺失的块是 [0,4)
            await mm.compress('0-1', 'ab');

            const error = await mm.wake().catch(e => e);
            expect(error.message).toContain('needs #0-3');
            // 提示必须指向实际缺失的块 0-3，而不是第一个待压缩块 2-3
            expect(error.message).toContain('Compress memories #0-3');
            expect(error.message).not.toContain('Compress memories #2-3');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
