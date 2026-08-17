/**
 * SummarizeService.handleAutoSummarize 溢出裁剪 + H1/H2/C 修复回归测试
 *
 * 覆盖（H1 / H2 / H4 / M4 / C）：
 * - 溢出检查与预算估算口径一致（usageMetadata / tokenCountByChannel 优先）
 * - 溢出裁剪循环迭代：整轮排除后重新估算，直到装得下或没有可排除的内容
 * - 全部排除后仍超限：返回 CONTEXT_OVERFLOW，不把必败的请求发给 API
 * - H1 逻辑截断语义：给 [historyStartIndex, insertIndex) 打 isSummarized 标记 + 插入总结在
 *   同一次 mutateContents（会话写锁）内完成；首条用户消息受保护不标记（原始任务指令原样
 *   保留并永远发送），总结成功后历史 = [首条用户消息(如有), 旧总结(如有),
 *   被总结消息(isSummarized), 新总结, 尾巴]，返回 insertIndex = 总结消息插入位置
 *   （= summarizeEndIndex），removedCount = 本次标记的消息数
 * - H2 并发安全：写锁内基于最新历史重新校验；historyStartIndex/insertIndex 越界
 *   或总结范围会吞掉当前回合真实用户消息时返回 STALE_RANGE，不落盘
 * - C 总结质量：summaryText 低于 MIN_SUMMARY_LENGTH 时返回 LOW_QUALITY_SUMMARY，不标记历史
 * - abort（ChannelError.CANCELLED_ERROR / 原生 AbortError）返回 ABORTED，不当作普通失败
 * - previousSummarizedCount 从最后一个总结消息读取；字段缺失时往前找更早的总结消息
 *
 * 注意：functionCall 与其 functionResponse 必须共享同一 id（HistoryIntegrityValidator
 * 会把 functionResponse.id 不在历史中出现的配对判为 orphan_function_response）。
 */

import { ChannelError, ErrorType } from '../../modules/channel/types';
import type { Content } from '../../modules/conversation/types';
import { setGlobalBranchService } from '../../modules/conversation/branch/BranchService';
import { createSummarizeHarness } from '../__fixtures__/harnessFixtures';

afterEach(() => {
    setGlobalBranchService(undefined);
});

// ==================== 消息构造工具 ====================

/** 真实用户消息（带 tokenCountByChannel，走精确估算口径） */
const userMsg = (text: string, tokens: number, extra: Partial<Content> = {}): Content => ({
    role: 'user',
    parts: [{ text }],
    tokenCountByChannel: { openai: tokens },
    ...extra
});

/** functionCall 消息（model 角色，走 usageMetadata 口径） */
const fcMsg = (id: string, tokens: number): Content => ({
    role: 'model',
    parts: [{ functionCall: { name: 'tool', args: {}, id } }],
    usageMetadata: { totalTokenCount: tokens, promptTokenCount: 0 }
});

/** functionResponse 消息（user 角色，与 functionCall 共享 id） */
const frMsg = (id: string, tokens: number): Content => ({
    role: 'user',
    isFunctionResponse: true,
    parts: [{ functionResponse: { name: 'tool', response: { ok: true }, id } }],
    tokenCountByChannel: { openai: tokens }
});

/** model 文本消息（走 usageMetadata 口径） */
const modelMsg = (text: string, tokens: number): Content => ({
    role: 'model',
    parts: [{ text }],
    usageMetadata: { totalTokenCount: tokens, promptTokenCount: 0 }
});

/** 总结消息 */
const summaryMsg = (text: string, extra: Partial<Content> = {}): Content => ({
    role: 'user',
    parts: [{ text }],
    isSummary: true,
    ...extra
});

/** 提取消息的可读标识（functionCall id / functionResponse id / 文本），用于断言历史形态 */
const msgLabel = (m: Content): string =>
    m.parts[0]?.functionCall?.id
    ?? m.parts[0]?.functionResponse?.id
    ?? m.parts[0]?.text
    ?? '';

