/**
 * GrayCode - 总结范围规划器
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
import { isRealUserMessage } from '../../../conversation/helpers';
import { validateHistoryIntegrity } from '../../../channel/HistoryIntegrityValidator';
import { DEFAULT_KEEP_RECENT_TOKENS } from '../../../settings/types';

/**
 * 将 token 预算配置解析为具体 token 数
 *
 * @param baseTokens 百分比字符串的基数（当前为「本次总结规划范围内的活跃历史 token 总量」）
 * @returns 解析结果；配置缺失或非法时返回 undefined
 */
function parseTokenBudget(
    raw: number | string | undefined,
    baseTokens: number
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
            return Math.floor(baseTokens * percent / 100);
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
 * 百分比语义：基数为「本次总结规划范围内的活跃历史 token 总量」（上一次总结之后、
 * 未被 isSummarized 覆盖的消息），不是主对话模型上下文窗口——'50%' 表示截断一半
 * 历史、保留另一半，与模型窗口大小无关。
 *
 * @param raw 配置值：绝对 token 数（number 或数字字符串）或百分比字符串（如 '50%'）
 * @param baseTokens 百分比基数（活跃历史 token 总量）
 */
export function resolveKeepRecentTokenBudget(
    raw: number | string | undefined,
    baseTokens: number
): number {
    const parsed = parseTokenBudget(raw, baseTokens);
    if (parsed !== undefined) {
        return parsed;
    }
    // DEFAULT_KEEP_RECENT_TOKENS 是内置合法字面量，恒可解析（有单测守护）
    return parseTokenBudget(DEFAULT_KEEP_RECENT_TOKENS, baseTokens) as number;
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
 * 3. 若最少保留轮数覆盖了全部多轮历史：
 *    - manual 在合并历史确实超过预算时按“单个超大轮”进入轮内切分；
 *    - auto 仍回退为只保留当前轮，避免自动总结覆盖当前任务。
 * 4. 只有一轮且该轮体积超过预算时，请求轮内截断。
 */
export function planSummarizeRounds(options: {
    /** 每轮的估算 token 数（按时间顺序） */
    roundTokens: number[];
    /** 保留预算（token 数） */
    keepBudgetTokens: number;
    /** 最少保留轮数（下限保护，内部至少按 1 处理） */
    minKeepRounds: number;
    /** manual/auto 的轮级保护模式；manual 在多轮全被保护且超预算时允许轮内切分 */
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

    // 预算已经允许总结更早轮次时，仍按 minKeepRounds 保留最近轮数。
    if (totalRounds - minKeepRounds >= 1) {
        return { type: 'rounds', keepFromRound: totalRounds - minKeepRounds };
    }

    // 3) 手动总结在“两轮也全部受保护”时，把活跃历史视为一个长轮，
    //    沿用单轮逻辑寻找内容比例更合适的安全 model 切点。
    const totalTokens = roundTokens.reduce((sum, tokens) => sum + tokens, 0);
    if (mode === 'manual' && totalRounds > 1 && totalRounds <= minKeepRounds) {
        return totalTokens > keepBudgetTokens
            ? { type: 'intra_round' }
            : { type: 'none', reason: 'not_enough_rounds' };
    }

    // 4) 自动总结在多轮不足保护值时只保留当前轮；手动路径已在上面按单轮处理。
    if (totalRounds > 1) {
        return { type: 'rounds', keepFromRound: totalRounds - 1 };
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

export interface MessageGranularSummarizePlan {
    /** 切点：总结 [0, cutIndex)，保留 [cutIndex, ...] */
    cutIndex: number;
    /** round 表示真实用户回合边界；intra_round 表示长回合内部的安全 model 边界。 */
    boundary: 'round' | 'intra_round';
}

/**
 * 在轮级规划结果基础上向前寻找更细的安全切点。
 *
 * 轮级规划先保证 keepRecentRounds 的语义；但手动总结在保护值覆盖全部多轮且总量超预算时，
 * 将活跃历史视为一个长轮，允许在完整消息序列中选择 model 切点；自动总结仍严格保护当前轮。
 * 切点后的历史必须没有孤儿 functionResponse，确保 functionCall/functionResponse 原子性。
 */
export function planSummarizeMessages(options: {
    messages: Content[];
    messageTokens: number[];
    keepBudgetTokens: number;
    minKeepRounds: number;
    mode: 'manual' | 'auto';
}): MessageGranularSummarizePlan | null {
    const { messages, messageTokens, keepBudgetTokens, minKeepRounds, mode } = options;
    if (messages.length < 2 || messages.length !== messageTokens.length) {
        return null;
    }

    const roundStarts: number[] = [];
    for (let i = 0; i < messages.length; i++) {
        if (isRealUserMessage(messages[i])) roundStarts.push(i);
    }
    if (roundStarts.length === 0) return null;

    const roundTokens = roundStarts.map((startIndex, roundIndex) => {
        const endIndex = roundStarts[roundIndex + 1] ?? messages.length;
        let total = 0;
        for (let i = startIndex; i < endIndex; i++) total += messageTokens[i] ?? 0;
        return total;
    });
    const roundPlan = planSummarizeRounds({ roundTokens, keepBudgetTokens, minKeepRounds, mode });
    if (roundPlan.type === 'none') return null;

    let maximumCutIndex = roundPlan.type === 'rounds'
        ? roundStarts[roundPlan.keepFromRound]
        : messages.length - 1;

    const suffixTokens = new Array<number>(messages.length + 1).fill(0);
    for (let i = messages.length - 1; i >= 0; i--) {
        suffixTokens[i] = suffixTokens[i + 1] + (messageTokens[i] ?? 0);
    }
    // 即使已有多轮，只要轮级边界后的最后一轮自身仍超预算，就继续开放当前长轮内部的切点。
    if (suffixTokens[maximumCutIndex] > keepBudgetTokens) {
        maximumCutIndex = messages.length - 1;
    }

    const candidates: number[] = [];
    for (let i = 1; i <= maximumCutIndex; i++) {
        if (messages[i]?.role === 'model' || isRealUserMessage(messages[i])) {
            candidates.push(i);
        }
    }

    const isSafeCut = (cutIndex: number) => validateHistoryIntegrity(messages.slice(cutIndex)).valid;
    for (const cutIndex of candidates) {
        if (suffixTokens[cutIndex] <= keepBudgetTokens && isSafeCut(cutIndex)) {
            return {
                cutIndex,
                boundary: isRealUserMessage(messages[cutIndex]) ? 'round' : 'intra_round'
            };
        }
    }

    // 预算小到任何候选后缀都装不下时，沿用轮级规划的防死锁结果；若该边界异常则向后找安全点。
    for (const cutIndex of candidates.filter(index => index >= maximumCutIndex)) {
        if (isSafeCut(cutIndex)) {
            return {
                cutIndex,
                boundary: isRealUserMessage(messages[cutIndex]) ? 'round' : 'intra_round'
            };
        }
    }
    return null;
}

/**
 * 自动总结的最终切点规划。
 *
 * 在通用消息级规划之上统一施加“当前真实用户回合不可被自动总结覆盖”的保护：
 * - 多轮历史最多总结到当前回合起点；
 * - 单轮长工具回合允许在安全 model 边界内切分，但首条任务消息仍由调用方保留。
 *
 * 主会话与 SubAgent 必须共用该函数，避免一个按轮保护、另一个按消息直接删除。
 */
export function planAutoSummarizeMessages(options: {
    messages: Content[];
    messageTokens: number[];
    keepBudgetTokens: number;
    minKeepRounds: number;
}): MessageGranularSummarizePlan | null {
    const plan = planSummarizeMessages({ ...options, mode: 'auto' });
    if (!plan) return null;

    let lastRealUserMessageIndex = -1;
    for (let i = options.messages.length - 1; i >= 0; i--) {
        if (isRealUserMessage(options.messages[i])) {
            lastRealUserMessageIndex = i;
            break;
        }
    }
    if (lastRealUserMessageIndex < 0) return null;

    let cutIndex = plan.cutIndex;
    if (lastRealUserMessageIndex === 0) {
        if (cutIndex <= 0) return null;
    } else {
        cutIndex = Math.min(cutIndex, lastRealUserMessageIndex);
        if (cutIndex <= 0) return null;
    }

    return {
        cutIndex,
        boundary: isRealUserMessage(options.messages[cutIndex]) ? 'round' : 'intra_round'
    };
}

