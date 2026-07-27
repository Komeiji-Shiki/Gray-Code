/**
 * LimCode - 总结范围规划器
 *
 * 纯函数模块：根据 token 预算决定总结时保留多少最近内容。
 *
 * 背景：
 * - 触发侧（ContextTrimService）基于 token 估算判断是否需要总结；
 * - 旧的执行侧却按“保留最近 N 轮”硬性划分总结范围，轮的体积方差极大，
 *   会造成总结不足（反复触发失败）或总结过度（新鲜上下文被过早压缩）。
 *
 * 新策略：
 * - 从最后一轮往前累计 token，能装进保留预算（keepRecentTokens）的轮保留，
 *   更早的轮全部纳入总结范围（按轮边界对齐）；
 * - keepRecentRounds 退化为“最少保留轮数”下限保护；
 * - 极端场景（单轮体积超过预算且无其他轮可总结）下支持轮内截断：
 *   在轮内部选择一个不拆散 functionCall/functionResponse 配对的切点，
 *   将该轮前半段纳入总结范围。正常多轮对话不会触发该路径。
 */

import type { Content } from '../../../conversation/types';
import { validateHistoryIntegrity } from '../../../channel/HistoryIntegrityValidator';
import { DEFAULT_KEEP_RECENT_TOKENS } from '../../../settings/types';

/**
 * 将 token 预算配置解析为具体 token 数
 *
 * @returns 解析结果；配置缺失或非法时返回 undefined
 */
function parseTokenBudget(
    raw: number | string | undefined,
    maxContextTokens: number
): number | undefined {
    if (raw === undefined || raw === null) {
        return undefined;
    }

    if (typeof raw === 'number') {
        return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : undefined;
    }

    const text = raw.trim();
    if (!text) {
        return undefined;
    }

    if (text.endsWith('%')) {
        const percent = Number.parseFloat(text.slice(0, -1));
        if (Number.isFinite(percent) && percent > 0 && percent <= 100) {
            return Math.floor(maxContextTokens * percent / 100);
        }
        return undefined;
    }

    const numeric = Number(text);
    if (Number.isFinite(numeric) && numeric > 0) {
        return Math.floor(numeric);
    }
    return undefined;
}

/**
 * 解析保留预算配置为具体 token 数
 *
 * 配置缺失或非法时，回落到设置系统的内置默认值 DEFAULT_KEEP_RECENT_TOKENS
 *（单一事实来源，实际生效值由用户在总结设置中配置）。
 *
 * @param raw 配置值：绝对 token 数（number 或数字字符串）或百分比字符串（如 '25%'）
 * @param maxContextTokens 主对话模型的最大上下文 token 数（百分比的基数）
 */
export function resolveKeepRecentTokenBudget(
    raw: number | string | undefined,
    maxContextTokens: number
): number {
    const parsed = parseTokenBudget(raw, maxContextTokens);
    if (parsed !== undefined) {
        return parsed;
    }
    // DEFAULT_KEEP_RECENT_TOKENS 是内置合法字面量，恒可解析（有单测守护）
    return parseTokenBudget(DEFAULT_KEEP_RECENT_TOKENS, maxContextTokens) as number;
}

/**
 * 总结范围规划结果
 *
 * - rounds: 按轮边界总结，总结 rounds[0, keepFromRound)，保留 rounds[keepFromRound, ...]
 * - intra_round: 无轮可总结但单轮体积超预算，需要轮内截断（见 planIntraRoundSplit）
 * - none: 无法总结（轮数不足或没有可总结内容）
 */
export type SummarizeRangePlan =
    | { type: 'rounds'; keepFromRound: number }
    | { type: 'intra_round' }
    | { type: 'none'; reason: 'no_rounds' | 'not_enough_rounds' };

/**
 * 按轮规划总结范围
 *
 * 决策优先级：
 * 1. 按预算从最后一轮往前保留（最后一轮无条件保留）；
 * 2. minKeepRounds 作为“最少保留轮数”下限，可能进一步扩大保留范围；
 * 3. 若两者叠加后没有任何轮可总结：
 *    - auto 模式防死锁优先：回退到纯预算结果，仍不行则只保留最后一轮；
 *    - manual 模式尊重用户配置，返回轮数不足；
 * 4. 只有一轮且该轮体积超过预算时，请求轮内截断。
 */
