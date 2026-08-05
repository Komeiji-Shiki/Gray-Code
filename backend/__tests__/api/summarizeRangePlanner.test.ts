/**
 * summarizeRangePlanner 单元测试
 *
 * 覆盖：
 * - resolveKeepRecentTokenBudget：预算配置解析（数字/百分比/数字字符串/非法值兜底）
 * - planSummarizeRounds：基于 token 预算的轮级保留规划与回退级联
 * - planIntraRoundSplit：单个超大轮的轮内截断切点选择
 */

import {
    resolveKeepRecentTokenBudget,
    planSummarizeRounds,
    planIntraRoundSplit,
    planSummarizeMessages
} from '../../modules/api/chat/services/summarizeRangePlanner';
import { DEFAULT_KEEP_RECENT_TOKENS } from '../../modules/settings/types';
import type { Content } from '../../modules/conversation/types';

const MAX_CONTEXT = 100000;
// 回落预算跟随设置系统的单一事实来源 DEFAULT_KEEP_RECENT_TOKENS 动态派生
const FALLBACK_BUDGET = resolveKeepRecentTokenBudget(DEFAULT_KEEP_RECENT_TOKENS, MAX_CONTEXT);

describe('resolveKeepRecentTokenBudget', () => {
    it('内置默认值 DEFAULT_KEEP_RECENT_TOKENS 恒可解析且非退化', () => {
        expect(FALLBACK_BUDGET).toBeGreaterThan(0);
        expect(FALLBACK_BUDGET).toBeLessThanOrEqual(MAX_CONTEXT);
    });

    it('未配置时回落到内置默认值', () => {
        expect(resolveKeepRecentTokenBudget(undefined, MAX_CONTEXT)).toBe(FALLBACK_BUDGET);
    });

    it('正数直接使用（向下取整）', () => {
        expect(resolveKeepRecentTokenBudget(30000, MAX_CONTEXT)).toBe(30000);
        expect(resolveKeepRecentTokenBudget(1234.7, MAX_CONTEXT)).toBe(1234);
    });

    it('非法数字回落默认', () => {
        expect(resolveKeepRecentTokenBudget(0, MAX_CONTEXT)).toBe(FALLBACK_BUDGET);
        expect(resolveKeepRecentTokenBudget(-100, MAX_CONTEXT)).toBe(FALLBACK_BUDGET);
        expect(resolveKeepRecentTokenBudget(Number.NaN, MAX_CONTEXT)).toBe(FALLBACK_BUDGET);
    });

    it('百分比字符串按最大上下文换算', () => {
        expect(resolveKeepRecentTokenBudget('25%', MAX_CONTEXT)).toBe(25000);
        expect(resolveKeepRecentTokenBudget('50%', MAX_CONTEXT)).toBe(50000);
        expect(resolveKeepRecentTokenBudget(' 10% ', MAX_CONTEXT)).toBe(10000);
    });

    it('非法百分比回落默认', () => {
        expect(resolveKeepRecentTokenBudget('0%', MAX_CONTEXT)).toBe(FALLBACK_BUDGET);
        expect(resolveKeepRecentTokenBudget('150%', MAX_CONTEXT)).toBe(FALLBACK_BUDGET);
        expect(resolveKeepRecentTokenBudget('abc%', MAX_CONTEXT)).toBe(FALLBACK_BUDGET);
    });

    it('数字字符串作为绝对 token 数', () => {
        expect(resolveKeepRecentTokenBudget('30000', MAX_CONTEXT)).toBe(30000);
    });

    it('空串与无法解析的字符串回落默认', () => {
        expect(resolveKeepRecentTokenBudget('', MAX_CONTEXT)).toBe(FALLBACK_BUDGET);
        expect(resolveKeepRecentTokenBudget('   ', MAX_CONTEXT)).toBe(FALLBACK_BUDGET);
        expect(resolveKeepRecentTokenBudget('abc', MAX_CONTEXT)).toBe(FALLBACK_BUDGET);
    });
});