// ==================== 测试脚手架 ====================



// ==================== 测试用例 ====================

describe('SummarizeService.handleAutoSummarize - 溢出裁剪', () => {
    test('单超大轮（无工具交互）：总结输入溢出 → CONTEXT_OVERFLOW，不发 API 请求', async () => {
        const { service, generate, mutateContents } = createSummarizeHarness({
            // 单轮 3000 + 1000 token。auto 模式允许轮内截断（轮首用户消息受锚点保护不标记），
            // 但总结输入只有用户消息本身（3000 token），超出总结模型输入预算且无工具交互可
            // 收缩 → CONTEXT_OVERFLOW，依然不调用总结模型（避免必败请求）。
            fullHistory: [userMsg('老问题', 3000), modelMsg('老回答', 1000)],
            maxContextTokens: 4000
        });

        const result = await service.handleAutoSummarize('conv1', 'cfg1');

        expect(result.success).toBe(false);
        if (!result.success) {
            expect(result.error.code).toBe('CONTEXT_OVERFLOW');
        }
        expect(generate).not.toHaveBeenCalled();
        expect(mutateContents).not.toHaveBeenCalled();
    });

    test('溢出时排除最后一轮工具交互（整轮一起排除），重新估算后正常总结并逻辑截断', async () => {
        const { service, generate, liveHistory } = createSummarizeHarness({
            // 三轮：500 / 500 / 400；预算 100 → 轮内细粒度切点落在轮3尾部（1400 token 被纳入总结），
            // maxInput = 1000 * 0.9 = 900 → 逐轮向前排除，最终只总结轮1（500 token）
            fullHistory: [
                userMsg('r1', 100), fcMsg('fc1', 200), frMsg('fc1', 200),
                userMsg('r2', 100), fcMsg('fc2', 200), frMsg('fc2', 200),
                userMsg('r3', 100), fcMsg('fc3', 100), frMsg('fc3', 100),
                modelMsg('done', 100)
            ],
            summarizeMaxInputRatio: 0.9
        });

        const result = await service.handleAutoSummarize('conv1', 'cfg1');

        expect(result.success).toBe(true);
        if (result.success) {
            // 首条用户消息 r1（index 0）不标记：标记区间从它之后开始 [1, 3) = fc1/fr1
            expect(result.insertIndex).toBe(3);
            expect(result.removedCount).toBe(2);
            expect(result.summarizedMessageCount).toBe(2);
        }
        expect(generate).toHaveBeenCalledTimes(1);
        const history = (generate.mock.calls[0][0] as { history: Content[] }).history;
        // 3 条被总结消息 + 1 条总结提示词
        expect(history.length).toBe(4);

        // H1：历史 = [首条用户消息 r1, fc1/fr1(isSummarized), 新总结, 尾巴]，原文完整保留
        expect(liveHistory).toHaveLength(10 + 1);
        expect(liveHistory[0].parts[0].text).toBe('r1');
        expect(liveHistory[1]).toMatchObject({ isSummarized: true });
        expect(liveHistory[2]).toMatchObject({ isSummarized: true });
        expect(liveHistory[3]).toMatchObject({ isSummary: true, isAutoSummary: true, index: 3 });
        expect(liveHistory[3].parts[0].text).toContain('[对话总结]');
        expect(liveHistory.slice(4).map(msgLabel)).toEqual(['r2', 'fc2', 'fc2', 'r3', 'fc3', 'fc3', 'done']);
    });

    test('同一轮内的多个工具交互一起排除（不拆散轮）', async () => {
        const { service, generate, liveHistory } = createSummarizeHarness({
            // 轮2 有两个工具交互（fc2a/fc2b）；总结范围 = 轮1+轮2 = 800 token > 500
            fullHistory: [
                userMsg('r1', 100), fcMsg('fc1', 100), frMsg('fc1', 100),
                userMsg('r2', 100), fcMsg('fc2a', 100), frMsg('fc2a', 100),
                fcMsg('fc2b', 100), frMsg('fc2b', 100),
                userMsg('r3', 100), fcMsg('fc3', 100), frMsg('fc3', 100),
                modelMsg('done', 100)
            ],
            summarizeMaxInputRatio: 0.9
        });

        const result = await service.handleAutoSummarize('conv1', 'cfg1');

        expect(result.success).toBe(true);
        if (result.success) {
            // 整轮2（含两个工具交互与轮首用户消息）一起排除，被总结区间 = [1, 3)（fc1/fr1，r1 不标记）
            expect(result.insertIndex).toBe(3);
            expect(result.removedCount).toBe(2);
        }
        expect(generate).toHaveBeenCalledTimes(1);
        expect(liveHistory[0].parts[0].text).toBe('r1');
        expect(liveHistory[1]).toMatchObject({ isSummarized: true });
        expect(liveHistory[2]).toMatchObject({ isSummarized: true });
        expect(liveHistory.slice(4).map(msgLabel))
            .toEqual(['r2', 'fc2a', 'fc2a', 'fc2b', 'fc2b', 'r3', 'fc3', 'fc3', 'done']);
    });

    test('多轮 + 当前轮超预算：auto 钳制切点到当前回合起点，总结更早内容并保留整个当前轮', async () => {
        const { service, generate, liveHistory } = createSummarizeHarness({
            // 轮1 = 100 token，轮2（当前轮）= 1000 token；预算 50% × 1100 = 550
            // 轮级边界（index 2）后缀 1000 > 550 → planner 会深入当前轮找切点（cutIndex=5），
            // auto 钳制到当前轮起点（index 2）：总结 [r1, old answer]，保留整个当前轮。
            // 旧行为：切点深入当前轮 → 锁内 STALE 拒绝 → 白烧一次 AI 生成。
            fullHistory: [
                userMsg('r1', 50), modelMsg('old answer', 50),
                userMsg('r2', 100), fcMsg('a', 200), frMsg('a', 200),
                fcMsg('b', 200), frMsg('b', 200), modelMsg('done', 100)
            ],
            keepRecentTokens: '50%'
        });

        const result = await service.handleAutoSummarize('conv1', 'cfg1');

        expect(result.success).toBe(true);
        if (result.success) {
            // 首条用户消息 r1 不标记：标记 [1, 2) = old answer，总结插入 index 2（当前轮起点）
            expect(result.insertIndex).toBe(2);
            expect(result.removedCount).toBe(1);
            expect(result.summarizedMessageCount).toBe(1);
        }
        expect(generate).toHaveBeenCalledTimes(1);
        // 历史 = [r1, old answer(isSummarized), 新总结, r2, fc a, fr a, fc b, fr b, done]
        expect(liveHistory).toHaveLength(9);
        expect(liveHistory[0].parts[0].text).toBe('r1');
        expect(liveHistory[0].isSummarized).toBeUndefined();
        expect(liveHistory[1]).toMatchObject({ isSummarized: true });
        expect(liveHistory[2]).toMatchObject({ isSummary: true, isAutoSummary: true, index: 2 });
        expect(liveHistory.slice(3).map(msgLabel)).toEqual(['r2', 'a', 'a', 'b', 'b', 'done']);
    });

    test('迭代排除后仍超限：返回 CONTEXT_OVERFLOW，不发 API 请求', async () => {
        const { service, generate, mutateContents } = createSummarizeHarness({
            // 轮1 = 700 token：排除轮2（300）后仍剩 700 > 500，继续排除时轮1起点即范围起点 → 无法收缩
            // 预算 20%（200）使规划器能先产生一个可用的轮内切点（cutIndex=7）
            fullHistory: [
                userMsg('r1', 100), fcMsg('fc1', 300), frMsg('fc1', 300),
                userMsg('r2', 100), fcMsg('fc2', 100), frMsg('fc2', 100),
                userMsg('r3', 100), fcMsg('fc3', 100), frMsg('fc3', 100)
            ],
            keepRecentTokens: '20%'
        });

        const result = await service.handleAutoSummarize('conv1', 'cfg1');

        expect(result.success).toBe(false);
        if (!result.success) {
            expect(result.error.code).toBe('CONTEXT_OVERFLOW');
        }
        expect(generate).not.toHaveBeenCalled();
        expect(mutateContents).not.toHaveBeenCalled();
    });

    test('从旧总结开始的范围：previousSummarizedCount 从最后一个总结消息读取，历史 = [旧总结, 新总结, 尾巴]', async () => {
        const { service, generate, liveHistory } = createSummarizeHarness({
            fullHistory: [
                summaryMsg('sum1', { summarizedMessageCount: 4 }),
                fcMsg('fc1', 100), frMsg('fc1', 100),
                userMsg('r2', 100), fcMsg('fc2', 100), frMsg('fc2', 100),
                modelMsg('done', 100)
            ],
            lastSummaryIndex: 0
        });

        const result = await service.handleAutoSummarize('conv1', 'cfg1');

        expect(result.success).toBe(true);
        if (result.success) {
            // 旧总结累计覆盖 4 条 + 本次新标记 [fc1, fr1]（2 条）= 6
            expect(result.summarizedMessageCount).toBe(6);
            // 逻辑截断：标记区间 [1, 3)（fc1/fr1），总结插入位置 = summarizeEndIndex = 3
            expect(result.insertIndex).toBe(3);
            expect(result.removedCount).toBe(2);
        }
        expect(generate).toHaveBeenCalledTimes(1);

        // 逻辑截断：历史 = [旧总结, fc1/fr1(isSummarized), 新总结, 尾巴]
        expect(liveHistory).toHaveLength(7 + 1);
        expect(liveHistory[0]).toMatchObject({ isSummary: true });
        expect(liveHistory[0].parts[0].text).toBe('sum1');
        expect(liveHistory[1]).toMatchObject({ isSummarized: true });
        expect(liveHistory[2]).toMatchObject({ isSummarized: true });
        expect(liveHistory[3]).toMatchObject({ isSummary: true, isAutoSummary: true, index: 3 });
        expect(liveHistory.slice(4).map(msgLabel)).toEqual(['r2', 'fc2', 'fc2', 'done']);
    });

    test('旧总结后的同轮延续没有真实用户消息：按保留预算截断前半段并承接旧总结', async () => {
        const { service, generate, liveHistory } = createSummarizeHarness({
            fullHistory: [
                userMsg('initial task', 100, { id: 'u1' }),
                summaryMsg('sum1', { summarizedMessageCount: 4 }),
                fcMsg('fc1', 100), frMsg('fc1', 100),
                fcMsg('fc2', 100), frMsg('fc2', 100),
                fcMsg('fc3', 100), frMsg('fc3', 100), modelMsg('done', 100)
            ],
            lastSummaryIndex: 1,
            keepRecentTokens: '50%',
            keepRecentRounds: 2,
            maxContextTokens: 2000
        });

        const result = await service.handleAutoSummarize('conv1', 'cfg1');

        expect(result.success).toBe(true);
        if (result.success) {
            // 旧总结后的活跃后缀共 700 token，保留预算 350：保留 fc3/fr3/done（300），
            // 把 fc1/fr1/fc2/fr2 四条纳入新总结并插入原 index 6。
            expect(result.insertIndex).toBe(6);
            expect(result.removedCount).toBe(4);
            expect(result.summarizedMessageCount).toBe(8);
        }
        expect(generate).toHaveBeenCalledTimes(1);
        const requestHistory = (generate.mock.calls[0][0] as { history: Content[] }).history;
        // 新总结输入 = 旧总结 + 本次截断的前半段 + 总结提示词。
        expect(requestHistory.slice(0, -1).map(msgLabel)).toEqual(['sum1', 'fc1', 'fc1', 'fc2', 'fc2']);

        // 物理历史保留被标记的原文；过滤 isSummarized 后的有效顺序为：
        // 首条用户消息 → sum1 + 承接它的新总结 → 最近实际记录。新用户消息由调用方随后追加。
        const effectiveHistory = liveHistory.filter(message => !message.isSummarized);
        expect(effectiveHistory).toHaveLength(6);
        expect(msgLabel(effectiveHistory[0])).toBe('initial task');
        expect(msgLabel(effectiveHistory[1])).toBe('sum1');
        expect(effectiveHistory[2]).toMatchObject({ isSummary: true, isAutoSummary: true, index: 6 });
        expect(effectiveHistory.slice(3).map(msgLabel)).toEqual(['fc3', 'fc3', 'done']);
    });

    test('最后一个总结缺 summarizedMessageCount：往前找更早总结的累计值，不回退数组下标', async () => {
        const { service, generate, liveHistory } = createSummarizeHarness({
            fullHistory: [
                summaryMsg('sum1', { summarizedMessageCount: 3 }),
                modelMsg('m1', 100),
                summaryMsg('sum2'), // 缺 summarizedMessageCount
                userMsg('r3', 50), modelMsg('m3', 50),
                userMsg('r4', 100), fcMsg('fc4', 100), frMsg('fc4', 100)
            ],
            lastSummaryIndex: 2,
            // 80% × 活跃历史（r3 50 + m3 50 + r4 100 + fc4 100 + fr4 100 = 400）= 320：
            // 轮级边界落在 r4 轮首（r4 轮 300 <= 320，细切点无需深入轮内），cutIndex=2 → insertIndex=5；
            // ratio 0.9 保证总结输入预算（≈500）装得下 [sum2, r3, m3]（≈102 token）
            keepRecentTokens: '80%',
            summarizeMaxInputRatio: 0.9
        });

        const result = await service.handleAutoSummarize('conv1', 'cfg1');

        expect(result.success).toBe(true);
        if (result.success) {
            // 旧累计 3（sum1）+ 本次实际标记 1（m3 是 r3 之后的 model 消息，可被标记）= 4；
            // 旧实现会回退到数组下标 2 得出 3
            expect(result.summarizedMessageCount).toBe(4);
            expect(result.insertIndex).toBe(5); // 总结插入到 m3 之后（r4 轮首，原 insertIndex 位置）
            expect(result.removedCount).toBe(1);
        }
        expect(generate).toHaveBeenCalledTimes(1);
        // 历史 = [sum1, m1, sum2, r3(首条用户消息,保留), m3(isSummarized), 新总结, r4, fc4, fc4]
        expect(liveHistory).toHaveLength(8 + 1);
        expect(liveHistory[3].parts[0].text).toBe('r3');
        expect(liveHistory[4]).toMatchObject({ isSummarized: true });
        expect(liveHistory[5]).toMatchObject({ isSummary: true, isAutoSummary: true, index: 5 });
        expect(liveHistory.slice(6).map(msgLabel)).toEqual(['r4', 'fc4', 'fc4']);
    });

    test('单轮长工具回合：auto 按保留预算轮内截断，总结已完成前缀，首条用户消息原样保留', async () => {
        // 单轮 800 token，keepRecentTokens='50%' → 保留预算 400。planner 从前往后选第一个
        // 不超预算的安全切点：fc3 起（300）≤ 400 → 总结 [0, 5)，保留 [fc3, fr3, done]。
        // 轮首用户消息 r1 是唯一真实用户消息（同时是首条锚点）：不标记、原文保留发送。
        const { service, generate, liveHistory } = createSummarizeHarness({
            fullHistory: [
                userMsg('r1', 100, { id: 'u1' }), fcMsg('fc1', 100), frMsg('fc1', 100),
                fcMsg('fc2', 100), frMsg('fc2', 100),
                fcMsg('fc3', 100), frMsg('fc3', 100), modelMsg('done', 100)
            ],
            keepRecentTokens: '50%',
            // 总结模型输入预算（1000 * 0.5 - 固定开销）需装得下 500 token 的总结范围，避免触发收缩
            maxContextTokens: 2000
        });

        const result = await service.handleAutoSummarize('conv1', 'cfg1');

        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.insertIndex).toBe(5);
            expect(result.removedCount).toBe(4);
            expect(result.summarizedMessageCount).toBe(4);
        }
        expect(generate).toHaveBeenCalledTimes(1);
        // 历史 = [r1, fc1/fr1/fc2/fr2(isSummarized), 新总结, fc3, fr3, done]
        expect(liveHistory).toHaveLength(9);
        expect(liveHistory[0].parts[0].text).toBe('r1');
        expect(liveHistory[0].isSummarized).toBeUndefined();
        expect(liveHistory[1]).toMatchObject({ isSummarized: true });
        expect(liveHistory[2]).toMatchObject({ isSummarized: true });
        expect(liveHistory[3]).toMatchObject({ isSummarized: true });
        expect(liveHistory[4]).toMatchObject({ isSummarized: true });
        expect(liveHistory[5]).toMatchObject({ isSummary: true, isAutoSummary: true, index: 5 });
        expect(liveHistory.slice(6).map(msgLabel)).toEqual(['fc3', 'fc3', 'done']);
    });

    test('单轮总结输入超预算：沿工具边界逐对收缩，保留最新工具轮', async () => {
        // 单轮 14100 token，总结输入预算 ~7500（100000 * 0.08 减固定开销）：总结范围 [0, 7)
        // 超出预算 → 轮内收缩逐对排除最新工具交互（fc3/fr3 → fc2/fr2），收缩到 [0, 3) 装得下。
        // 轮内收缩切点落在 functionCall 消息上，FC+FR 同在保留区，配对完整不拆散。
        const { service, generate, liveHistory } = createSummarizeHarness({
            fullHistory: [
                userMsg('r1', 100, { id: 'u1' }), fcMsg('fc1', 2000), frMsg('fc1', 2000),
                fcMsg('fc2', 2000), frMsg('fc2', 2000),
                fcMsg('fc3', 2000), frMsg('fc3', 2000), modelMsg('done', 2000)
            ],
            keepRecentTokens: '10%',
            summarizeMaxInputRatio: 0.08,
            maxContextTokens: 100000
        });

        const result = await service.handleAutoSummarize('conv1', 'cfg1');

        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.insertIndex).toBe(3);
            expect(result.removedCount).toBe(2);
        }
        expect(generate).toHaveBeenCalledTimes(1);
        // 历史 = [r1, fc1/fr1(isSummarized), 新总结, fc2, fr2, fc3, fr3, done]
        expect(liveHistory[0].parts[0].text).toBe('r1');
        expect(liveHistory[0].isSummarized).toBeUndefined();
        expect(liveHistory[1]).toMatchObject({ isSummarized: true });
        expect(liveHistory[2]).toMatchObject({ isSummarized: true });
        expect(liveHistory[3]).toMatchObject({ isSummary: true, index: 3 });
        expect(liveHistory.slice(4).map(msgLabel)).toEqual(['fc2', 'fc2', 'fc3', 'fc3', 'done']);
    });
});