export function planSummarizeRounds(options: {
    /** 每轮的估算 token 数（按时间顺序） */
    roundTokens: number[];
    /** 保留预算（token 数） */
    keepBudgetTokens: number;
    /** 最少保留轮数（下限保护，内部至少按 1 处理） */
    minKeepRounds: number;
    /** manual：尊重 minKeepRounds 并在不足时报错；auto：防死锁优先 */
    mode: 'manual' | 'auto';
}): SummarizeRangePlan {
    const { roundTokens, keepBudgetTokens, mode } = options;
    const totalRounds = roundTokens.length;

    if (totalRounds === 0) {
        return { type: 'none', reason: 'no_rounds' };
    }

    const minKeepRounds = Math.max(1, Math.floor(options.minKeepRounds) || 1);

    // 1) 按预算从后往前保留，最后一轮（当前轮）无条件保留
    let accumulatedTokens = roundTokens[totalRounds - 1];
    let budgetKeepFrom = totalRounds - 1;
    for (let round = totalRounds - 2; round >= 0; round--) {
        if (accumulatedTokens + roundTokens[round] > keepBudgetTokens) {
            break;
        }
        accumulatedTokens += roundTokens[round];
        budgetKeepFrom = round;
    }

    // 2) 应用最少保留轮数下限（保留轮数 = totalRounds - keepFrom >= minKeepRounds）
    const keepFrom = Math.min(budgetKeepFrom, totalRounds - minKeepRounds);

    if (keepFrom >= 1) {
        return { type: 'rounds', keepFromRound: keepFrom };
    }

    // 3) 没有任何轮可总结，进入回退级联
    if (budgetKeepFrom >= 1) {
        // 是 minKeepRounds 挡住的：auto 防死锁优先回退到纯预算结果；manual 尊重配置
        return mode === 'auto'
            ? { type: 'rounds', keepFromRound: budgetKeepFrom }
            : { type: 'none', reason: 'not_enough_rounds' };
    }

    // budgetKeepFrom === 0：预算装得下总结点之后的全部轮
    if (totalRounds - minKeepRounds >= 1) {
        // 仍有可总结轮（通常是手动总结、或预算配置过大时的自动总结）：
        // 退化为旧行为——保留 minKeepRounds 轮，总结其余
        return { type: 'rounds', keepFromRound: totalRounds - minKeepRounds };
    }

    if (totalRounds > 1) {
        // 轮数不足 minKeepRounds 但仍有多轮：auto 防死锁只保留当前轮；manual 报错
        return mode === 'auto'
            ? { type: 'rounds', keepFromRound: totalRounds - 1 }
            : { type: 'none', reason: 'not_enough_rounds' };
    }

    // 只有一轮：该轮体积超过预算时才值得轮内截断，否则没有可总结内容
    if (roundTokens[0] > keepBudgetTokens) {
        return { type: 'intra_round' };
    }
    return { type: 'none', reason: 'not_enough_rounds' };
}

/**
 * 轮内截断结果
 */
export interface IntraRoundSplitResult {
    /** 切点（相对传入 messages 的索引）：总结 [0, cutIndex)，保留 [cutIndex, ...] */
    cutIndex: number;
}

/**
 * 在单个超大轮内部规划截断点
 *
 * 合法切点必须是 model 消息：
 * - 保留部分之前会插入 user 角色的总结消息，user -> model 顺序合法；
 * - functionResponse 紧跟其 functionCall，以 model 消息为切点不会拆散配对
 *   （若历史结构异常，validateHistoryIntegrity 会把该切点排除）。
 *
 * 切点选择：在满足“保留部分 <= 预算”的候选中选最早的（保留最多）；
 * 若所有候选都超预算，选最后一个候选（保留最少，防死锁）。
 *
 * @returns 切点，或 null（轮内没有可用切点，无法截断）
 */
export function planIntraRoundSplit(options: {
    /** 当前轮的消息序列（第一条应为轮首 user 消息） */
    messages: Content[];
    /** 与 messages 一一对应的估算 token 数 */
    messageTokens: number[];
    /** 保留预算（token 数） */
    keepBudgetTokens: number;
}): IntraRoundSplitResult | null {
    const { messages, messageTokens, keepBudgetTokens } = options;

    // 候选切点：轮首之后的所有 model 消息
    const candidates: number[] = [];
    for (let i = 1; i < messages.length; i++) {
        if (messages[i]?.role === 'model') {
            candidates.push(i);
        }
    }
    if (candidates.length === 0) {
        return null;
    }

    // 后缀 token 累计：suffixTokens[i] = messages[i..] 的 token 总和
    const suffixTokens = new Array<number>(messages.length + 1).fill(0);
    for (let i = messages.length - 1; i >= 0; i--) {
        suffixTokens[i] = suffixTokens[i + 1] + (messageTokens[i] ?? 0);
    }

    // 最早的满足预算的切点；都不满足则取最后一个（保留最少）
    let preferredCut = candidates[candidates.length - 1];
    for (const cut of candidates) {
        if (suffixTokens[cut] <= keepBudgetTokens) {
            preferredCut = cut;
            break;
        }
    }

    // 从首选切点开始，向后找第一个保留部分完整（无孤儿 functionResponse）的切点
    for (const cut of candidates) {
        if (cut < preferredCut) {
            continue;
        }
        if (validateHistoryIntegrity(messages.slice(cut)).valid) {
            return { cutIndex: cut };
        }
    }
    return null;
}