describe('planSummarizeRounds', () => {
    it('没有任何轮时返回 no_rounds', () => {
        expect(planSummarizeRounds({
            roundTokens: [],
            keepBudgetTokens: 10000,
            minKeepRounds: 2,
            mode: 'auto'
        })).toEqual({ type: 'none', reason: 'no_rounds' });
    });

    it('常规场景：按预算从后往前保留，超出预算的更早轮次被总结', () => {
        // 尾部累计：1000 -> 2000 -> 3000（超出 2500 停止），保留最后 2 轮
        expect(planSummarizeRounds({
            roundTokens: [1000, 1000, 1000, 1000],
            keepBudgetTokens: 2500,
            minKeepRounds: 1,
            mode: 'auto'
        })).toEqual({ type: 'rounds', keepFromRound: 2 });
    });

    it('预算更大时保留更多轮', () => {
        expect(planSummarizeRounds({
            roundTokens: [1000, 1000, 1000, 1000],
            keepBudgetTokens: 3500,
            minKeepRounds: 1,
            mode: 'manual'
        })).toEqual({ type: 'rounds', keepFromRound: 1 });
    });

    it('minKeepRounds 作为下限保护可以扩大保留范围（优先于预算）', () => {
        // 预算只够留最后 1 轮，但 minKeep=3 强制保留最近 3 轮
        expect(planSummarizeRounds({
            roundTokens: [1000, 1000, 1000, 1000],
            keepBudgetTokens: 1500,
            minKeepRounds: 3,
            mode: 'auto'
        })).toEqual({ type: 'rounds', keepFromRound: 1 });
    });

    it('肥尾轮 + minKeep 挡住总结：auto 防死锁回退到纯预算结果', () => {
        // 预算只装得下最后一轮，minKeep=2 会挡住任何总结
        expect(planSummarizeRounds({
            roundTokens: [30000, 30000],
            keepBudgetTokens: 2000,
            minKeepRounds: 2,
            mode: 'auto'
        })).toEqual({ type: 'rounds', keepFromRound: 1 });
    });

    it('肥尾轮 + minKeep 挡住总结：manual 尊重配置返回轮数不足', () => {
        expect(planSummarizeRounds({
            roundTokens: [30000, 30000],
            keepBudgetTokens: 2000,
            minKeepRounds: 2,
            mode: 'manual'
        })).toEqual({ type: 'none', reason: 'not_enough_rounds' });
    });

    it('预算装得下全部轮且有可总结轮：退化为旧行为（保留 minKeep 轮）', () => {
        const expected = { type: 'rounds', keepFromRound: 1 };
        expect(planSummarizeRounds({
            roundTokens: [100, 100, 100],
            keepBudgetTokens: 10000,
            minKeepRounds: 2,
            mode: 'manual'
        })).toEqual(expected);
        expect(planSummarizeRounds({
            roundTokens: [100, 100, 100],
            keepBudgetTokens: 10000,
            minKeepRounds: 2,
            mode: 'auto'
        })).toEqual(expected);
    });

    it('预算装得下全部轮且轮数不足 minKeep：auto 只保留当前轮，manual 报错', () => {
        expect(planSummarizeRounds({
            roundTokens: [100, 100],
            keepBudgetTokens: 10000,
            minKeepRounds: 2,
            mode: 'auto'
        })).toEqual({ type: 'rounds', keepFromRound: 1 });
        expect(planSummarizeRounds({
            roundTokens: [100, 100],
            keepBudgetTokens: 10000,
            minKeepRounds: 2,
            mode: 'manual'
        })).toEqual({ type: 'none', reason: 'not_enough_rounds' });
    });

    it('单个小轮：没有可总结内容', () => {
        expect(planSummarizeRounds({
            roundTokens: [100],
            keepBudgetTokens: 10000,
            minKeepRounds: 2,
            mode: 'auto'
        })).toEqual({ type: 'none', reason: 'not_enough_rounds' });
    });

    it('单个超大轮：请求轮内截断', () => {
        expect(planSummarizeRounds({
            roundTokens: [50000],
            keepBudgetTokens: 10000,
            minKeepRounds: 2,
            mode: 'auto'
        })).toEqual({ type: 'intra_round' });
        expect(planSummarizeRounds({
            roundTokens: [50000],
            keepBudgetTokens: 10000,
            minKeepRounds: 2,
            mode: 'manual'
        })).toEqual({ type: 'intra_round' });
    });

    it('minKeepRounds 非法值按 1 处理', () => {
        expect(planSummarizeRounds({
            roundTokens: [1000, 1000],
            keepBudgetTokens: 5000,
            minKeepRounds: 0,
            mode: 'manual'
        })).toEqual({ type: 'rounds', keepFromRound: 1 });
    });
});

