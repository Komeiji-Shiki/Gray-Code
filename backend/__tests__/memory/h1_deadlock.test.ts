/**
 * H1 回归测试：updateEntry 编辑记忆不得死锁
 *
 * 历史缺陷：updateEntry 持锁调用 dropSummariesCovering → treeDrop 内部再次
 * acquire 同一把 AsyncLock（不可重入），形成闭环等待，记忆模块整体瘫痪。
 * 修复：dropSummariesCovering 移出锁外执行（treeDrop 自身会加锁）。
 */
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { MemoryManager } from '../../modules/memory/MemoryManager';

describe('MemoryManager updateEntry (H1)', () => {
    test('≥2 条记忆时编辑第一条能正常完成（不死锁）', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'h1-deadlock-'));
        try {
            const mm = new MemoryManager(dir, { entryChars: 280 } as any);
            await mm.init();
            await mm.note('first memory');
            await mm.note('second memory');

            const result = await Promise.race([
                mm.updateEntry(0, 'edited first memory').then(() => 'resolved' as const),
                new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), 2000))
            ]);

            expect(result).toBe('resolved');
            const entries = await mm.listEntries();
            expect(entries[0].text).toBe('edited first memory');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }, 10000);
});
