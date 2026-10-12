/**
 * MIG-09 基准 ②：长对话（1 万条消息历史）。
 *
 * 覆盖生产模块（真实磁盘 IO，临时目录）：
 * - ConversationManager.addBatch → SqliteStorageAdapter.appendHistory
 * - getMessagesRaw 全量读取平台存储
 * - PlatformUsage.stats 精简用量读取，与 aggregateUsageStats 全量扫描对比
 *
 * 全部数据写入现有平台夹具的 .tmp 隔离目录，完成后关闭存储并清理。
 *
 * 沿用历史磁盘基准的 smoke 上限；旧实现的计时不作为 SQLite 平台的实测结果。
 *
 * 运行方式（仓库根目录；命令中的 glob 见 test/benchmark/README.md）：
 *   npx jest --config jest.platform.config.cjs --testMatch <glob> --runInBand --testTimeout 600000
 */
import { PlatformApplication } from '../../../apps/server/src/application';
import type { ConversationManager } from '../../../backend/modules/conversation/ConversationManager';
import { aggregateUsageStats } from '../../../backend/modules/conversation/usageStats';
import type { Content } from '../../../backend/modules/conversation/types';
import { fixture } from './fixtures';
import {
    printHarnessBanner,
    printMetric,
    printSection,
    withTiming,
} from '../../../test/benchmark/benchmarkHarness';

jest.setTimeout(600000);

const TOTAL_MESSAGES = 10_000;
const BATCH_SIZE = 100;
const BATCH_COUNT = TOTAL_MESSAGES / BATCH_SIZE;

/** 生成 1 万条消息（user/model 交替，model 带 usageMetadata）。 */
function makeMessages(count: number, startIndex: number): Content[] {
    const messages: Content[] = [];
    for (let i = 0; i < count; i++) {
        const globalIndex = startIndex + i;
        const isModel = globalIndex % 2 === 1;
        messages.push({
            role: isModel ? 'model' : 'user',
            parts: [{ text: `benchmark message ${globalIndex} with some realistic payload text for token estimation` }],
            modelVersion: isModel ? 'benchmark-model-1' : undefined,
            usageMetadata: isModel
                ? { promptTokenCount: 120, candidatesTokenCount: 60, totalTokenCount: 180 }
                : undefined,
        });
    }
    return messages;
}

describe('基准 ② 长对话（1 万条消息，真实磁盘）', () => {
    let f: Awaited<ReturnType<typeof fixture>>;
    let app: PlatformApplication;
    let manager: ConversationManager;

    beforeEach(async () => {
        f = await fixture();
        await f.store.close();
        app = await PlatformApplication.open({ dataDirectory: f.data });
        manager = app.productUi.conversations;
    });

    afterEach(async () => {
        await app.close();
        await f.cleanup();
    });

    test('1 万条消息：append 增量写 / 全量读取 / usage 统计', async () => {
        printHarnessBanner();
        printSection('MIG-09 基准 ② 长对话（10,000 条消息 / 100 批 × 100 条，真实磁盘）');
        const conversationId = 'bench-long';
        await manager.createConversation(conversationId, 'Benchmark Long Conversation');

        // ---- 0. JIT 预热（F8 同款思路）：主测量前先在独立会话上小规模 append 1 批，
        // 把 addBatch → appendHistory 的事务与对象写入
        // 链路的 JIT 编译与冷缓存开销移出主测量（此前 append 首批发 JIT 预热开销混入主测量）----
        await manager.createConversation('bench-long-warmup', 'Benchmark Warmup');
        await manager.addBatch('bench-long-warmup', makeMessages(BATCH_SIZE, 0));

        // ---- 1. append 增量写（100 批，每批 100 条）----
        const append = await withTiming(async () => {
            for (let batch = 0; batch < BATCH_COUNT; batch++) {
                await manager.addBatch(conversationId, makeMessages(BATCH_SIZE, batch * BATCH_SIZE));
            }
        });
        const historyAfterAppend = await manager.getMessagesRaw(conversationId);
        expect(historyAfterAppend.length).toBe(TOTAL_MESSAGES);
        printMetric({
            label: `append 增量写（${BATCH_COUNT} 批 × ${BATCH_SIZE} 条）`,
            ms: append.ms,
            heapDeltaMB: append.heapDeltaMB,
            data: {
                messages: TOTAL_MESSAGES,
                perBatchMs: +(append.ms / BATCH_COUNT).toFixed(2),
            },
        });

        // ---- 2. 全量读取 ----
        const read = await withTiming(() => manager.getMessagesRaw(conversationId));
        expect(read.result.length).toBe(TOTAL_MESSAGES);
        printMetric({
            label: '全量读取 getMessagesRaw',
            ms: read.ms,
            heapDeltaMB: read.heapDeltaMB,
            data: { messages: read.result.length },
        });

        // ---- 3. usage 统计：平台精简用量读取与索引 ----
        const usageIndexed = await withTiming(() => app.usage.stats('owner', {}));
        printMetric({
            label: 'usage 统计（平台用量索引）',
            ms: usageIndexed.ms,
            heapDeltaMB: usageIndexed.heapDeltaMB,
            data: { totalTokens: usageIndexed.result.totals.totalTokens },
        });

        // ---- 4. usage 统计：全量扫描（无索引，回退读历史）----
        const usageScan = await withTiming(() => aggregateUsageStats(manager, {}));
        printMetric({
            label: 'usage 统计（全量扫描历史，对比）',
            ms: usageScan.ms,
            heapDeltaMB: usageScan.heapDeltaMB,
            data: { totalTokens: usageScan.result.totals.totalTokens },
        });
        expect(usageScan.result.totals.totalTokens).toBe(usageIndexed.result.totals.totalTokens);

        // 沿用已有 smoke 上限，不在存储迁移时放宽性能检查。
        expect(append.ms).toBeLessThan(15_000);
        expect(read.ms).toBeLessThan(2_000);
        expect(usageIndexed.ms).toBeLessThan(1_000);
        expect(usageScan.ms).toBeLessThan(2_000);

        console.log(`\n  [smoke] append ${append.ms.toFixed(1)}ms / read ${read.ms.toFixed(1)}ms / usage-index ${usageIndexed.ms.toFixed(1)}ms / usage-scan ${usageScan.ms.toFixed(1)}ms（上限 append 15000ms / 其余 1000-2000ms）→ OK`);
    });
});
