/**
 * ActivityHandlers（activity.getStats）单元测试
 *
 * 验证：参数解析、结果缓存命中/force 绕过、tracker 未初始化错误、dispose 清缓存。
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
    getActivityStatsHandler,
    disposeActivityStatsCache
} from '../../../webview/handlers/ActivityHandlers';
import {
    ActivityStore,
    setGlobalActivityTracker,
    toDateStr
} from '../../../backend/modules/activity';

function createCtx() {
    const sendResponse = jest.fn();
    const sendError = jest.fn();
    return { sendResponse, sendError } as any;
}

describe('ActivityHandlers activity.getStats', () => {
    let dir: string;
    let store: ActivityStore;

    beforeEach(async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), 'graycode-activity-handler-'));
        store = new ActivityStore(dir);
        const t = new Date();
        t.setHours(10, 0, 0, 0);
        await store.appendSample(t.getTime());
        await store.appendSample(t.getTime() + 120_000);
        await store.flushDay();
        setGlobalActivityTracker({ getStore: () => store } as any);
        disposeActivityStatsCache();
    });

    afterEach(async () => {
        setGlobalActivityTracker(null);
        disposeActivityStatsCache();
        await fs.rm(dir, { recursive: true, force: true });
    });

    test('returns stats with default 7d range', async () => {
        const ctx = createCtx();
        await getActivityStatsHandler({}, 'req_1', ctx);
        expect(ctx.sendError).not.toHaveBeenCalled();
        const [reqId, data] = ctx.sendResponse.mock.calls[0];
        expect(reqId).toBe('req_1');
        expect(data.daily).toHaveLength(7);
        expect(data.today?.date).toBe(toDateStr(Date.now()));
        expect(data.hourlyHeatmap).toEqual([]);
    });

    test('supports range and includeHourly', async () => {
        const ctx = createCtx();
        await getActivityStatsHandler({ range: 'today', includeHourly: true }, 'req_2', ctx);
        const data = ctx.sendResponse.mock.calls[0][1];
        expect(data.daily).toHaveLength(1);
        expect(data.hourlyHeatmap).toHaveLength(1);
    });

    test('caches results within TTL and force bypasses cache', async () => {
        const ctx = createCtx();
        await getActivityStatsHandler({}, 'req_a', ctx);
        await getActivityStatsHandler({}, 'req_b', ctx);
        // 两次查询（相同 key）应命中缓存：handler 内部只执行一次聚合
        // （通过写入不同数据后再次查询仍返回旧数据验证）
        const first = ctx.sendResponse.mock.calls[0][1].today.totalMinutes;
        expect(first).toBe(2);

        // 修改底层数据（flush 掉缓存后 store 已变化，但 handler 缓存仍在 TTL 内）
        const t = new Date();
        t.setHours(11, 0, 0, 0);
        await store.appendSample(t.getTime());
        await store.flushDay();

        await getActivityStatsHandler({}, 'req_c', ctx);
        const cached = ctx.sendResponse.mock.calls[2][1].today.totalMinutes;
        expect(cached).toBe(2); // 命中缓存，仍是旧值

        await getActivityStatsHandler({ force: true }, 'req_d', ctx);
        const fresh = ctx.sendResponse.mock.calls[3][1].today.totalMinutes;
        expect(fresh).toBe(3); // force 绕过缓存，拿到新值
    });

    test('returns error when tracker is not initialized', async () => {
        setGlobalActivityTracker(null);
        const ctx = createCtx();
        await getActivityStatsHandler({}, 'req_e', ctx);
        expect(ctx.sendResponse).not.toHaveBeenCalled();
        expect(ctx.sendError).toHaveBeenCalledWith('req_e', 'ACTIVITY_TRACKER_NOT_READY', expect.any(String));
    });
});
