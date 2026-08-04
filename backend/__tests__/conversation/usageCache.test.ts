/**
 * usageCache 单元测试
 *
 * 覆盖：
 * - UsageStatsCache 的条目读写 / dirty 标记与消费 / prune / clear
 * - parseConversationIdFromPath 的 watcher 事件文件名解析
 *
 * startUsageDirectoryWatcher 依赖真实 fs.watch（跨平台事件时序不稳定），
 * 不做单测；其事件解析逻辑已抽为纯函数在此覆盖。
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    UsageStatsCache,
    parseConversationIdFromPath,
    probeRecursiveWatchSupport,
    scanConversationMtimes,
    diffMtimeSnapshots,
    startMtimeFallbackScanner,
    startUsageDirectoryWatcher
} from '../../modules/conversation/usageCache';

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error('waitFor timeout');
        await new Promise(r => setTimeout(r, 10));
    }
}

describe('UsageStatsCache', () => {
    test('set/get/has/delete 基本行为', () => {
        const cache = new UsageStatsCache();
        expect(cache.has('a')).toBe(false);
        expect(cache.size).toBe(0);

        cache.set('a', { title: 'A', updatedAt: 1, messages: [] });
        expect(cache.has('a')).toBe(true);
        expect(cache.get('a')).toEqual({ title: 'A', updatedAt: 1, messages: [] });
        expect(cache.size).toBe(1);

        cache.delete('a');
        expect(cache.has('a')).toBe(false);
        expect(cache.size).toBe(0);
    });

    test('markDirty/takeDirty/isDirty：取走即清空，期间新标记保留到下一轮', () => {
        const cache = new UsageStatsCache();
        cache.set('a', { title: '', updatedAt: 0, messages: [] });
        cache.set('b', { title: '', updatedAt: 0, messages: [] });

        cache.markDirty('a');
        expect(cache.isDirty('a')).toBe(true);
        expect(cache.isDirty('b')).toBe(false);

        const first = cache.takeDirty();
        expect(first).toEqual(['a']);
        expect(cache.isDirty('a')).toBe(false);

        // 统计期间新到达的事件保留到下一轮
        cache.markDirty('b');
        cache.markDirty('a');
        expect(cache.takeDirty().sort()).toEqual(['a', 'b']);
        expect(cache.takeDirty()).toHaveLength(0);
    });

    test('delete 同时清理 dirty 标记', () => {
        const cache = new UsageStatsCache();
        cache.set('a', { title: '', updatedAt: 0, messages: [] });
        cache.markDirty('a');
        cache.delete('a');
        expect(cache.has('a')).toBe(false);
        expect(cache.takeDirty()).toHaveLength(0);
    });

    test('prune 移除磁盘上已不存在的对话', () => {
        const cache = new UsageStatsCache();
        cache.set('a', { title: '', updatedAt: 0, messages: [] });
        cache.set('b', { title: '', updatedAt: 0, messages: [] });

        cache.prune(new Set(['b']));
        expect(cache.has('a')).toBe(false);
        expect(cache.has('b')).toBe(true);
    });

    test('clear 清空条目与脏标记', () => {
        const cache = new UsageStatsCache();
        cache.set('a', { title: '', updatedAt: 0, messages: [] });
        cache.markDirty('a');
        cache.clear();
        expect(cache.size).toBe(0);
        expect(cache.takeDirty()).toHaveLength(0);
    });
});

describe('parseConversationIdFromPath', () => {
    test('顶层文件：历史 / 元数据 / 索引', () => {
        expect(parseConversationIdFromPath('abc.json')).toBe('abc');
        expect(parseConversationIdFromPath('abc.meta.json')).toBe('abc');
        // usage 索引自身写入也会标记真实对话（自伤一轮后自然恢复）
        expect(parseConversationIdFromPath('abc.usage.json')).toBe('abc');
    });

    test('segmented 子目录与临时目录', () => {
        expect(parseConversationIdFromPath('abc/segment-1.json')).toBe('abc');
        expect(parseConversationIdFromPath('abc/history.index.json')).toBe('abc');
        expect(parseConversationIdFromPath('abc/.tmp/segments-0.json')).toBe('abc');
    });

    test('Windows 反斜杠路径', () => {
        expect(parseConversationIdFromPath('abc\\segment-1.json')).toBe('abc');
        expect(parseConversationIdFromPath('abc\\history\\segments-2.json')).toBe('abc');
    });

    test('原子写临时文件（.tmp）映射回真实对话，不产生假对话 ID', () => {
        expect(parseConversationIdFromPath('abc.usage.json.tmp')).toBe('abc');
        expect(parseConversationIdFromPath('abc.meta.json.tmp')).toBe('abc');
    });

    test('空输入返回 undefined', () => {
        expect(parseConversationIdFromPath('')).toBeUndefined();
        expect(parseConversationIdFromPath('/')).toBeUndefined();
    });
});

describe('mtime 快照降级扫描（非递归 watcher 兜底）', () => {
    let dir: string;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-scan-'));
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('scanConversationMtimes 收集每个对话的最大 mtime，忽略探针目录', () => {
        fs.mkdirSync(path.join(dir, 'conv-a', 'history'), { recursive: true });
        fs.mkdirSync(path.join(dir, 'conv-b'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'conv-a', 'history', 'segment-1.json'), 'x');
        fs.writeFileSync(path.join(dir, 'conv-a.meta.json'), 'x');
        fs.writeFileSync(path.join(dir, 'conv-b.json'), 'x');
        // 探针目录被忽略
        const probeDir = path.join(dir, '.usage-watch-probe-123');
        fs.mkdirSync(probeDir, { recursive: true });
        fs.writeFileSync(path.join(probeDir, 'probe.txt'), 'x');

        const snapshot = scanConversationMtimes(dir);
        expect([...snapshot.keys()].sort()).toEqual(['conv-a', 'conv-b']);
        expect(snapshot.get('conv-a')!).toBeGreaterThan(0);
    });

    test('diffMtimeSnapshots 只报告新增/变更的对话', () => {
        const prev = new Map([['a', 1], ['b', 2]]);
        const curr = new Map([['a', 1], ['b', 3], ['c', 1]]);
        expect(diffMtimeSnapshots(prev, curr).sort()).toEqual(['b', 'c']);
    });

    test('startMtimeFallbackScanner：首次只建基线，变更后标记 dirty', async () => {
        const cache = new UsageStatsCache();
        cache.set('conv-a', { title: '', updatedAt: 0, messages: [] });
        fs.mkdirSync(path.join(dir, 'conv-a', 'history'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'conv-a', 'history', 'segment-1.json'), 'v1');

        const stop = startMtimeFallbackScanner(dir, cache, 20);
        try {
            await waitFor(() => true, 50); // 基线已同步建立
            expect(cache.isDirty('conv-a')).toBe(false);
            // 等 mtime 刻度前进，避免同毫秒写入无法感知
            await new Promise(r => setTimeout(r, 30));
            fs.writeFileSync(path.join(dir, 'conv-a', 'history', 'segment-1.json'), 'v2');
            await waitFor(() => cache.isDirty('conv-a'), 2000);
        } finally {
            stop();
        }
    });
});

describe('startUsageDirectoryWatcher 递归能力探测', () => {
    let dir: string;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-watch-'));
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('probeRecursiveWatchSupport 返回布尔且清理探针目录（真实 fs.watch）', async () => {
        const watcher = fs.watch(dir, { recursive: true });
        try {
            const ok = await probeRecursiveWatchSupport(watcher, dir, 1500);
            expect(typeof ok).toBe('boolean');
            const leftovers = fs.readdirSync(dir).filter(n => n.startsWith('.usage-watch-probe-'));
            expect(leftovers).toHaveLength(0);
        } finally {
            watcher.close();
        }
    });

    test('子目录写入最终标记 dirty（recursive 事件或 mtime 兜底两条路径都会收敛）', async () => {
        const cache = new UsageStatsCache();
        cache.set('conv-a', { title: '', updatedAt: 0, messages: [] });
        fs.mkdirSync(path.join(dir, 'conv-a', 'history'), { recursive: true });

        const dispose = startUsageDirectoryWatcher(dir, cache, {
            probeTimeoutMs: 100,
            fallbackScanIntervalMs: 20
        });
        try {
            await new Promise(r => setTimeout(r, 200)); // 等待探测/基线建立
            await new Promise(r => setTimeout(r, 30));
            fs.writeFileSync(path.join(dir, 'conv-a', 'history', 'segment-1.json'), 'x');
            await waitFor(() => cache.isDirty('conv-a'), 3000);
        } finally {
            dispose();
        }
    });
});