describe('SummarizeService.handleAutoSummarize - 逻辑截断语义', () => {
    test('无旧总结时：历史 = [第一条用户消息, 被总结消息(isSummarized), 新总结, 尾巴]，removedCount 正确', async () => {
        const structuralSync = jest.fn(async () => ({ synced: true, deferred: false }));
        setGlobalBranchService({ syncMainHistoryAfterStructuralMutation: structuralSync } as any);
        const { service, liveHistory } = createSummarizeHarness({
            fullHistory: [
                userMsg('r1', 50), fcMsg('fc1', 50), frMsg('fc1', 50),
                userMsg('r2', 100), fcMsg('fc2', 100), frMsg('fc2', 100),
                modelMsg('done', 100)
            ]
        });

        const result = await service.handleAutoSummarize('conv1', 'cfg1');

        expect(result.success).toBe(true);
        if (result.success) {
            // 首条用户消息 r1 不标记：标记 [1, 3) = fc1/fr1，总结插入到 3
            expect(result.insertIndex).toBe(3);
            expect(result.removedCount).toBe(2);
            expect(result.summarizedMessageCount).toBe(2);
        }
        // 逻辑截断：原文保留，历史 = [r1, fc1/fr1(isSummarized), 新总结, 尾巴]
        expect(liveHistory).toHaveLength(7 + 1);
        expect(liveHistory[0].parts[0].text).toBe('r1');
        expect(liveHistory[1]).toMatchObject({ isSummarized: true });
        expect(liveHistory[2]).toMatchObject({ isSummarized: true });
        expect(liveHistory[3]).toMatchObject({ isSummary: true, isAutoSummary: true, index: 3 });
        expect(liveHistory.slice(4).map(msgLabel)).toEqual(['r2', 'fc2', 'fc2', 'done']);
        expect(structuralSync).toHaveBeenCalledWith('conv1', 'summary_inserted');
    });
});

