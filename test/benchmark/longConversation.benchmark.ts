/**
 * MIG-09 基准 ②：长对话（1 万条消息历史）。
 *
 * 覆盖生产模块（真实磁盘 IO，临时目录）：
 * - ConversationManager.addBatch → FileSystemStorageAdapter.appendHistory
 *   （分段 append-only 尾段写入：200 条/段、临时文件 + 原子 rename、index 重写）
 * - updateUsageIndexAppend → FileUsageIndexStore.appendUsage（原子写）
 * - getMessagesRaw 全量读取（分段并发读 + 段缓存）
 * - aggregateUsageStats：走 usage.json 索引 vs 全量扫描两种路径
 *
 * 全部数据落在 os.tmpdir() 临时目录，完成后清理，不触碰真实数据目录。
 *
 * R8e-FIX：smoke 上限按 2026-08-04 实测收紧（append 0.89s / 读 27ms / usage 12-34ms）；
 * append 首批发 JIT 预热开销，读取/统计为一次性调用含预热开销（F8 注）。
 *
 * 运行方式（仓库根目录；命令中的 glob 见 test/benchmark/README.md）：
 *   npx jest --config jest.backend.config.js --testMatch <glob> --runInBand --testTimeout 600000
 */
import * as path from 'path';
import { ConversationManager } from '../../backend/modules/conversation/ConversationManager';
import { FileSystemStorageAdapter } from '../../backend/modules/conversation/storage';
import { FileUsageIndexStore } from '../../backend/modules/conversation/UsageIndexStore';
import { aggregateUsageStats } from '../../backend/modules/conversation/usageStats';
import type { Content } from '../../backend/modules/conversation/types';
import {
    createRealFsVscodeShim,
    makeTempDir,
    printHarnessBanner,
    printMetric,
    printSection,
    removeTempDir,
    withTiming,
} from './benchmarkHarness';

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
    let rootDir: string;
    let manager: ConversationManager;

    beforeEach(async () => {
        rootDir = await makeTempDir('long-conversation');
        const shim = createRealFsVscodeShim();
        const baseDir = path.join(rootDir, 'data');
        const adapter = new FileSystemStorageAdapter(shim, baseDir);
        const usageStore = new FileUsageIndexStore(shim, baseDir);
        manager = new ConversationManager(adapter, usageStore);
    });

    afterEach(async () => {
        await removeTempDir(rootDir);
    });

    test('1 万条消息：append 增量写 / 全量读取 / usage 统计', async () => {
        printHarnessBanner();
        printSection('MIG-09 基准 ② 长对话（10,000 条消息 / 100 批 × 100 条，真实磁盘）');
        const conversationId = 'bench-long';
        await manager.createConversation(conversationId, 'Benchmark Long Conversation');

        // ---- 0. JIT 预热（F8 同款思路）：主测量前先在独立会话上小规模 append 1 批，
        // 把 addBatch → appendHistory（分段写入/原子 rename/index 重写）与 usage 索引
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

        // ---- 3. usage 统计：走索引（usage.json 新鲜）----
        const usageIndexed = await withTiming(() => aggregateUsageStats(manager, {
            indexStore: manager.getUsageIndexStore(),
        }));
        printMetric({
            label: 'usage 统计（走 usage.json 索引）',
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

        // ---- smoke 断言（校准：2026-08-04 R8e-FIX 实测 append 0.89s / 读 27ms /
        //      usage 索引 12ms / 全量扫描 34ms；上限 append 15s（≈17×）、读 2s、usage 1-2s，
        //      磁盘 IO 留 CI 慢机余量）----
        expect(append.ms).toBeLessThan(15_000);
        expect(read.ms).toBeLessThan(2_000);
        expect(usageIndexed.ms).toBeLessThan(1_000);
        expect(usageScan.ms).toBeLessThan(2_000);

        console.log(`\n  [smoke] append ${append.ms.toFixed(1)}ms / read ${read.ms.toFixed(1)}ms / usage-index ${usageIndexed.ms.toFixed(1)}ms / usage-scan ${usageScan.ms.toFixed(1)}ms（上限 append 15000ms / 其余 1000-2000ms）→ OK`);
    });
});
