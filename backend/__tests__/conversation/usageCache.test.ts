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

import { UsageStatsCache, parseConversationIdFromPath } from '../../modules/conversation/usageCache';

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

    test('空输入返回 undefined', () => {
        expect(parseConversationIdFromPath('')).toBeUndefined();
        expect(parseConversationIdFromPath('/')).toBeUndefined();
    });
});