describe('SummarizeService.handleAutoSummarize 并发安全（STALE_RANGE）', () => {
    test('并发删除导致 insertIndex 越界：放弃总结（STALE_RANGE），不落盘', async () => {
        const planningSnapshot: Content[] = [
            userMsg('r1', 100), fcMsg('fc1', 100), frMsg('fc1', 100),
            userMsg('r2', 100)
        ];
        // 规划时 insertIndex=3（总结 r1 轮）；替换前并发删除把历史缩短到 1 条
        const concurrentShrunkenHistory: Content[] = [userMsg('r1', 100)];

        const { service, generate, mutateContents, liveHistory } = createSummarizeHarness({
            fullHistory: planningSnapshot,
            historyRef: planningSnapshot,
            liveHistory: concurrentShrunkenHistory,
            summarizeMaxInputRatio: 0.9
        });

        const result = await service.handleAutoSummarize('conv1', 'cfg1');

        expect(result.success).toBe(false);
        if (!result.success) {
            expect(result.error.code).toBe('STALE_RANGE');
        }
        expect(generate).toHaveBeenCalledTimes(1);
        expect(mutateContents).toHaveBeenCalledTimes(1);
        // 不落盘：历史保持并发写入后的形态，没有总结消息
        expect(liveHistory).toEqual([userMsg('r1', 100)]);
    });

    test('单轮轮内截断期间新真实用户消息插入锚点之后：锚点校验作废（STALE_RANGE），不落盘', async () => {
        const planningSnapshot: Content[] = [
            userMsg('r1', 100, { id: 'u1' }), fcMsg('fc1', 2000), frMsg('fc1', 2000),
            fcMsg('fc2', 2000), frMsg('fc2', 2000), modelMsg('done', 2000)
        ];
        // 规划时单轮（锚点 u1 在 index 0），总结范围 [0, 5)（insertIndex=5，越过锚点标记其后前缀）；
        // 总结生成期间新真实用户消息插入到锚点之后、切点之前（index 3）→ 锁内最后真实用户
        // 消息索引与规划锚点不一致 → 放弃落盘，避免把用户新输入也算进被总结区间。
        const concurrentNewUserMessage: Content[] = [
            userMsg('r1', 100, { id: 'u1' }), fcMsg('fc1', 2000), frMsg('fc1', 2000),
            userMsg('new user input', 100, { id: 'u2' }),
            fcMsg('fc2', 2000), frMsg('fc2', 2000), modelMsg('done', 2000)
        ];

        const { service, generate, mutateContents, liveHistory } = createSummarizeHarness({
            fullHistory: planningSnapshot,
            historyRef: planningSnapshot,
            liveHistory: concurrentNewUserMessage,
            keepRecentTokens: '10%',
            // 预算（100000 * 0.5 - 固定开销 ≈ 49600）装得下 8100 token 的总结范围 → 不触发收缩，
            // insertIndex 保持 5，锁内 5 > 3（新消息索引）→ 锚点校验失败
            maxContextTokens: 100000
        });

        const result = await service.handleAutoSummarize('conv1', 'cfg1');

        expect(result.success).toBe(false);
        if (!result.success) {
            expect(result.error.code).toBe('STALE_RANGE');
        }
        expect(generate).toHaveBeenCalledTimes(1);
        expect(mutateContents).toHaveBeenCalledTimes(1);
        // 不落盘：历史保持并发写入后的形态，没有总结消息
        expect(liveHistory).toHaveLength(7);
        expect(liveHistory.some(m => m.isSummary)).toBe(false);
    });
});

