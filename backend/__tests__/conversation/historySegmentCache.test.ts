/**
 * HistorySegmentCache 段级 LRU 缓存测试（HIS-06）。
 *
 * 覆盖：
 * - 命中/未命中与 LRU 顺序刷新；
 * - 超过上限按最久未使用淘汰；
 * - invalidateConversation 写后失效（当前会话提交/删除会话清理）；
 * - 缓存键包含 conversationId + segmentFile + revision，同文件不同 revision 视为不同条目。
 */

import { HistorySegmentCache, HISTORY_SEGMENT_CACHE_DEFAULT_MAX } from '../../modules/conversation/history/HistorySegmentCache';
import type { Content } from '../../modules/conversation/types';
import { makeContent } from '../__fixtures__/conversationFixtures';

describe('HistorySegmentCache', () => {
    test('未命中返回 null，命中返回同一数组并刷新 LRU 顺序', () => {
        const cache = new HistorySegmentCache(4);
        const a = [makeContent('user', 'a')];
        const b = [makeContent('user', 'b')];

        expect(cache.get('conv1', '000000.ndjson', 1)).toBeNull();
        cache.set('conv1', '000000.ndjson', 1, a);
        cache.set('conv1', '000001.ndjson', 1, b);
        expect(cache.get('conv1', '000000.ndjson', 1)).toBe(a);
        expect(cache.get('conv1', '000001.ndjson', 1)).toBe(b);
    });

    test('超过上限按 LRU 淘汰最久未使用的条目', () => {
        const cache = new HistorySegmentCache(2);
        cache.set('conv1', 's0', 1, [makeContent('user', '0')]);
        cache.set('conv1', 's1', 1, [makeContent('user', '1')]);
        // 命中 s0 使其成为最近使用
        cache.get('conv1', 's0', 1);
        // 插入 s2 触发淘汰：应淘汰 s1（最久未使用）
        cache.set('conv1', 's2', 1, [makeContent('user', '2')]);

        expect(cache.get('conv1', 's1', 1)).toBeNull();
        expect(cache.get('conv1', 's0', 1)).not.toBeNull();
        expect(cache.get('conv1', 's2', 1)).not.toBeNull();
        expect(cache.size).toBe(2);
    });

    test('缓存键包含 revision：同段不同 revision 不互相命中', () => {
        const cache = new HistorySegmentCache(4);
        const v1 = [makeContent('user', 'old')];
        const v2 = [makeContent('user', 'new')];
        cache.set('conv1', '000000.ndjson', 10, v1);
        cache.set('conv1', '000000.ndjson', 11, v2);

        expect(cache.get('conv1', '000000.ndjson', 10)).toBe(v1);
        expect(cache.get('conv1', '000000.ndjson', 11)).toBe(v2);
    });

    test('invalidateConversation 只清除指定会话（写后失效 / 删除会话清理）', () => {
        const cache = new HistorySegmentCache(8);
        cache.set('conv1', '000000.ndjson', 1, [makeContent('user', 'a')]);
        cache.set('conv1', '000001.ndjson', 1, [makeContent('user', 'b')]);
        cache.set('conv2', '000000.ndjson', 1, [makeContent('user', 'c')]);

        cache.invalidateConversation('conv1');

        expect(cache.get('conv1', '000000.ndjson', 1)).toBeNull();
        expect(cache.get('conv1', '000001.ndjson', 1)).toBeNull();
        expect(cache.get('conv2', '000000.ndjson', 1)).not.toBeNull();
        expect(cache.size).toBe(1);
    });

    test('默认上限为 32 段', () => {
        expect(HISTORY_SEGMENT_CACHE_DEFAULT_MAX).toBe(32);
        const cache = new HistorySegmentCache();
        for (let i = 0; i < 40; i++) {
            cache.set(`conv${i}`, 's0', 1, [makeContent('user', String(i))]);
        }
        expect(cache.size).toBe(32);
    });

    test('maxEntries <= 0 时不缓存', () => {
        const cache = new HistorySegmentCache(0);
        cache.set('conv1', 's0', 1, [makeContent('user', 'x')]);
        expect(cache.get('conv1', 's0', 1)).toBeNull();
        expect(cache.size).toBe(0);
    });
});

describe('HistorySegmentCache 字节软上限与分桶失效', () => {
    test('字节软上限：总估算字节超限时按 LRU 提前淘汰（即使段数未超上限）', () => {
        const cache = new HistorySegmentCache(100, 300);
        for (let i = 0; i < 20; i++) {
            cache.set(`conv${i}`, 's0', 1, [makeContent('user', `message-${i}-with-some-length`)]);
        }
        // 单段约 55~60 字节，300 字节软上限 ≈ 5 段：段数远未到 100 就被字节上限淘汰
        expect(cache.size).toBeLessThan(20);
        expect(cache.estimatedBytes).toBeLessThanOrEqual(300);
    });

    test('estimatedBytes 在失效/淘汰后同步扣减', () => {
        const cache = new HistorySegmentCache(100, 1024 * 1024);
        cache.set('conv1', 's0', 1, [makeContent('user', 'aaaa')]);
        expect(cache.estimatedBytes).toBeGreaterThan(0);
        cache.invalidateConversation('conv1');
        expect(cache.size).toBe(0);
        expect(cache.estimatedBytes).toBe(0);
    });

    test('替换同键条目时字节数按新值重算（不重复累计）', () => {
        const cache = new HistorySegmentCache(10, 1024 * 1024);
        cache.set('conv1', 's0', 1, [makeContent('user', 'small')]);
        cache.set('conv1', 's0', 1, [makeContent('user', 'x'), makeContent('user', 'y')]);
        expect(cache.size).toBe(1);
        const before = cache.estimatedBytes;
        cache.set('conv1', 's0', 1, [makeContent('user', 'x'), makeContent('user', 'y')]);
        expect(cache.estimatedBytes).toBe(before);
    });

    test('invalidateConversation 按分桶清理：只清指定会话，字节总数同步扣减', () => {
        const cache = new HistorySegmentCache(8, 1024 * 1024);
        cache.set('conv1', '000000.ndjson', 1, [makeContent('user', 'a')]);
        cache.set('conv1', '000001.ndjson', 1, [makeContent('user', 'b')]);
        cache.set('conv2', '000000.ndjson', 1, [makeContent('user', 'c')]);
        const before = cache.estimatedBytes;

        cache.invalidateConversation('conv1');

        expect(cache.get('conv1', '000000.ndjson', 1)).toBeNull();
        expect(cache.get('conv1', '000001.ndjson', 1)).toBeNull();
        expect(cache.get('conv2', '000000.ndjson', 1)).not.toBeNull();
        expect(cache.size).toBe(1);
        expect(cache.estimatedBytes).toBeLessThan(before);
    });
});