describe('planIntraRoundSplit', () => {
    const user = (text: string): Content => ({ role: 'user', parts: [{ text }] });
    const modelText = (text: string): Content => ({ role: 'model', parts: [{ text }] });
    const fc = (id: string): Content => ({
        role: 'model',
        parts: [{ functionCall: { name: 'tool', args: {}, id } }]
    });
    const fr = (id: string): Content => ({
        role: 'user',
        isFunctionResponse: true,
        parts: [{ functionResponse: { name: 'tool', response: {}, id } }]
    });

    it('典型工具轮：选择最早的满足预算的 model 切点（保留最多）', () => {
        // 索引:      0     1        2        3        4        5        6        7
        const messages = [user('q'), fc('a'), fr('a'), fc('b'), fr('b'), fc('c'), fr('c'), modelText('done')];
        const messageTokens = [1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000];
        // 候选切点：1(fc a), 3(fc b), 5(fc c), 7(text)
        // 后缀累计：cut=5 -> 3000 <= 3500，cut=3 -> 5000 超预算
        const result = planIntraRoundSplit({ messages, messageTokens, keepBudgetTokens: 3500 });
        expect(result).toEqual({ cutIndex: 5 });
    });

    it('所有候选都超预算时取最后一个切点（保留最少，防死锁）', () => {
        const messages = [user('q'), fc('a'), fr('a'), fc('b'), fr('b'), modelText('done')];
        const messageTokens = [10000, 10000, 10000, 10000, 10000, 10000];
        const result = planIntraRoundSplit({ messages, messageTokens, keepBudgetTokens: 500 });
        expect(result).toEqual({ cutIndex: 5 });
    });

    it('轮内没有 model 消息时无法截断', () => {
        const messages = [user('q'), fr('a')];
        expect(planIntraRoundSplit({
            messages,
            messageTokens: [100, 100],
            keepBudgetTokens: 50
        })).toBeNull();
    });

    it('切点会导致孤儿 functionResponse 时向后寻找完整切点', () => {
        // 异常结构：fr('a') 与其 fc('a') 之间隔了一条 model 文本
        // 索引:      0     1        2             3        4        5
        const messages = [user('q'), fc('a'), modelText('m'), fr('a'), fc('b'), fr('b')];
        const messageTokens = [100, 100, 100, 100, 100, 100];
        // 候选：1(fc a), 2(text), 4(fc b)；预算 400 -> 首选 cut=2（后缀 400）
        // 但保留 [text, fr(a), fc(b), fr(b)] 中 fr(a) 是孤儿 -> 后移到 cut=4
        const result = planIntraRoundSplit({ messages, messageTokens, keepBudgetTokens: 400 });
        expect(result).toEqual({ cutIndex: 4 });
    });

    it('预算充足时选择最早的 model 切点（总结掉的内容最少）', () => {
        const messages = [user('q'), fc('a'), fr('a'), modelText('done')];
        const messageTokens = [100, 100, 100, 100];
        const result = planIntraRoundSplit({ messages, messageTokens, keepBudgetTokens: 10000 });
        expect(result).toEqual({ cutIndex: 1 });
    });
});

describe('planSummarizeMessages', () => {
    const user = (text: string): Content => ({ role: 'user', parts: [{ text }], isUserInput: true });
    const modelText = (text: string): Content => ({ role: 'model', parts: [{ text }] });
    const fc = (id: string): Content => ({
        role: 'model',
        parts: [{ functionCall: { name: 'tool', args: {}, id } }]
    });
    const fr = (id: string): Content => ({
        role: 'user',
        isFunctionResponse: true,
        parts: [{ functionResponse: { name: 'tool', response: {}, id } }]
    });

    it('多轮历史中的肥工具轮按安全 model 边界细分，而不是整轮总结', () => {
        const messages = [
            user('old'), modelText('old answer'),
            user('fat'), fc('a'), fr('a'), fc('b'), fr('b'), modelText('fat done'),
            user('current'), modelText('current answer')
        ];
        const messageTokens = [10, 10, 10, 40, 40, 40, 40, 10, 10, 10];

        const plan = planSummarizeMessages({
            messages,
            messageTokens,
            keepBudgetTokens: 100,
            minKeepRounds: 1,
            mode: 'auto'
        });

        // 轮级算法会直接切到 current(index 8)；细粒度算法保留 fat 轮尾部的完成消息。
        expect(plan).toEqual({ cutIndex: 7, boundary: 'intra_round' });
        expect(validateHistoryIntegrityForTest(messages.slice(plan!.cutIndex))).toBe(true);
    });

    it('候选切点会拆散 functionCall/functionResponse 时继续寻找后续安全边界', () => {
        const messages = [
            user('q'),
            fc('a'),
            modelText('intermediate'),
            fr('a'),
            fc('b'),
            fr('b'),
            modelText('done'),
            user('next'),
            modelText('next answer')
        ];
        const plan = planSummarizeMessages({
            messages,
            messageTokens: messages.map(() => 100),
            keepBudgetTokens: 700,
            minKeepRounds: 1,
            mode: 'auto'
        });

        expect(plan).toEqual({ cutIndex: 4, boundary: 'intra_round' });
    });

    it('多轮历史的当前长轮自身超预算时也允许轮内切分', () => {
        const messages = [
            user('old'), modelText('old answer'),
            user('current'), fc('a'), fr('a'), fc('b'), fr('b'), modelText('done')
        ];
        const plan = planSummarizeMessages({
            messages,
            messageTokens: [50, 50, 100, 200, 200, 200, 200, 100],
            keepBudgetTokens: 550,
            minKeepRounds: 1,
            mode: 'auto'
        });

        expect(plan).toEqual({ cutIndex: 5, boundary: 'intra_round' });
    });

    function validateHistoryIntegrityForTest(history: Content[]): boolean {
        const calls = new Set<string>();
        for (const message of history) {
            for (const part of message.parts) {
                if (part.functionCall?.id) calls.add(part.functionCall.id);
                if (part.functionResponse?.id && !calls.has(part.functionResponse.id)) return false;
            }
        }
        return true;
    }
});