describe('SummarizeService.handleAutoSummarize - C 总结质量校验', () => {
    test('总结文本低于 MIN_SUMMARY_LENGTH：返回 LOW_QUALITY_SUMMARY，不替换历史', async () => {
        const history: Content[] = [
            userMsg('r1', 100), fcMsg('fc1', 100), frMsg('fc1', 100),
            userMsg('r2', 100), fcMsg('fc2', 100), frMsg('fc2', 100)
        ];
        const { service, generate, liveHistory } = createSummarizeHarness({
            fullHistory: history,
            keepRecentTokens: '50%', // 500：轮级边界落在 r2 轮首（round 边界），总结 r1 轮
            summarizeMaxInputRatio: 0.9,
            generateContent: {
                role: 'model',
                parts: [{ text: 'ok' }], // 2 字符 < 50
                usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 10 }
            }
        });

        const result = await service.handleAutoSummarize('conv1', 'cfg1');

        expect(result.success).toBe(false);
        if (!result.success) {
            expect(result.error.code).toBe('LOW_QUALITY_SUMMARY');
        }
        expect(generate).toHaveBeenCalledTimes(1);
        expect(liveHistory).toEqual(history);
    });
});

describe('SummarizeService.handleAutoSummarize - abort 判定', () => {
    test('ChannelError CANCELLED_ERROR：返回 ABORTED 而非普通失败', async () => {
        const { service, generate } = createSummarizeHarness({
            fullHistory: [userMsg('q1', 100), userMsg('q2', 100)],
            generateError: new ChannelError(ErrorType.CANCELLED_ERROR, 'cancelled')
        });

        const result = await service.handleAutoSummarize('conv1', 'cfg1');

        expect(generate).toHaveBeenCalledTimes(1);
        expect(result.success).toBe(false);
        if (!result.success) {
            expect(result.error.code).toBe('ABORTED');
        }
    });

    test('原生 AbortError：返回 ABORTED 而非普通失败', async () => {
        const abortError = new Error('aborted');
        abortError.name = 'AbortError';
        const { service, generate } = createSummarizeHarness({
            fullHistory: [userMsg('q1', 100), userMsg('q2', 100)],
            generateError: abortError
        });

        const result = await service.handleAutoSummarize('conv1', 'cfg1');

        expect(generate).toHaveBeenCalledTimes(1);
        expect(result.success).toBe(false);
        if (!result.success) {
            expect(result.error.code).toBe('ABORTED');
        }
    });

    test('普通 API 错误仍按 UNKNOWN_ERROR 返回', async () => {
        const { service, generate } = createSummarizeHarness({
            fullHistory: [userMsg('q1', 100), userMsg('q2', 100)],
            generateError: new Error('rate limited')
        });

        const result = await service.handleAutoSummarize('conv1', 'cfg1');

        expect(generate).toHaveBeenCalledTimes(1);
        expect(result.success).toBe(false);
        if (!result.success) {
            expect(result.error.code).toBe('UNKNOWN_ERROR');
        }
    });
});
