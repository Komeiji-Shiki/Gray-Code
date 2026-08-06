/**
 * LimCode - 上下文裁剪服务
 *
 * 负责管理对话历史的上下文裁剪逻辑：
 * - 识别对话回合
 * - 计算上下文阈值
 * - 裁剪超出阈值的历史消息
 * - 查找总结消息
 *
 * 设计原则：
 * - 使用累加的单条消息 token 数，而不是 API 返回的累计值，避免上下文振荡
 * - 保证历史以 user 消息开始（Gemini API 要求）
 * - 总结消息之前的历史会被过滤
 * - 裁剪状态持久化到会话的 custom metadata 中
 * - 每次计算时会检查是否可以恢复更多历史（思考 token 减少、设置变更时）
 *
 * Token 计算包含：
 * - 系统提示词（静态模板）
 * - 当前 prompt context（chat-history 前后临时消息的实际填充内容）
 * - 对话历史消息和 preserve 旧回合动态快照
 */

import type { Content } from '../../../conversation/types';
import { CONVERSATION_CONTEXT_TRIM_STATE_KEY } from '../../../conversation/types';
import { isRealUserMessage } from '../../../conversation/helpers';
import type { ConversationManager, GetHistoryOptions } from '../../../conversation/ConversationManager';
import type { PromptManager } from '../../../prompt';
import type { DynamicContextStrategy, ResolvedPromptModeSnapshot } from '../../../settings/types';
import type { BaseChannelConfig, ModelInfo } from '../../../config/configs/base';
import type { ConversationRound, ContextTrimInfo } from '../utils';
import type { TokenEstimationService } from './TokenEstimationService';
import type { MessageBuilderService } from './MessageBuilderService';

import { Logger } from '../../../../core/logger';
import { getPromptContextCacheDynamicSnapshotText } from '../../../prompt/promptContextCache';
import { validateHistoryIntegrity, normalizeCallId } from '../../../channel/HistoryIntegrityValidator';
import { planSummarizeMessages } from './summarizeRangePlanner';
const CONVERSATION_PINNED_FILES_KEY = 'inputPinnedFiles';
const CONVERSATION_SKILLS_KEY = 'inputSkills';
/** 最多约 40k token；正常用户输入远小于此值，只有异常大粘贴才会触发有界截断。 */
/**
 * 被裁剪历史的逐字用户输入档案上限。
 *
 * 旧值 160k 字符在常见英文口径下约 40k token，单是这个“保险副本”就会吃掉默认
 * 256k 上下文保留预算（25%=64k token）的多数空间，使总结后上下文几乎不下降。
 * 64k 字符约 16k token，仍足以保留长任务约束，同时让摘要/裁剪真正释放空间。
 */
export const PRESERVED_USER_INPUT_MAX_CHARS = 64_000;
const PRESERVED_USER_INPUT_OMISSION_MARKER =
    '\n\n[Some middle historical user inputs were omitted because the verbatim archive exceeded its safety budget.]\n\n';
export const DEFAULT_MAX_CONTEXT_TOKENS = 256000;
const CONTEXT_TRIM_DEBUG_ENABLED = true;
const FALLBACK_PROVIDER_RESERVE_RATIO = 0.1;
const AUTO_SUMMARY_USEFUL_HISTORY_RATIO = 0.01;
const MIN_AUTO_SUMMARY_USEFUL_HISTORY_TOKENS = 256;
const MAX_AUTO_SUMMARY_USEFUL_HISTORY_TOKENS = 8_192;

/**
 * fallback 已无法构造不超过主模型输入预算的合法历史。
 *
 * 注意：message 仅作开发/日志兜底（英文），对外展示的消息由上层（ChatHandler.formatError）
 * 按 code = CONTEXT_OVERFLOW 走 i18n，并携带 estimatedInputTokens / inputTokenLimit 两个参数。
 */
export class ContextBudgetExceededError extends Error {
    readonly code = 'CONTEXT_OVERFLOW';

    constructor(
        readonly estimatedInputTokens: number,
        readonly inputTokenLimit: number
    ) {
        super(
            `Unable to build a legal request within the context window: the smallest candidate uses about ${estimatedInputTokens} input tokens, above the ${inputTokenLimit}-token window`
        );
        this.name = 'ContextBudgetExceededError';
    }
}

/**
 * 回合 Token 信息（内部使用）
 */
interface RoundTokenInfo {
    /** 回合起始索引 */
    startIndex: number;
    /** 回合结束索引 */
    endIndex: number;
    /** 系统提示词 + effectiveStartIndex 到这个回合结束的累计 token 数 */
    cumulativeTokens: number;
}

interface AccumulateUsageStats {
    modelMessagesWithUsage: number;
    modelMessagesOutputBased: number;
    modelMessagesMismatch: number;
    modelMessagesWithoutUsage: number;
    userMessages: number;
    userFromChannelCount: number;
    userFromEstimatedFieldCount: number;
    userFromLocalEstimateCount: number;
    userTokensTotal: number;
    modelTokensTotal: number;
}

/**
 * 持久化的裁剪状态
 * 
 * 存储在会话的 custom metadata 中，key 为 'trimState'
 */
interface PersistedTrimState {
    /** 裁剪状态格式版本；旧版本缺少回合边界语义，读取时必须失效并重新评估。 */
    schemaVersion: number;
    /** 裁剪起始索引 */
    trimStartIndex: number;
}

const CURRENT_TRIM_STATE_SCHEMA_VERSION = 1;

/** 裁剪状态在 custom metadata 中的 key */
const TRIM_STATE_KEY = CONVERSATION_CONTEXT_TRIM_STATE_KEY;

interface ContextManagementPolicy {
    enabled: boolean;
    mode: 'trim' | 'summarize';
    source: 'explicit' | 'legacy';
}

export interface ContextTrimEvaluationOptions {
    /**
     * 是否允许本次评估推进持久化裁剪点或触发新的自动总结。
     * 同一真实用户回合的后续工具迭代必须设为 false，只复用回合开始时已有的上下文起点。
     */
    allowStateAdvance?: boolean;
}

export interface MaxContextResolution {
    maxContextTokens: number;
    source: 'config.maxContextTokens' | 'model.contextWindow' | 'default';
    configMaxContextTokens?: unknown;
    modelId?: string;
    modelContextWindow?: unknown;
}

function normalizePositiveTokenValue(value: unknown): number | undefined {
    const numericValue = typeof value === 'number'
        ? value
        : (typeof value === 'string' ? Number(value) : NaN);
    if (!Number.isFinite(numericValue) || numericValue <= 0) return undefined;
    return Math.floor(numericValue);
}

function resolveCandidateModelId(config: BaseChannelConfig, modelOverride?: string): string {
    if (typeof modelOverride === 'string' && modelOverride.trim()) return modelOverride.trim();
    const configModel = (config as { model?: unknown }).model;
    return typeof configModel === 'string' && configModel.trim() ? configModel.trim() : '';
}

/** 返回当前实际选择模型声明的窗口；未能识别模型时不把渠道显示上限伪装成模型硬边界。 */
export function resolveModelContextWindowForConfig(
    config: BaseChannelConfig,
    modelOverride?: string
): MaxContextResolution | undefined {
    const candidateModelId = resolveCandidateModelId(config, modelOverride);
    if (!candidateModelId) return undefined;
    const modelList = Array.isArray((config as { models?: unknown }).models)
        ? ((config as { models?: ModelInfo[] }).models as ModelInfo[])
        : [];
    const matchedModel = modelList.find(model => model?.id === candidateModelId);
    const modelContextWindow = normalizePositiveTokenValue(matchedModel?.contextWindow);
    if (modelContextWindow === undefined) return undefined;
    return {
        maxContextTokens: modelContextWindow,
        source: 'model.contextWindow',
        configMaxContextTokens: config.maxContextTokens,
        modelId: candidateModelId,
        modelContextWindow: matchedModel?.contextWindow
    };
}

/** 解析上下文管理的预算基准：显式渠道上限优先，模型窗口和默认值依次回退。 */
export function resolveMaxContextTokensForConfig(
    config: BaseChannelConfig,
    modelOverride?: string
): MaxContextResolution {
    const configuredMax = normalizePositiveTokenValue(config.maxContextTokens);
    if (configuredMax !== undefined) {
        return {
            maxContextTokens: configuredMax,
            source: 'config.maxContextTokens',
            configMaxContextTokens: config.maxContextTokens
        };
    }

    const candidateModelId = resolveCandidateModelId(config, modelOverride);
    const modelWindow = resolveModelContextWindowForConfig(config, modelOverride);
    if (modelWindow) return modelWindow;

    return {
        maxContextTokens: DEFAULT_MAX_CONTEXT_TOKENS,
        source: 'default',
        configMaxContextTokens: config.maxContextTokens,
        modelId: candidateModelId || undefined
    };
}

interface NormalizedTrimStartResult {
    startIndex: number;
    valid: boolean;
    reason: 'unchanged' | 'clamped_minimum' | 'moved_to_next_round' | 'moved_to_current_round' | 'advanced_to_valid_round' | 'no_legal_round_boundary';
    issueKind?: string;
    issueCallId?: string;
}

export class ContextTrimService {
    private readonly log = Logger.get('ContextTrim');

    constructor(
        private conversationManager: ConversationManager,
        private promptManager: PromptManager,
        private tokenEstimationService: TokenEstimationService,
        private messageBuilderService: MessageBuilderService
    ) {}

    private resolveContextManagementPolicy(config: BaseChannelConfig): ContextManagementPolicy {
        if (typeof config.contextManagementEnabled === 'boolean') {
            return {
                enabled: config.contextManagementEnabled,
                // 直接按用户回合裁剪会无损失提示地抹掉大段历史。统一改为模型总结优先；
                // 原 trim 配置保留为兼容输入，只有总结失败时才走临时细粒度裁剪。
                mode: 'summarize',
                source: 'explicit'
            };
        }

        if (config.autoSummarizeEnabled || config.contextThresholdEnabled) {
            return { enabled: true, mode: 'summarize', source: 'legacy' };
        }

        return { enabled: false, mode: 'trim', source: 'legacy' };
    }
    
    /**
     * 获取持久化的裁剪状态
     */
    private async getTrimState(conversationId: string): Promise<PersistedTrimState | null> {
        const rawState = await this.conversationManager.getCustomMetadata(conversationId, TRIM_STATE_KEY);
        if (!rawState || typeof rawState !== 'object') {
            return null;
        }

        const state = rawState as Partial<PersistedTrimState>;
        if (state.schemaVersion !== CURRENT_TRIM_STATE_SCHEMA_VERSION || !Number.isInteger(state.trimStartIndex)) {
            // 旧状态可能是在工具回合中途推进的，无法判断其合法边界。一次性清除后重新评估，
            // 让升级前被错误遮蔽的历史重新回到候选上下文。
            await this.conversationManager.invalidateContextManagementState(
                conversationId,
                'trim_state_schema_upgrade'
            );
            this.log.info('trim_state_cleared_schema_upgrade', {
                conversationId,
                savedSchemaVersion: state.schemaVersion ?? null,
                currentSchemaVersion: CURRENT_TRIM_STATE_SCHEMA_VERSION
            });
            return null;
        }
        return state as PersistedTrimState;
    }
    
    /**
     * 保存裁剪状态到持久化存储
     */
    private async saveTrimState(conversationId: string, state: Omit<PersistedTrimState, 'schemaVersion'>): Promise<void> {
        await this.conversationManager.setCustomMetadata(conversationId, TRIM_STATE_KEY, {
            ...state,
            schemaVersion: CURRENT_TRIM_STATE_SCHEMA_VERSION
        });
    }
    
    /**
     * 清除指定会话的裁剪状态
     * 
     * 在以下情况下应调用：
     * - 删除消息
     * - 回退到检查点
     * - 编辑消息
     * 
     * @param conversationId 会话 ID
     */
    async clearTrimState(conversationId: string): Promise<void> {
        await this.conversationManager.invalidateContextManagementState(conversationId, 'context_trim_service_clear');
    }

    private logDebug(message: string, details?: Record<string, unknown>): void {
        if (!CONTEXT_TRIM_DEBUG_ENABLED) return;
        this.log.debug(message, details);
    }

    /**
     * 上下文起点允许落在真实用户消息或总结消息上；functionResponse 不能作为起点。
     * 总结消息本身是 user 角色，若排除它，归一化会错误跳到总结后的下一条用户消息并把总结也丢掉。
     */
    private isLegalTrimStart(history: Content[], index: number): boolean {
        const message = history[index];
        return !!message && (message.isSummary === true || isRealUserMessage(message));
    }

    private collectLegalTrimStartIndices(history: Content[], minimumStartIndex: number): number[] {
        const starts: number[] = [];
        for (let i = Math.max(0, minimumStartIndex); i < history.length; i++) {
            if (this.isLegalTrimStart(history, i)) {
                starts.push(i);
            }
        }
        return starts;
    }

    /**
     * PERF：一次从右向左扫描，预计算每个下标 i 的「切片 fullHistory.slice(i) 是否通过
     * validateHistoryIntegrity」判定（validSuffix[i]），使 normalizeTrimStartIndex 的每个
     * 候选判定降为 O(1)。语义与 validateHistoryIntegrity（不开启 detectOrphanFunctionCall）
     * 完全一致：重复 functionCall id、重复 functionResponse id、以及「functionResponse
     * 的配对 functionCall 不在切片内」的孤儿响应。
     *
     * 配对方向注意（与正向校验逐位等价的关键）：正向中「response 的配对 call 必须出现在
     * response 之前」（同一消息内更早的 part 或更左侧的消息）；反向扫描时因此要区分三种情况：
     * - 本消息内更早 part 已有 call（localCallSeen）→ 配对成立；
     * - seenFunctionCallIds 已有但本消息内没有（call 在右侧消息，乱序配对）→ 正向判孤儿，
     *   置 hasOrphanResponse（该切片向左扩展后仍至少是重复或孤儿，永久 invalid，不可治愈）；
     * - 两侧都无 → 可能是跨消息正常配对（call 在更左侧，尚未扫到），先记入孤儿集合，
     *   扫到左侧 call 时治愈；本消息新增孤儿不得被本消息内 call 治愈（同消息乱序）。
     */
    private computeValidSuffixMap(fullHistory: Content[]): boolean[] {
        const validSuffix = new Array<boolean>(fullHistory.length);
        const seenFunctionCallIds = new Set<string>();
        const seenFunctionResponseIds = new Set<string>();
        const orphanedFunctionResponseIds = new Set<string>();
        let hasDuplicateCall = false;
        let hasDuplicateResponse = false;
        let hasOrphanResponse = false;

        for (let i = fullHistory.length - 1; i >= 0; i--) {
            const message = fullHistory[i];
            const parts = Array.isArray(message?.parts) ? message.parts : [];
            // 本消息内全部 functionCall id（跨消息治愈用）
            const localCallIds = new Set<string>();
            for (const part of parts) {
                const functionCallId = normalizeCallId(part.functionCall?.id);
                if (functionCallId) {
                    localCallIds.add(functionCallId);
                }
            }
            // 本消息内已按 parts 原序处理过的 functionCall（配对判定：call 必须在本 response 之前）
            const localCallSeen = new Set<string>();
            // 本消息新增的孤儿 response（同消息内 call 在 response 之后时，正向确实判孤儿，
            // 不得被本消息的 call 治愈）
            const newOrphanIds = new Set<string>();
            // parts 原序处理（与正向校验同序）：重复检测 + 配对判定
            for (const part of parts) {
                const functionCallId = normalizeCallId(part.functionCall?.id);
                if (functionCallId) {
                    localCallSeen.add(functionCallId);
                    if (seenFunctionCallIds.has(functionCallId)) {
                        hasDuplicateCall = true;
                    } else {
                        seenFunctionCallIds.add(functionCallId);
                    }
                }

                const functionResponseId = normalizeCallId(part.functionResponse?.id);
                if (!functionResponseId) {
                    continue;
                }
                if (seenFunctionResponseIds.has(functionResponseId)) {
                    hasDuplicateResponse = true;
                } else {
                    seenFunctionResponseIds.add(functionResponseId);
                }

                if (localCallSeen.has(functionResponseId)) {
                    // 本消息内更早的 part 已有配对 call → 配对成立（正向不判孤儿）
                } else if (seenFunctionCallIds.has(functionResponseId)) {
                    // call 在右侧消息（乱序配对）→ 正向判孤儿；切片向左扩展后仍至少
                    // 是重复或孤儿，永久 invalid，不可治愈
                    hasOrphanResponse = true;
                } else {
                    // 可能是跨消息正常配对（call 在更左侧尚未扫到）→ 暂记孤儿，等待治愈
                    orphanedFunctionResponseIds.add(functionResponseId);
                    newOrphanIds.add(functionResponseId);
                }
            }
            // 跨消息治愈：本消息的 call 在右侧消息孤儿 response 的左侧 → 治愈
            // （本消息新增孤儿除外——同消息乱序在正向中确实是孤儿）
            for (const callId of localCallIds) {
                if (!newOrphanIds.has(callId)) {
                    orphanedFunctionResponseIds.delete(callId);
                }
            }
            validSuffix[i] = !hasDuplicateCall && !hasDuplicateResponse
                && !hasOrphanResponse && orphanedFunctionResponseIds.size === 0;
        }
        return validSuffix;
    }

    private normalizeTrimStartIndex(
        fullHistory: Content[],
        minimumStartIndex: number,
        candidateStartIndex: number
    ): NormalizedTrimStartResult {
        if (fullHistory.length === 0) {
            return {
                startIndex: 0,
                valid: true,
                reason: 'unchanged'
            };
        }

        const maxIndex = Math.max(0, fullHistory.length - 1);
        const safeMinimumStartIndex = Math.max(0, Math.min(Math.floor(minimumStartIndex), maxIndex));
        const rawCandidate = Number.isFinite(candidateStartIndex) ? Math.floor(candidateStartIndex) : safeMinimumStartIndex;
        const clampedCandidate = Math.max(safeMinimumStartIndex, Math.min(rawCandidate, maxIndex));
        const legalStartIndices = this.collectLegalTrimStartIndices(fullHistory, safeMinimumStartIndex);

        if (legalStartIndices.length === 0) {
            return {
                startIndex: clampedCandidate,
                valid: false,
                reason: 'no_legal_round_boundary'
            };
        }

        let normalizedStartIndex = clampedCandidate;
        let reason: NormalizedTrimStartResult['reason'] = rawCandidate === clampedCandidate ? 'unchanged' : 'clamped_minimum';

        if (!this.isLegalTrimStart(fullHistory, clampedCandidate)) {
            const nextLegalStartIndex = legalStartIndices.find(index => index > clampedCandidate);
            if (nextLegalStartIndex !== undefined) {
                normalizedStartIndex = nextLegalStartIndex;
                reason = 'moved_to_next_round';
            } else {
                let currentRoundStartIndex = legalStartIndices[legalStartIndices.length - 1];
                for (let i = legalStartIndices.length - 1; i >= 0; i--) {
                    if (legalStartIndices[i] <= clampedCandidate) {
                        currentRoundStartIndex = legalStartIndices[i];
                        break;
                    }
                }
                normalizedStartIndex = currentRoundStartIndex;
                reason = 'moved_to_current_round';
            }
        }

        // PERF：O(n) 预计算全部后缀的有效性，替代对每个候选 slice + validateHistoryIntegrity
        const validSuffix = this.computeValidSuffixMap(fullHistory);
        const candidateStarts = [normalizedStartIndex, ...legalStartIndices.filter(index => index > normalizedStartIndex)];

        for (let i = 0; i < candidateStarts.length; i++) {
            const startIndex = candidateStarts[i];
            if (validSuffix[startIndex]) {
                return {
                    startIndex,
                    valid: true,
                    reason: i === 0 ? reason : 'advanced_to_valid_round'
                };
            }
        }

        // 全部候选无效：与旧实现一致，firstIssue 只来自第一个候选（normalizedStartIndex），
        // 失败路径只出现一次 O(n) 校验（结构异常历史的低频路径）。
        const validation = validateHistoryIntegrity(fullHistory.slice(normalizedStartIndex));
        return {
            startIndex: normalizedStartIndex,
            valid: false,
            reason,
            issueKind: validation.issues[0]?.kind,
            issueCallId: validation.issues[0]?.callId
        };
    }

    private createPreservedUserInputsMessage(
        fullHistory: Content[],
        beforeIndex: number
    ): Content | undefined {
        if (beforeIndex <= 0) return undefined;

        const entries = fullHistory
            .slice(0, beforeIndex)
            .filter(isRealUserMessage)
            .map((message, index) => {
                const parts = message.parts.flatMap(part => {
                    if (part.text && !part.thought) return [part.text];
                    if (part.inlineData) {
                        return [`[Attachment: ${part.inlineData.displayName || part.inlineData.mimeType}]`];
                    }
                    if (part.fileData) {
                        return [`[File: ${part.fileData.displayName || part.fileData.fileUri}]`];
                    }
                    return [];
                });
                return parts.length > 0 ? `### User input ${index + 1}\n${parts.join('\n')}` : '';
            })
            .filter(Boolean);
        if (entries.length === 0) return undefined;

        const header = [
            '## Preserved user inputs (verbatim)',
            'These are historical user messages retained independently from summaries and trimming.',
            'Treat the latest user message in the active history as authoritative when instructions conflict.'
        ].join('\n');
        const fullText = `${header}\n\n${entries.join('\n\n')}`;
        let preservedText = fullText;
        if (fullText.length > PRESERVED_USER_INPUT_MAX_CHARS) {
            const contentBudget = Math.max(
                0,
                PRESERVED_USER_INPUT_MAX_CHARS - PRESERVED_USER_INPUT_OMISSION_MARKER.length
            );
            const headBudget = Math.floor(contentBudget * 0.35);
            const tailBudget = contentBudget - headBudget;
            preservedText = [
                fullText.slice(0, headBudget),
                PRESERVED_USER_INPUT_OMISSION_MARKER,
                fullText.slice(-tailBudget)
            ].join('');
        }

        return {
            role: 'user',
            parts: [{ text: preservedText }],
            isSummary: true
        };
    }

    private prependPreservedUserInputs(
        history: Content[],
        fullHistory: Content[],
        beforeIndex: number
    ): Content[] {
        const preserved = this.createPreservedUserInputsMessage(fullHistory, beforeIndex);
        return preserved ? [preserved, ...history] : history;
    }

    private async getNormalizedHistoryForStartIndex(
        conversationId: string,
        fullHistory: Content[],
        historyOptions: GetHistoryOptions,
        minimumStartIndex: number,
        candidateStartIndex: number,
        dynamicContextStrategy: DynamicContextStrategy = 'single'
    ): Promise<ContextTrimInfo & { normalization: NormalizedTrimStartResult }> {
        const normalization = this.normalizeTrimStartIndex(fullHistory, minimumStartIndex, candidateStartIndex);
        // HIS-03/04：调用方已加载 fullHistory，直接复用格式化，避免同一迭代内第二次 loadHistory
        const formattedHistory = this.conversationManager.getHistoryForAPIFrom(fullHistory, {
            ...historyOptions,
            startIndex: normalization.startIndex,
            includeTurnDynamicContext: dynamicContextStrategy === 'preserve'
        });
        const history = this.prependFirstUserMessage(
            fullHistory,
            this.prependPreservedUserInputs(
                formattedHistory,
                fullHistory,
                normalization.startIndex
            ),
            normalization.startIndex
        );

        return {
            history,
            trimStartIndex: normalization.startIndex,
            normalization
        };
    }

    /**
     * 首条用户消息永远发送（任务锚点）。
     *
     * 逻辑截断语义下，发送历史从最后一个总结消息 / 裁剪点开始，首条用户消息通常不在其中；
     * 主人的原始任务指令是长期锚点，总结文本永远不如原话清楚，必须原样拼到请求历史最前
     * （与保留用户输入档案并存，轻微冗余换取原话完整）。
     *
     * @param fullHistory 过滤 isSummarized 后的完整历史
     * @param history 已构建的发送历史
     * @param startIndex 发送切片起点（过滤后历史索引）；<= 0 时首条用户消息必然已在切片内
     * @returns 含首条用户消息的发送历史（已在其中则原样返回，避免重复前置）
     */
    private prependFirstUserMessage(fullHistory: Content[], history: Content[], startIndex: number): Content[] {
        // 从 0 开始发送：首条用户消息必然已在切片内，无需处理
        if (startIndex <= 0) {
            return history;
        }
        const firstUserIndex = fullHistory.findIndex(message => isRealUserMessage(message));
        if (firstUserIndex < 0) {
            return history;
        }
        const firstUser = fullHistory[firstUserIndex];
        // 首条用户消息已在切片内（异常数据：历史以 system 等开头且首条下标 >= startIndex）→ 不重复前置
        if (firstUserIndex >= startIndex) {
            return history;
        }
        // 防御：有稳定 id 时按 id 判重（历史以 system 开头时上述下标判断已覆盖，此处仅兜底）
        if (firstUser.id !== undefined && history.some(message => message.id === firstUser.id)) {
            return history;
        }
        return [firstUser, ...history];
    }

    /**
     * 解析当前轮应使用的最大上下文 token 数。
     *
     * 优先级：
     * 1. 配置显式 maxContextTokens
     * 2. 当前模型（modelOverride 或 config.model）在 models 列表中的 contextWindow
     * 3. 默认值 256000
     */
    resolveMaxContextTokens(config: BaseChannelConfig, modelOverride?: string): MaxContextResolution {
        return resolveMaxContextTokensForConfig(config, modelOverride);
    }

    /**
     * 识别对话回合
     *
     * 回合定义：
     * - 从一个非函数响应的用户消息开始
     * - 到下一个非函数响应的用户消息之前结束
     * - 每个回合记录该回合内最后一个助手消息的 totalTokenCount
     *
     * @param history 对话历史
     * @returns 回合列表
     */
    identifyRounds(history: Content[]): ConversationRound[] {
        const rounds: ConversationRound[] = [];
        let currentRoundStart = -1;
        let currentRoundTokenCount: number | undefined;
        
        for (let i = 0; i < history.length; i++) {
            const message = history[i];
            
            if (isRealUserMessage(message)) {
                // 只有真实用户输入才开始新回合。后台任务回执是旧任务的异步延续，
                // 若把它当新回合，超大工具回合会在裁剪时被整体丢弃。
                if (currentRoundStart !== -1) {
                    // 保存上一个回合
                    rounds.push({
                        startIndex: currentRoundStart,
                        endIndex: i,
                        tokenCount: currentRoundTokenCount
                    });
                }
                // 开始新回合
                currentRoundStart = i;
                currentRoundTokenCount = undefined;
            } else if (message.role === 'model') {
                // 记录助手消息的 token 数
                if (message.usageMetadata?.totalTokenCount !== undefined) {
                    currentRoundTokenCount = message.usageMetadata.totalTokenCount;
                }
            }
        }
        
        // 保存最后一个回合
        if (currentRoundStart !== -1) {
            rounds.push({
                startIndex: currentRoundStart,
                endIndex: history.length,
                tokenCount: currentRoundTokenCount
            });
        }
        
        return rounds;
    }

    /**
     * 计算上下文阈值
     *
     * 支持两种格式：
     * - 数值：直接使用
     * - 百分比字符串：如 "80%"，计算最大上下文的百分比
     *
     * @param threshold 阈值配置（数值或百分比字符串）
     * @param maxContextTokens 最大上下文 token 数
     * @param fallbackRatio 当阈值配置为非法值时的兜底比例（0-1，如 0.8 表示按最大上下文 80%）
     *                      传 0 表示非法值时回退到 0（不裁剪/不额外裁剪）
     * @returns 计算后的阈值
     */
    calculateThreshold(threshold: number | string, maxContextTokens: number, fallbackRatio = 0.8): number {
        if (typeof threshold === 'number') {
            return threshold;
        }

        // 百分比格式，如 "80%"
        if (threshold.endsWith('%')) {
            const percent = parseFloat(threshold.replace('%', ''));
            if (!isNaN(percent) && percent >= 0 && percent <= 100) {
                return Math.floor(maxContextTokens * percent / 100);
            }
        }

        // 非法值：回退到 fallbackRatio * maxContextTokens
        return Math.floor(maxContextTokens * fallbackRatio);
    }

    /**
     * 查找历史中最后一个总结消息的索引
     *
     * @param history 对话历史
     * @returns 最后一个总结消息的索引，如果没有则返回 -1
     */
    findLastSummaryIndex(history: Content[]): number {
        for (let i = history.length - 1; i >= 0; i--) {
            if (history[i].isSummary) {
                return i;
            }
        }
        return -1;
    }

    /**
     * 计算上下文裁剪后应该从哪个索引开始获取历史
     *
     * 当最新助手消息的 totalTokenCount 超过阈值时，
     * 计算需要跳过的回合，返回应该开始的消息索引
     *
     * 注意：这个方法不删除任何消息，只是计算过滤的起始位置
     *
     * @param history 对话历史
     * @param config 渠道配置
     * @param latestTokenCount 最新助手消息的 totalTokenCount
     * @returns 应该开始获取历史的索引（0 表示不需要裁剪）
     */
    calculateContextTrimStartIndex(
        history: Content[],
        config: BaseChannelConfig,
        latestTokenCount: number,
        modelOverride?: string
    ): number {
        const policy = this.resolveContextManagementPolicy(config);
        if (!policy.enabled || policy.mode !== 'trim') {
            return 0;
        }
        
        // 获取最大上下文和阈值
        const maxContextResolution = this.resolveMaxContextTokens(config, modelOverride);
        const maxContextTokens = maxContextResolution.maxContextTokens;
        const thresholdConfig = config.contextThreshold ?? '80%';
        const threshold = this.calculateThreshold(thresholdConfig, maxContextTokens);

        this.logDebug('calculateContextTrimStartIndex.threshold', {
            latestTokenCount,
            threshold,
            thresholdConfig,
            maxContextTokens,
            maxContextSource: maxContextResolution.source,
            configMaxContextTokens: maxContextResolution.configMaxContextTokens,
            modelId: maxContextResolution.modelId,
            modelContextWindow: maxContextResolution.modelContextWindow
        });
        
        // 如果未超过阈值，无需裁剪
        if (latestTokenCount <= threshold) {
            return 0;
        }
        
        // 识别回合
        const rounds = this.identifyRounds(history);
        
        // 至少需要保留当前回合（最后一个回合）
        if (rounds.length <= 1) {
            return 0;
        }
        
        // 估算每个回合的 token 数（基于最后一个有 token 记录的回合）
        // 简单策略：按回合数等比例估算
        const avgTokensPerRound = latestTokenCount / rounds.length;
        
        // 计算需要保留的回合数
        const targetTokens = threshold;
        const roundsToKeep = Math.max(1, Math.floor(targetTokens / avgTokensPerRound));
        
        // 需要跳过的回合数
        const roundsToSkip = Math.max(0, rounds.length - roundsToKeep);
        
        if (roundsToSkip === 0) {
            return 0;
        }
        
        // 返回应该开始的索引
        const startIndex = rounds[roundsToSkip].startIndex;
        
        return startIndex;
    }
    
    /**
     * 并行计算并更新消息的 token 数
     * 
     * @param conversationId 对话 ID
     * @param channelType 渠道类型
     * @param messages 需要计算的消息列表
     * @returns token 数数组
     */
    private async countAndUpdateMessageTokens(
        conversationId: string,
        channelType: string,
        messages: Array<{ index: number; message: Content }>
    ): Promise<number[]> {
        if (messages.length === 0) {
            return [];
        }
        
        // 使用 TokenEstimationService 的批量方法
        const messageIndices = messages.map(m => m.index);
        await this.tokenEstimationService.preCountUserMessageTokensBatch(
            conversationId,
            channelType,
            messageIndices
        );
        
        // 返回计算后的 token 数（从更新后的消息中获取）
        const updatedHistory = await this.conversationManager.getHistoryRef(conversationId);
        return messages.map(({ index }) => {
            const msg = updatedHistory[index];
            return msg?.tokenCountByChannel?.[channelType] ?? this.tokenEstimationService.estimateMessageTokens(msg);
        });
    }

    /**
     * 请求级细粒度裁剪的公共出口：把切点后的历史补成合法的角色顺序（model 开头时前置临时 user 占位）。
     */
    private normalizeFallbackHistoryStart(history: Content[]): Content[] {
        return history[0]?.role === 'model'
            ? [{
                role: 'user' as const,
                parts: [{ text: '[Earlier context was temporarily omitted after summarization failed.]' }],
                isSummary: true
            }, ...history]
            : history;
    }

    /**
     * 自动总结不可用或失败时的请求级细粒度裁剪。
     *
     * 该路径不写 trimState，不永久遮蔽 transcript；它按消息 token 预算选择安全切点，允许在长工具回合
     * 内部从 model 边界开始，并用临时 user 标记保证 provider 的角色顺序合法。
     *
     * @param stableStartIndex 同一真实用户回合内已确定的切点（绝对索引）。工具结果增长时复用该起点，
     * 保持每轮请求 retainedHistory 前缀一致，让 provider 前缀缓存可以命中；仅当完整性校验失败或
     * 估算总输入超过安全上限时才重新规划切点。新回合/总结成功后传 undefined。
     * @param fixedPromptTokens 系统提示词和本轮 prompt context 的 token 数；这些内容不在 history 中，
     * 但会随请求一起发送，因此必须从总输入预算中扣除。
     */
    async getHistoryWithGranularFallback(
        conversationId: string,
        config: BaseChannelConfig,
        historyOptions: GetHistoryOptions,
        modelOverride?: string,
        dynamicContextStrategy: DynamicContextStrategy = 'single',
        stableStartIndex?: number,
        fixedPromptTokens = 0
    ): Promise<ContextTrimInfo> {
        const rawHistory = await this.conversationManager.getHistoryRef(conversationId);
        if (rawHistory.length === 0) return { history: [], trimStartIndex: 0 };

        // 逻辑截断：被总结消息（isSummarized）不参与发送与统计（与 getHistoryWithContextTrimInfo 一致）
        const fullHistory = rawHistory.filter(message => !message.isSummarized);

        const lastSummaryIndex = this.findLastSummaryIndex(fullHistory);
        const historyStartIndex = lastSummaryIndex >= 0 ? lastSummaryIndex : 0;
        const messages = fullHistory.slice(historyStartIndex);
        const channelType = config.type || 'custom';
        const maxContextTokens = this.resolveMaxContextTokens(config, modelOverride).maxContextTokens;
        const actualModelWindow = resolveModelContextWindowForConfig(config, modelOverride)?.maxContextTokens;
        const threshold = this.calculateThreshold(config.contextThreshold ?? '80%', maxContextTokens);
        // contextThreshold 只是触发自动总结和“优先压缩到此处”的软阈值，绝不能当成主 Agent 的硬上限。
        // 95% 只作为优先裁剪目标，给 provider 包装/输出留出余量；真正拒绝请求的边界仍是完整模型窗口。
        const preferredInputTokenLimit = Math.max(
            1,
            Math.floor((actualModelWindow ?? maxContextTokens) * 0.95)
        );
        // 只有模型条目明确声明的 contextWindow 才能成为拒绝边界。渠道 maxContextTokens 是
        // 显示/上下文管理基准；模型元数据缺失时最多做 best-effort 裁剪，绝不据此阻止主请求。
        const hardInputTokenLimit = actualModelWindow;
        const fallbackEnvelopeInputTokenLimit = actualModelWindow ?? maxContextTokens;
        const softInputTokenLimit = Math.max(1, Math.min(threshold, preferredInputTokenLimit));
        const providerReserveTokens = Math.max(1, Math.floor(softInputTokenLimit * FALLBACK_PROVIDER_RESERVE_RATIO));
        const normalizedFixedPromptTokens = Number.isFinite(fixedPromptTokens)
            ? Math.max(0, Math.floor(fixedPromptTokens))
            : 0;
        const softHistoryBudgetTokens = Math.max(
            0,
            softInputTokenLimit - normalizedFixedPromptTokens - providerReserveTokens
        );
        const fallbackEnvelopeHistoryBudgetTokens = Math.max(
            0,
            fallbackEnvelopeInputTokenLimit - normalizedFixedPromptTokens
        );

        const estimateFinalHistoryTokens = (history: Content[]): number => history.reduce(
            (total, message) => total + this.tokenEstimationService.estimateMessageTokens(message),
            0
        );

        const throwContextOverflow = (minimumLegalHistoryTokens = 0): never => {
            if (hardInputTokenLimit === undefined) {
                throw new Error('Context overflow rejection requires a known model context window');
            }
            const estimatedMinimumInputTokens = normalizedFixedPromptTokens + minimumLegalHistoryTokens;
            this.log.error('trim.fallback_context_overflow', {
                conversationId,
                maxContextTokens,
                threshold,
                softInputTokenLimit,
                preferredInputTokenLimit,
                hardInputTokenLimit,
                fallbackEnvelopeInputTokenLimit,
                fixedPromptTokens: normalizedFixedPromptTokens,
                providerReserveTokens,
                softHistoryBudgetTokens,
                fallbackEnvelopeHistoryBudgetTokens,
                minimumLegalHistoryTokens,
                estimatedMinimumInputTokens,
                originalHistoryLength: fullHistory.length
            });
            throw new ContextBudgetExceededError(estimatedMinimumInputTokens, hardInputTokenLimit);
        };

        // 回合内稳定起点优先：工具结果增长不再把切点往后推（否则每轮 retainedHistory 开头漂移，
        // provider 前缀缓存只能命中 history 之前的固定系统/工具段）。稳定起点允许超过总结软阈值，
        // 只要完整请求仍装得进模型硬窗口；总结阈值不能让正在运行的 Agent 提前中止。
        if (typeof stableStartIndex === 'number' && stableStartIndex >= historyStartIndex && stableStartIndex < fullHistory.length) {
            const suffix = this.conversationManager.getHistoryForAPIFrom(fullHistory, {
                ...historyOptions,
                startIndex: stableStartIndex,
                includeTurnDynamicContext: dynamicContextStrategy === 'preserve'
            });
            if (validateHistoryIntegrity(suffix, { detectOrphanFunctionCall: true }).valid) {
                const historyWithUserInputs = this.prependPreservedUserInputs(
                    suffix,
                    fullHistory,
                    stableStartIndex
                );
                // 首条用户消息永远发送（任务锚点）
                const history = this.normalizeFallbackHistoryStart(
                    this.prependFirstUserMessage(fullHistory, historyWithUserInputs, stableStartIndex)
                );
                const estimatedStableTokens = estimateFinalHistoryTokens(history);
                if (estimatedStableTokens <= fallbackEnvelopeHistoryBudgetTokens) {
                    this.log.warn('trim.fallback_stable_start_reused', {
                        conversationId,
                        stableStartIndex,
                        estimatedStableTokens,
                        fixedPromptTokens: normalizedFixedPromptTokens,
                        providerReserveTokens,
                        softInputTokenLimit,
                        preferredInputTokenLimit,
                        hardInputTokenLimit,
                        fallbackEnvelopeInputTokenLimit,
                        softHistoryBudgetTokens,
                        fallbackEnvelopeHistoryBudgetTokens,
                        originalHistoryLength: fullHistory.length,
                        fallbackHistoryLength: history.length
                    });
                    return {
                        history,
                        trimStartIndex: stableStartIndex,
                        contextManagementDecision: {
                            enabled: true,
                            mode: 'summarize',
                            source: this.resolveContextManagementPolicy(config).source,
                            action: 'fallback_stable_start_reused'
                        }
                    };
                }
            }
        }

        const messageTokens = messages.map(message => {
            const byChannel = message.tokenCountByChannel?.[channelType];
            if (typeof byChannel === 'number') return byChannel;
            if (typeof message.estimatedTokenCount === 'number') return message.estimatedTokenCount;
            return this.tokenEstimationService.estimateMessageTokens(message);
        });

        const plan = planSummarizeMessages({
            messages,
            messageTokens,
            keepBudgetTokens: Math.max(1, softHistoryBudgetTokens),
            minKeepRounds: 1,
            mode: 'auto'
        });

        // planner 返回 null 既可能代表完整历史已经在预算内，也可能代表单个巨大回合无法按轮规划。
        // 两种情况都从最早合法起点开始逐个验证，绝不能因此直接返回未经预算检查的完整历史。
        const firstCandidateIndex = plan?.cutIndex ?? 0;
        const candidateIndices: number[] = [firstCandidateIndex];
        for (let i = firstCandidateIndex + 1; i < messages.length; i++) {
            if (messages[i]?.role === 'model' || isRealUserMessage(messages[i])) candidateIndices.push(i);
        }

        const evaluateCandidate = (relativeStartIndex: number): {
            relativeStartIndex: number;
            absoluteStartIndex: number;
            history: Content[];
            estimatedTokens: number;
        } | undefined => {
            const absoluteStartIndex = historyStartIndex + relativeStartIndex;
            const suffix = this.conversationManager.getHistoryForAPIFrom(fullHistory, {
                ...historyOptions,
                startIndex: absoluteStartIndex,
                includeTurnDynamicContext: dynamicContextStrategy === 'preserve'
            });
            if (!validateHistoryIntegrity(suffix, { detectOrphanFunctionCall: true }).valid) return undefined;

            const historyWithUserInputs = this.prependPreservedUserInputs(
                suffix,
                fullHistory,
                absoluteStartIndex
            );
            // 首条用户消息永远发送（任务锚点）
            const history = this.normalizeFallbackHistoryStart(
                this.prependFirstUserMessage(fullHistory, historyWithUserInputs, absoluteStartIndex)
            );
            const estimatedFallbackTokens = estimateFinalHistoryTokens(history);
            return { relativeStartIndex, absoluteStartIndex, history, estimatedTokens: estimatedFallbackTokens };
        };

        const softCandidate = candidateIndices
            .map(evaluateCandidate)
            .find((candidate): candidate is NonNullable<ReturnType<typeof evaluateCandidate>> => (
                !!candidate && candidate.estimatedTokens <= softHistoryBudgetTokens
            ));
        if (softCandidate) {
            this.log.warn('trim.fallback_granular_applied', {
                conversationId,
                absoluteStartIndex: softCandidate.absoluteStartIndex,
                relativeStartIndex: softCandidate.relativeStartIndex,
                boundary: plan?.boundary ?? 'unplanned',
                historyBudgetTokens: softHistoryBudgetTokens,
                fixedPromptTokens: normalizedFixedPromptTokens,
                providerReserveTokens,
                softInputTokenLimit,
                preferredInputTokenLimit,
                hardInputTokenLimit,
                fallbackEnvelopeInputTokenLimit,
                originalHistoryLength: fullHistory.length,
                fallbackHistoryLength: softCandidate.history.length
            });
            return {
                history: softCandidate.history,
                trimStartIndex: softCandidate.absoluteStartIndex,
                contextManagementDecision: {
                    enabled: true,
                    mode: 'summarize',
                    source: this.resolveContextManagementPolicy(config).source,
                    action: 'fallback_trim_applied'
                }
            };
        }

        // 无法达到自动总结软阈值时，从完整历史开始寻找仍低于模型硬窗口的最早合法起点。
        // 这条路径宁可多带上下文，也不能把“总结触发阈值”升级成主 Agent 的请求禁令。
        const hardCandidateIndices: number[] = [0];
        for (let i = 1; i < messages.length; i++) {
            if (messages[i]?.role === 'model' || isRealUserMessage(messages[i])) hardCandidateIndices.push(i);
        }
        const hardCandidates = hardCandidateIndices
            .map(evaluateCandidate)
            .filter((candidate): candidate is NonNullable<ReturnType<typeof evaluateCandidate>> => !!candidate);
        const hardCandidate = actualModelWindow === undefined
            ? undefined
            : hardCandidates.find(candidate => candidate.estimatedTokens <= fallbackEnvelopeHistoryBudgetTokens);
        if (hardCandidate) {
            this.log.warn('trim.fallback_hard_limit_applied', {
                conversationId,
                absoluteStartIndex: hardCandidate.absoluteStartIndex,
                relativeStartIndex: hardCandidate.relativeStartIndex,
                estimatedHistoryTokens: hardCandidate.estimatedTokens,
                softHistoryBudgetTokens,
                fallbackEnvelopeHistoryBudgetTokens,
                fixedPromptTokens: normalizedFixedPromptTokens,
                hardInputTokenLimit,
                originalHistoryLength: fullHistory.length,
                fallbackHistoryLength: hardCandidate.history.length
            });
            return {
                history: hardCandidate.history,
                trimStartIndex: hardCandidate.absoluteStartIndex,
                contextManagementDecision: {
                    enabled: true,
                    mode: 'summarize',
                    source: this.resolveContextManagementPolicy(config).source,
                    action: 'fallback_hard_limit_applied'
                }
            };
        }

        if (actualModelWindow === undefined && hardCandidates.length > 0) {
            // 不知道 provider 的真实窗口时，选择 token 最少的合法候选尽力降低失败概率，
            // 但绝不把渠道显示/总结基准升级成 CONTEXT_OVERFLOW 拒绝。
            const bestEffortCandidate = hardCandidates.reduce((best, candidate) => (
                candidate.estimatedTokens < best.estimatedTokens ? candidate : best
            ));
            this.log.warn('trim.fallback_best_effort_applied', {
                conversationId,
                absoluteStartIndex: bestEffortCandidate.absoluteStartIndex,
                relativeStartIndex: bestEffortCandidate.relativeStartIndex,
                estimatedHistoryTokens: bestEffortCandidate.estimatedTokens,
                softHistoryBudgetTokens,
                fallbackEnvelopeHistoryBudgetTokens,
                fixedPromptTokens: normalizedFixedPromptTokens,
                originalHistoryLength: fullHistory.length,
                fallbackHistoryLength: bestEffortCandidate.history.length
            });
            return {
                history: bestEffortCandidate.history,
                trimStartIndex: bestEffortCandidate.absoluteStartIndex,
                contextManagementDecision: {
                    enabled: true,
                    mode: 'summarize',
                    source: this.resolveContextManagementPolicy(config).source,
                    action: 'fallback_best_effort_applied'
                }
            };
        }

        const minimumLegalHistoryTokens = hardCandidates.reduce(
            (minimum, candidate) => Math.min(minimum, candidate.estimatedTokens),
            Number.POSITIVE_INFINITY
        );
        return throwContextOverflow(Number.isFinite(minimumLegalHistoryTokens) ? minimumLegalHistoryTokens : 0);
    }

    /**
     * 获取用于 API 调用的历史，应用总结过滤和上下文阈值裁剪
     *
     * 策略：
     * 1. 如果有总结消息，从最后一个总结消息开始获取历史
     * 2. 在此基础上，如果 token 数仍超过阈值，继续从总结后的回合中裁剪
     * 3. 使用每条消息的 tokenCountByChannel 来累加计算，避免上下文振荡
     * 4. 裁剪状态保存在内存中，避免重复触发裁剪
     * 5. 每次计算时检查是否可以恢复更多历史（思考 token 减少时）
     *
     * @param conversationId 对话 ID
     * @param config 渠道配置
     * @param historyOptions 历史选项
     * @param precomputedDynamicContextText 预生成的动态上下文文本（可选）。如果传入则直接使用，避免重复生成；如果不传则内部自动生成。
     * @returns 裁剪后的历史和裁剪信息
     */
    async getHistoryWithContextTrimInfo(
        conversationId: string,
        config: BaseChannelConfig,
        historyOptions: GetHistoryOptions,
        precomputedDynamicContextText?: string,
        promptModeSnapshot?: ResolvedPromptModeSnapshot,
        modelOverride?: string,
        dynamicContextStrategy: DynamicContextStrategy = 'single',
        evaluationOptions: ContextTrimEvaluationOptions = {}
    ): Promise<ContextTrimInfo> {
        // 先获取完整的原始历史（含已被总结覆盖的 isSummarized 消息）
        const rawHistory = await this.conversationManager.getHistoryRef(conversationId);
        
        // 如果历史为空，直接返回
        if (rawHistory.length === 0) {
            return { history: [], trimStartIndex: 0 };
        }

        // 逻辑截断：被总结覆盖的消息（isSummarized）不参与发送与统计，但原文完整保留在存储中
        // （可显示、可搜索）。过滤后的历史与「物理删除后」的历史语义完全等价，
        // 下游所有索引 / token / 回合计算无需感知标记消息，也不会因残留历史死循环触发总结。
        const fullHistory = rawHistory.filter(message => !message.isSummarized);
        
        const policy = this.resolveContextManagementPolicy(config);
        if (!policy.enabled) {
            // 总结（手动/自动）是用户显式要求建立的上下文边界，不应依赖自动上下文管理开关。
            // 总结采用逻辑截断语义：被覆盖消息打 isSummarized 标记保留在历史中（上面已过滤），
            // 发送时从最后一个总结消息开始，避免把总结边界之前的内容重新携带进请求
            // （否则等同于完全没有压缩）。
            const lastSummaryIndex = this.findLastSummaryIndex(fullHistory);
            if (lastSummaryIndex >= 0) {
                const normalizedHistory = await this.getNormalizedHistoryForStartIndex(
                    conversationId,
                    fullHistory,
                    historyOptions,
                    lastSummaryIndex,
                    lastSummaryIndex,
                    dynamicContextStrategy
                );
                this.log.info('manual_summary_boundary_applied', {
                    conversationId,
                    summaryStartIndex: lastSummaryIndex,
                    fullHistoryLength: fullHistory.length,
                    historyLength: normalizedHistory.history.length
                });
                return {
                    history: normalizedHistory.history,
                    trimStartIndex: normalizedHistory.trimStartIndex,
                    contextManagementDecision: {
                        enabled: false,
                        mode: 'off',
                        source: policy.source,
                        action: 'manual_summary_applied'
                    }
                };
            }

            // HIS-03/04：fullHistory 已在上面加载，直接复用，避免同一迭代内第二次 loadHistory
            const history = this.conversationManager.getHistoryForAPIFrom(fullHistory, {
                ...historyOptions,
                startIndex: 0,
                includeTurnDynamicContext: dynamicContextStrategy === 'preserve'
            });
            this.logDebug('trim.disabled', { conversationId, source: policy.source, fullHistoryLength: fullHistory.length });
            return {
                history,
                trimStartIndex: 0,
                contextManagementDecision: {
                    enabled: false,
                    mode: 'off',
                    source: policy.source,
                    action: 'disabled'
                }
            };
        }

        // 获取当前渠道类型（gemini, openai, anthropic, custom）
        const channelType = config.type || 'custom';
        
        // 查找最后一个总结消息
        const lastSummaryIndex = this.findLastSummaryIndex(fullHistory);
        
        // 基础起始索引（只考虑 summary）
        const summaryStartIndex = lastSummaryIndex >= 0 ? lastSummaryIndex : 0;
        
        // 从持久化存储获取裁剪状态
        let savedState = await this.getTrimState(conversationId);
        
        if (savedState) {
            // 检测回退：如果保存的 trimStartIndex 超出了当前历史长度，清除状态
            if (savedState.trimStartIndex >= fullHistory.length) {
                this.log.warn('trim_state_cleared_invalid', {
                    conversationId,
                    savedTrimStartIndex: savedState.trimStartIndex,
                    reason: 'out_of_bounds',
                    fullHistoryLength: fullHistory.length
                });
                await this.clearTrimState(conversationId);
                savedState = null;
            } else {
                const normalizedSavedState = this.normalizeTrimStartIndex(fullHistory, summaryStartIndex, savedState.trimStartIndex);
                if (!normalizedSavedState.valid) {
                    this.log.warn('trim_state_cleared_invalid', {
                        conversationId,
                        savedTrimStartIndex: savedState.trimStartIndex,
                        reason: normalizedSavedState.reason,
                        issueKind: normalizedSavedState.issueKind,
                        callId: normalizedSavedState.issueCallId
                    });
                    await this.clearTrimState(conversationId);
                    savedState = null;
                } else if (normalizedSavedState.startIndex !== savedState.trimStartIndex) {
                    this.log.info('trim_state_normalized', {
                        conversationId,
                        savedTrimStartIndex: savedState.trimStartIndex,
                        normalizedStartIndex: normalizedSavedState.startIndex,
                        cleared: normalizedSavedState.startIndex <= summaryStartIndex,
                        reason: normalizedSavedState.reason
                    });
                    if (normalizedSavedState.startIndex > summaryStartIndex) {
                        savedState = {
                            schemaVersion: CURRENT_TRIM_STATE_SCHEMA_VERSION,
                            trimStartIndex: normalizedSavedState.startIndex
                        };
                        await this.saveTrimState(conversationId, savedState);
                    } else {
                        await this.clearTrimState(conversationId);
                        savedState = null;
                    }
                }
            }
        }

        // 旧 trim 模式的回合内调用只能复用既有裁剪点，禁止大 functionResponse 临时推进持久状态。
        // summarize 模式不能在这里短路：长时间工具循环仍需每轮检查 token，并在接近上限时触发模型总结。
        if (evaluationOptions.allowStateAdvance === false && policy.mode === 'trim') {
            const turnStartIndex = savedState?.trimStartIndex ?? summaryStartIndex;
            const normalizedHistory = await this.getNormalizedHistoryForStartIndex(
                conversationId,
                fullHistory,
                historyOptions,
                summaryStartIndex,
                turnStartIndex,
                dynamicContextStrategy
            );
            this.logDebug('trim.turn_state_reused', {
                conversationId,
                requestedStartIndex: turnStartIndex,
                finalTrimStartIndex: normalizedHistory.trimStartIndex,
                fullHistoryLength: fullHistory.length
            });
            return {
                history: normalizedHistory.history,
                trimStartIndex: normalizedHistory.trimStartIndex,
                contextManagementDecision: {
                    enabled: true,
                    mode: policy.mode,
                    source: policy.source,
                    action: 'turn_state_reused'
                }
            };
        }
        
        // 加载 runtime 元数据以便正确生成系统提示词和动态上下文
        const [todoList, pinnedFiles, skills] = await Promise.all([
            this.conversationManager.getCustomMetadata(conversationId, 'todoList').catch(() => undefined),
            this.conversationManager.getCustomMetadata(conversationId, CONVERSATION_PINNED_FILES_KEY).catch(() => undefined),
            this.conversationManager.getCustomMetadata(conversationId, CONVERSATION_SKILLS_KEY).catch(() => undefined)
        ]);

        const runtime = {
            todoList,
            pinnedFiles,
            skills
        };

        // 收集需要计算 token 的内容：系统提示词、动态上下文、缺失 token 数的用户消息
        // 传入 runtime 以便正确解析模板中的变量
        const systemPrompt = this.promptManager.getSystemPrompt(promptModeSnapshot, false, runtime);
        
        // 使用预生成的 prompt context 文本（如果传入），否则内部生成；该文本包含 chat-history 前后两侧临时消息。
        let dynamicContextText: string;
        if (precomputedDynamicContextText !== undefined) {
            dynamicContextText = precomputedDynamicContextText;
        } else {
            dynamicContextText = this.promptManager.getDynamicContextText(promptModeSnapshot, runtime);
        }
        
        // 查找缺失 token 数的用户消息
        const missingTokenMessages: Array<{ index: number; message: Content }> = [];
        for (let i = 0; i < fullHistory.length; i++) {
            const message = fullHistory[i];
            if (message.role === 'user' && message.tokenCountByChannel?.[channelType] === undefined) {
                missingTokenMessages.push({ index: i, message });
            }
        }
        
        // 并行计算所有需要的 token 数
        const textsToCount = [systemPrompt, dynamicContextText];

        // 并行执行文本计数和消息计数
        const [textTokenResults, messageTokenResults] = await Promise.all([
            this.tokenEstimationService.countTextTokensBatch(textsToCount, channelType),
            missingTokenMessages.length > 0
                ? this.countAndUpdateMessageTokens(conversationId, channelType, missingTokenMessages)
                : Promise.resolve([] as number[])
        ]);

        const [systemPromptTokens, dynamicContextTokens] = textTokenResults;

        // 把精确计数结果回填到 fullHistory 快照，使 accumulateTokens 读到精确值而非粗估。
        // 计数结果已通过 preCountUserMessageTokensBatch 写回存储（下一轮生效），
        // 但本轮 accumulateTokens 读的是计数前的 fullHistory，需要就地修正。
        if (messageTokenResults.length > 0) {
            for (let i = 0; i < missingTokenMessages.length; i++) {
                const { index } = missingTokenMessages[i];
                const count = messageTokenResults[i];
                if (count !== undefined && fullHistory[index]) {
                    const existing = fullHistory[index].tokenCountByChannel;
                    fullHistory[index].tokenCountByChannel = {
                        ...existing,
                        [channelType]: count
                    };
                }
            }
        }
        
        // 系统提示词、动态上下文，以及最后总结之前按原文保留的真实用户输入。
        // 用户输入档案会实际注入请求，必须纳入阈值预算，不能因“通常较小”而漏算。
        const preservedUserInputsForBudget = this.createPreservedUserInputsMessage(fullHistory, summaryStartIndex);
        const preservedUserInputTokens = preservedUserInputsForBudget
            ? this.tokenEstimationService.estimateMessageTokens(preservedUserInputsForBudget)
            : 0;
        const promptTokens = systemPromptTokens + dynamicContextTokens + preservedUserInputTokens;
        
        // 从 historyOptions 获取用户配置
        const sendHistoryThoughts = historyOptions.sendHistoryThoughts ?? false;
        const sendHistoryThoughtSignatures = historyOptions.sendHistoryThoughtSignatures ?? false;
        const sendCurrentThoughts = historyOptions.sendCurrentThoughts ?? true;
        const sendCurrentThoughtSignatures = historyOptions.sendCurrentThoughtSignatures ?? false;
        const historyThinkingRounds = historyOptions.historyThinkingRounds ?? -1;
        
        // 找到最后一个非函数响应的 user 消息索引（当前轮次的起点）
        let lastNonFunctionResponseUserIndex = -1;
        for (let i = fullHistory.length - 1; i >= 0; i--) {
            const message = fullHistory[i];
            if (isRealUserMessage(message)) {
                lastNonFunctionResponseUserIndex = i;
                break;
            }
        }

        const preservedDynamicContextTokenByIndex = new Map<number, number>();
        if (dynamicContextStrategy === 'preserve') {
            const preservedDynamicContextEntries = fullHistory
                .map((message, index) => ({
                    index,
                    text: getPromptContextCacheDynamicSnapshotText(message.turnDynamicContext),
                    message
                }))
                .filter(({ index, text, message }) =>
                    index !== lastNonFunctionResponseUserIndex &&
                    message.role === 'user' &&
                    message.isUserInput &&
                    !!text?.trim()
                );
            const preservedDynamicContextTexts = preservedDynamicContextEntries.map(entry => entry.text!);
            const preservedDynamicContextTokens = await this.tokenEstimationService.countTextTokensBatch(preservedDynamicContextTexts, channelType);
            preservedDynamicContextEntries.forEach((entry, index) => {
                preservedDynamicContextTokenByIndex.set(entry.index, preservedDynamicContextTokens[index] ?? 0);
            });
        }
        
        // 识别所有回合起始位置
        const roundStartIndices: number[] = [];
        for (let i = 0; i < fullHistory.length; i++) {
            const message = fullHistory[i];
            if (isRealUserMessage(message)) {
                roundStartIndices.push(i);
            }
        }
        
        // 计算历史思考回合的有效范围（与 getHistoryForAPI 保持一致）
        let historyThoughtMinIndex = 0;
        let historyThoughtMaxIndex = lastNonFunctionResponseUserIndex;
        
        if (historyThinkingRounds === 0) {
            historyThoughtMinIndex = fullHistory.length;
            historyThoughtMaxIndex = -1;
        } else if (historyThinkingRounds > 0) {
            const totalRounds = roundStartIndices.length;
            if (totalRounds > 1) {
                const roundsToSkip = Math.max(0, totalRounds - 1 - historyThinkingRounds);
                if (roundsToSkip > 0 && roundsToSkip < totalRounds) {
                    historyThoughtMinIndex = roundStartIndices[roundsToSkip];
                }
            }
        }
        
        // 获取最大上下文和阈值
        const maxContextResolution = this.resolveMaxContextTokens(config, modelOverride);
        const maxContextTokens = maxContextResolution.maxContextTokens;
        const thresholdConfig = config.contextThreshold ?? '80%';
        const threshold = this.calculateThreshold(thresholdConfig, maxContextTokens);

        this.logDebug('trim.threshold_resolved', {
            conversationId,
            channelType,
            threshold,
            thresholdConfig,
            maxContextTokens,
            maxContextSource: maxContextResolution.source,
            configMaxContextTokens: maxContextResolution.configMaxContextTokens,
            modelId: maxContextResolution.modelId,
            modelContextWindow: maxContextResolution.modelContextWindow,
            contextManagementEnabled: policy.enabled,
            contextManagementMode: policy.mode,
            contextManagementSource: policy.source,
            contextTrimExtraCut: config.contextTrimExtraCut ?? 0,
            summaryStartIndex,
            savedTrimStartIndex: savedState?.trimStartIndex ?? null,
            fullHistoryLength: fullHistory.length
        });

        this.logDebug('trim.token_breakdown', {
            conversationId,
            systemPromptTokens,
            dynamicContextTokens,
            preservedUserInputTokens,
            promptTokens,
            missingTokenMessages: missingTokenMessages.length,
            historyThinkingRounds,
            sendHistoryThoughts,
            sendHistoryThoughtSignatures,
            sendCurrentThoughts,
            sendCurrentThoughtSignatures,
            historyThoughtMinIndex,
            historyThoughtMaxIndex
        });
        
        // ========== 自动总结模式 ==========
        // 自动总结模式下不做裁剪，而是返回「最后一个总结消息及其之后」的历史 + needsAutoSummarize
        // 标记，由 ToolIterationLoopService 在发送请求前触发总结。逻辑截断语义下被总结消息已在上方
        // 过滤（isSummarized 不参与统计），token 估算口径与模型视角一致，不会每轮反复触发。
        if (policy.mode === 'summarize') {
            // 首条用户消息永远发送（任务锚点）：getNormalizedHistoryForStartIndex 返回前统一调用
            // prependFirstUserMessage 原样前置（与 Preserved user inputs 档案并存，轻微冗余换取原话完整），
            // 这里不再手动拼接，避免重复。
            const normalizedHistory = await this.getNormalizedHistoryForStartIndex(
                conversationId,
                fullHistory,
                historyOptions,
                summaryStartIndex,
                summaryStartIndex,
                dynamicContextStrategy
            );
            const summarizeHistory = normalizedHistory.history;
            
            // 估算当前 token 总量来判断是否需要总结
            const fullTokenResult = this.accumulateTokens(
                fullHistory,
                summaryStartIndex,
                lastNonFunctionResponseUserIndex,
                historyThoughtMinIndex,
                historyThoughtMaxIndex,
                sendHistoryThoughts,
                sendHistoryThoughtSignatures,
                sendCurrentThoughts,
                sendCurrentThoughtSignatures,
                channelType,
                promptTokens,
                preservedDynamicContextTokenByIndex
            );

            // 直接复用现有 token 估算系统：
            // - 用户消息优先使用 estimatedTokenCount（由 TokenCount API 或本地估算预写入）
            // - 模型消息使用 usageMetadata（candidates/thoughts）或回退估算
            // 不再额外维护 totalTokenCount/安全系数等并行判定逻辑。
            const exceedsSoftThreshold = fullTokenResult.estimatedTotalTokens > threshold;
            const hardInputTokenLimit = resolveModelContextWindowForConfig(config, modelOverride)?.maxContextTokens;
            const compressibleHistoryTokens = Math.max(0, fullTokenResult.estimatedTotalTokens - promptTokens);
            const minimumUsefulHistoryTokens = Math.max(
                MIN_AUTO_SUMMARY_USEFUL_HISTORY_TOKENS,
                Math.min(
                    MAX_AUTO_SUMMARY_USEFUL_HISTORY_TOKENS,
                    Math.floor(maxContextTokens * AUTO_SUMMARY_USEFUL_HISTORY_RATIO)
                )
            );
            // 固定 prompt 自身已经越过总结软阈值时，总结无法把总量压回阈值以下。若此时只有很少的
            // 新历史可压缩，反复总结只会每轮省几百到一两千 token；跳过这次低收益总结并继续主请求。
            const lowSavingsBecauseFixedPromptExceedsThreshold =
                exceedsSoftThreshold &&
                promptTokens >= threshold &&
                compressibleHistoryTokens < minimumUsefulHistoryTokens;
            const needsAutoSummarize = exceedsSoftThreshold && !lowSavingsBecauseFixedPromptExceedsThreshold;
            // 跳过低收益总结不等于忽略真正的模型窗口。只有已经逼近硬窗口时才直接进入请求级 fallback；
            // 位于软阈值与硬窗口之间时原样继续，避免把总结阈值升级成 Agent 请求禁令。
            const needsContextFallback =
                !needsAutoSummarize &&
                hardInputTokenLimit !== undefined &&
                fullTokenResult.estimatedTotalTokens > hardInputTokenLimit;

            this.logDebug('trim.auto_summarize_check', {
                conversationId,
                estimatedTotalTokens: fullTokenResult.estimatedTotalTokens,
                threshold,
                hardInputTokenLimit,
                promptTokens,
                compressibleHistoryTokens,
                minimumUsefulHistoryTokens,
                lowSavingsBecauseFixedPromptExceedsThreshold,
                needsAutoSummarize,
                needsContextFallback
            });

            if (needsAutoSummarize) {
                this.log.info('auto_summarize_needed', { conversationId, estimatedTotalTokens: fullTokenResult.estimatedTotalTokens, threshold });
            }
            
            return {
                history: summarizeHistory,
                trimStartIndex: normalizedHistory.trimStartIndex,
                needsAutoSummarize,
                needsContextFallback,
                // 口径说明：fixedPromptTokens 只含系统提示词 + 动态上下文（不会随裁剪变化、且不在 history 中），
                // 不含 preservedUserInputTokens——被裁剪区域的逐字用户输入档案由 fallback 的 prependPreservedUserInputs
                // 在裁剪后的 history 内重新计算，若在此扣除会造成重复预算；而 accumulateTokens 的 promptTokens
                // （用于软阈值/硬窗口判定）是另一口径，包含该档案。
                fixedPromptTokens: systemPromptTokens + dynamicContextTokens,
                contextManagementDecision: {
                    enabled: true,
                    mode: 'summarize',
                    source: policy.source,
                    action: needsAutoSummarize
                        ? 'auto_summarize_needed'
                        : (needsContextFallback
                            ? 'hard_fallback_needed'
                            : (lowSavingsBecauseFixedPromptExceedsThreshold
                                ? 'auto_summarize_skipped_low_savings'
                                : 'not_needed'))
                }
            };
        }
        
        // ========== 上下文裁剪模式（原有逻辑） ==========
        
        // 检查是否可以恢复更多历史
        // 首先计算从 summaryStartIndex 开始的完整 token 数
        const fullTokenResult = this.accumulateTokens(
            fullHistory,
            summaryStartIndex,
            lastNonFunctionResponseUserIndex,
            historyThoughtMinIndex,
            historyThoughtMaxIndex,
            sendHistoryThoughts,
            sendHistoryThoughtSignatures,
            sendCurrentThoughts,
            sendCurrentThoughtSignatures,
            channelType,
            promptTokens,
            preservedDynamicContextTokenByIndex
        );

        this.logDebug('trim.full_history_estimate', {
            conversationId,
            estimatedTotalTokens: fullTokenResult.estimatedTotalTokens,
            threshold,
            roundCount: fullTokenResult.roundTokenInfos.length,
            summaryStartIndex,
            usageStats: fullTokenResult.usageStats
        });
        
        // 如果完整历史不超过阈值，清除裁剪状态，返回完整历史
        if (fullTokenResult.estimatedTotalTokens <= threshold) {
            await this.clearTrimState(conversationId);
            const normalizedHistory = await this.getNormalizedHistoryForStartIndex(
                conversationId,
                fullHistory,
                historyOptions,
                summaryStartIndex,
                summaryStartIndex,
                dynamicContextStrategy
            );
            this.logDebug('trim.not_needed', {
                conversationId,
                estimatedTotalTokens: fullTokenResult.estimatedTotalTokens,
                threshold
            });
            return {
                history: normalizedHistory.history,
                trimStartIndex: normalizedHistory.trimStartIndex,
                contextManagementDecision: {
                    enabled: true,
                    mode: 'trim',
                    source: policy.source,
                    action: 'not_needed'
                }
            };
        }
        
        // 完整历史超过阈值，需要裁剪
        // 如果有保存的裁剪状态，检查使用该状态后是否仍超过阈值
        if (savedState && savedState.trimStartIndex > summaryStartIndex) {
            const trimmedTokenResult = this.accumulateTokens(
                fullHistory,
                savedState.trimStartIndex,
                lastNonFunctionResponseUserIndex,
                historyThoughtMinIndex,
                historyThoughtMaxIndex,
                sendHistoryThoughts,
                sendHistoryThoughtSignatures,
                sendCurrentThoughts,
                sendCurrentThoughtSignatures,
                channelType,
                promptTokens,
                preservedDynamicContextTokenByIndex
            );

            this.logDebug('trim.saved_state_estimate', {
                conversationId,
                savedTrimStartIndex: savedState.trimStartIndex,
                estimatedTotalTokens: trimmedTokenResult.estimatedTotalTokens,
                threshold,
                roundCount: trimmedTokenResult.roundTokenInfos.length,
                usageStats: trimmedTokenResult.usageStats
            });
            
            // 如果使用保存的状态后不超过阈值，直接使用
            if (trimmedTokenResult.estimatedTotalTokens <= threshold) {
                const normalizedHistory = await this.getNormalizedHistoryForStartIndex(
                    conversationId,
                    fullHistory,
                    historyOptions,
                    summaryStartIndex,
                    savedState.trimStartIndex,
                    dynamicContextStrategy
                );
                
                this.logDebug('trim.saved_state_reused', {
                    conversationId,
                    finalTrimStartIndex: normalizedHistory.trimStartIndex
                });

                return {
                    history: normalizedHistory.history,
                    trimStartIndex: normalizedHistory.trimStartIndex,
                    contextManagementDecision: {
                        enabled: true,
                        mode: 'trim',
                        source: policy.source,
                        action: 'saved_state_reused'
                    }
                };
            }
            
            // 使用保存的状态后仍然超过阈值，需要进一步裁剪
            // 使用 trimmedTokenResult 的回合信息进行裁剪
            return await this.performContextTrim(
                conversationId,
                fullHistory,
                config,
                historyOptions,
                savedState.trimStartIndex,
                trimmedTokenResult.estimatedTotalTokens,
                promptTokens,
                trimmedTokenResult.roundTokenInfos,
                threshold,
                maxContextTokens,
                dynamicContextStrategy
            );
        }
        
        // 没有保存的状态，或者状态无效，从 summaryStartIndex 开始裁剪
        return await this.performContextTrim(
            conversationId,
            fullHistory,
            config,
            historyOptions,
            summaryStartIndex,
            fullTokenResult.estimatedTotalTokens,
            promptTokens,
            fullTokenResult.roundTokenInfos,
            threshold,
            maxContextTokens,
            dynamicContextStrategy
        );
    }

    /**
     * 累加消息的 token 数
     * 
     * @param promptTokens 系统提示词 + 动态上下文的总 token 数
     * @returns 累加结果
     */
    private accumulateTokens(
        fullHistory: Content[],
        effectiveStartIndex: number,
        lastNonFunctionResponseUserIndex: number,
        historyThoughtMinIndex: number,
        historyThoughtMaxIndex: number,
        sendHistoryThoughts: boolean,
        sendHistoryThoughtSignatures: boolean,
        sendCurrentThoughts: boolean,
        sendCurrentThoughtSignatures: boolean,
        channelType: string,
        promptTokens: number,  // 系统提示词 + 当前动态上下文的总 token 数
        preservedDynamicContextTokenByIndex: Map<number, number> = new Map()
    ): { estimatedTotalTokens: number; hasEstimatedTokens: boolean; roundTokenInfos: RoundTokenInfo[]; usageStats: AccumulateUsageStats } {
        let estimatedTotalTokens = promptTokens;
        let hasEstimatedTokens = promptTokens > 0;
        const roundTokenInfos: RoundTokenInfo[] = [];
        let currentRoundStartIndex = -1;
        const usageStats: AccumulateUsageStats = {
            modelMessagesWithUsage: 0,
            modelMessagesOutputBased: 0,
            modelMessagesMismatch: 0,
            modelMessagesWithoutUsage: 0,
            userMessages: 0,
            userFromChannelCount: 0,
            userFromEstimatedFieldCount: 0,
            userFromLocalEstimateCount: 0,
            userTokensTotal: 0,
            modelTokensTotal: 0
        };
        
        // 只累加 effectiveStartIndex 之后的消息
        for (let i = effectiveStartIndex; i < fullHistory.length; i++) {
            const message = fullHistory[i];
            
            if (message.role === 'user') {
                // 只有真实用户输入才开始新回合；functionResponse、总结和后台任务回执都属于当前回合。
                if (isRealUserMessage(message)) {
                    // 保存上一个回合的信息
                    if (currentRoundStartIndex !== -1) {
                        roundTokenInfos.push({
                            startIndex: currentRoundStartIndex,
                            endIndex: i,
                            cumulativeTokens: estimatedTotalTokens
                        });
                    }
                    currentRoundStartIndex = i;
                }

                const preservedDynamicContextTokens = preservedDynamicContextTokenByIndex.get(i) ?? 0;
                if (preservedDynamicContextTokens > 0) {
                    estimatedTotalTokens += preservedDynamicContextTokens;
                    usageStats.userTokensTotal += preservedDynamicContextTokens;
                    hasEstimatedTokens = true;
                }
                
                // 用户消息：优先使用当前渠道的 tokenCountByChannel，其次 estimatedTokenCount，最后回退估算
                usageStats.userMessages++;

                let tokenCount = message.tokenCountByChannel?.[channelType];
                if (tokenCount !== undefined) {
                    usageStats.userFromChannelCount++;
                } else if (message.estimatedTokenCount !== undefined) {
                    tokenCount = message.estimatedTokenCount;
                    usageStats.userFromEstimatedFieldCount++;
                } else {
                    tokenCount = this.tokenEstimationService.estimateMessageTokens(message);
                    usageStats.userFromLocalEstimateCount++;
                }

                if (tokenCount === undefined) {
                    tokenCount = 0;
                }

                estimatedTotalTokens += tokenCount;
                usageStats.userTokensTotal += tokenCount;
                hasEstimatedTokens = true;
            } else if (message.role === 'model' && message.usageMetadata) {
                usageStats.modelMessagesWithUsage++;
                // model 消息：根据用户配置、消息内容和回合位置决定是否计算思考 token
                const isCurrentRound = i >= lastNonFunctionResponseUserIndex;
                const hasThought = this.messageBuilderService.hasThoughtContent(message.parts);
                const hasSignatures = this.messageBuilderService.hasThoughtSignatures(message.parts);
                
                let includeThoughtsToken = false;
                
                if (isCurrentRound) {
                    // 当前轮：仅在“发送思考内容”时计入 thoughtsTokenCount。
                    // sendCurrentThoughtSignatures 只表示发送签名，不应等价于发送完整思考文本，
                    // 否则会把 reasoning token 全量计入，导致显著高估。
                    includeThoughtsToken = sendCurrentThoughts && hasThought;
                } else {
                    // 历史轮：根据历史轮配置、消息内容和 historyThinkingRounds 决定
                    const isInHistoryThoughtRange = i >= historyThoughtMinIndex && i < historyThoughtMaxIndex;
                    if (isInHistoryThoughtRange) {
                        // 历史轮同理：仅在真正发送历史思考文本时计入 thoughtsTokenCount。
                        // sendHistoryThoughtSignatures=true 时通常只发送签名引用，不应按完整思考 token 计算。
                        includeThoughtsToken = sendHistoryThoughts && hasThought;
                    }
                }

                const signaturesOnlyMode = isCurrentRound
                    ? (!sendCurrentThoughts && sendCurrentThoughtSignatures && hasSignatures)
                    : ((i >= historyThoughtMinIndex && i < historyThoughtMaxIndex) && !sendHistoryThoughts && sendHistoryThoughtSignatures && hasSignatures);
                if (signaturesOnlyMode) {
                    // 保留分支变量用于可读性和后续调试扩展
                }
                
                const usage = message.usageMetadata;
                const rawCandidatesTokens = Math.max(0, usage.candidatesTokenCount ?? 0);
                const rawThoughtsTokens = Math.max(0, usage.thoughtsTokenCount ?? 0);

                let normalizedCandidatesTokens = rawCandidatesTokens;
                let normalizedThoughtsTokens = rawThoughtsTokens;

                const hasPromptAndTotal = typeof usage.promptTokenCount === 'number' && typeof usage.totalTokenCount === 'number';
                if (hasPromptAndTotal) {
                    const outputTokensFromTotal = Math.max(0, usage.totalTokenCount! - usage.promptTokenCount!);
                    normalizedThoughtsTokens = Math.min(rawThoughtsTokens, outputTokensFromTotal);
                    normalizedCandidatesTokens = Math.max(0, outputTokensFromTotal - normalizedThoughtsTokens);
                    usageStats.modelMessagesOutputBased++;

                    const rawCombined = rawCandidatesTokens + rawThoughtsTokens;
                    if (Math.abs(rawCombined - outputTokensFromTotal) > 1) {
                        usageStats.modelMessagesMismatch++;
                    }
                }

                const modelTokens = normalizedCandidatesTokens +
                    (includeThoughtsToken ? normalizedThoughtsTokens : 0);
                if (modelTokens > 0) {
                    usageStats.modelTokensTotal += modelTokens;
                    estimatedTotalTokens += modelTokens;
                    hasEstimatedTokens = true;
                }
            } else if (message.role === 'model') {
                usageStats.modelMessagesWithoutUsage++;
                // model 消息没有 usageMetadata，估算 token 数
                const modelTokens = this.tokenEstimationService.estimateMessageTokens(message);
                usageStats.modelTokensTotal += modelTokens;
                estimatedTotalTokens += modelTokens;
                hasEstimatedTokens = true;
            }
        }
        
        // 保存最后一个回合
        if (currentRoundStartIndex !== -1) {
            roundTokenInfos.push({
                startIndex: currentRoundStartIndex,
                endIndex: fullHistory.length,
                cumulativeTokens: estimatedTotalTokens
            });
        }
        
        return { estimatedTotalTokens, hasEstimatedTokens, roundTokenInfos, usageStats };
    }

    /**
     * 执行上下文裁剪
     * 
     * @param promptTokens 系统提示词 + 动态上下文的总 token 数
     */
    private async performContextTrim(
        conversationId: string,
        fullHistory: Content[],
        config: BaseChannelConfig,
        historyOptions: GetHistoryOptions,
        effectiveStartIndex: number,
        estimatedTotalTokens: number,
        promptTokens: number,  // 系统提示词 + 动态上下文的总 token 数
        roundsAfterStart: RoundTokenInfo[],
        threshold: number,
        maxContextTokens: number,
        dynamicContextStrategy: DynamicContextStrategy = 'single'
    ): Promise<ContextTrimInfo> {
        // 至少需要保留当前回合（最后一个回合）
        if (roundsAfterStart.length <= 1) {
            const normalizedHistory = await this.getNormalizedHistoryForStartIndex(
                conversationId,
                fullHistory,
                historyOptions,
                effectiveStartIndex,
                effectiveStartIndex,
                dynamicContextStrategy
            );
            this.logDebug('trim.perform.no_additional_cut', {
                conversationId,
                effectiveStartIndex: normalizedHistory.trimStartIndex,
                estimatedTotalTokens,
                reason: 'only_one_round'
            });
            return { history: normalizedHistory.history, trimStartIndex: normalizedHistory.trimStartIndex };
        }
        
        // 计算额外裁剪的 token 数
        // 额外裁剪是基于最大上下文计算的
        // 例如：最大上下文 200k，阈值 80%（160k），额外裁剪 30%（60k）
        // 当超过 160k 时触发裁剪，裁剪目标 = 160k - 60k = 100k
        // 这样下次从 100k 增长到 160k 需要更多回合，避免频繁触发裁剪
        const extraCutConfig = config.contextTrimExtraCut ?? 0;
        const extraCut = this.calculateThreshold(extraCutConfig, maxContextTokens, 0);
        
        // 实际保留目标 = 阈值 - 额外裁剪
        const targetTokens = Math.max(0, threshold - extraCut);

        // 额外裁剪 >= 阈值 → targetTokens=0，一次裁剪会清空整段对话；记警告防止静默全裁
        if (targetTokens === 0 && extraCut > 0) {
            this.logDebug('trim.extraCut.zeroTarget', {
                threshold,
                extraCut,
                extraCutConfig,
                maxContextTokens,
            });
        }

        this.logDebug('trim.perform.start', {
            conversationId,
            effectiveStartIndex,
            estimatedTotalTokens,
            promptTokens,
            threshold,
            extraCutConfig,
            extraCut,
            targetTokens,
            roundsAfterStart: roundsAfterStart.length
        });
        
        // 使用自计算的累计 token 数来计算需要跳过多少回合
        let roundsToSkip = 0;
        let remainingEstimatedTokensAfterTrim = estimatedTotalTokens;
        const roundEvaluation: Array<{ k: number; remainingTokens: number }> = [];
        
        // 从 k=1 开始尝试，k 表示要跳过的回合数（从第 k 个回合开始保留）
        for (let k = 1; k < roundsAfterStart.length; k++) {
            const skippedTokens = roundsAfterStart[k - 1].cumulativeTokens - promptTokens;
            const remainingTokens = estimatedTotalTokens - skippedTokens;
            roundEvaluation.push({ k, remainingTokens });

            if (remainingTokens <= targetTokens) {
                roundsToSkip = k;
                break;
            }
        }
        
        // 如果遍历完还没找到合适的裁剪点，且总 token 超过阈值，只保留最后一个回合
        if (roundsToSkip === 0 && estimatedTotalTokens > targetTokens) {
            roundsToSkip = roundsAfterStart.length - 1;
        }

        if (roundsToSkip > 0) {
            const skippedTokens = roundsAfterStart[roundsToSkip - 1].cumulativeTokens - promptTokens;
            remainingEstimatedTokensAfterTrim = estimatedTotalTokens - skippedTokens;
        }
        
        if (roundsToSkip === 0) {
            // 不需要额外裁剪，返回从起始索引开始的历史
            const normalizedHistory = await this.getNormalizedHistoryForStartIndex(
                conversationId,
                fullHistory,
                historyOptions,
                effectiveStartIndex,
                effectiveStartIndex,
                dynamicContextStrategy
            );
            this.logDebug('trim.perform.no_additional_cut', {
                conversationId,
                effectiveStartIndex: normalizedHistory.trimStartIndex,
                estimatedTotalTokens,
                threshold,
                targetTokens,
                remainingEstimatedTokensAfterTrim,
                roundEvaluation
            });
            return { history: normalizedHistory.history, trimStartIndex: normalizedHistory.trimStartIndex };
        }
        
        // 计算在原始历史中的起始索引
        const trimStartIndex = roundsAfterStart[roundsToSkip].startIndex;
        
        const normalizedTrimmedHistory = await this.getNormalizedHistoryForStartIndex(
            conversationId,
            fullHistory,
            historyOptions,
            effectiveStartIndex,
            trimStartIndex,
            dynamicContextStrategy
        );
        const trimmedHistory = normalizedTrimmedHistory.history;
        const finalTrimStartIndex = normalizedTrimmedHistory.trimStartIndex;
        
        // 保存裁剪状态到持久化存储
        if (normalizedTrimmedHistory.normalization.valid) {
            await this.saveTrimState(conversationId, {
                trimStartIndex: finalTrimStartIndex
            });
        } else {
            this.log.warn('trim_state_cleared_invalid', {
                conversationId,
                savedTrimStartIndex: trimStartIndex,
                reason: normalizedTrimmedHistory.normalization.reason,
                issueKind: normalizedTrimmedHistory.normalization.issueKind,
                callId: normalizedTrimmedHistory.normalization.issueCallId
            });
            await this.clearTrimState(conversationId);
        }

        this.logDebug('trim.perform.applied', {
            conversationId,
            roundsToSkip,
            trimStartIndex,
            finalTrimStartIndex,
            trimmedHistoryLength: trimmedHistory.length,
            estimatedTotalTokens,
            threshold,
            targetTokens,
            remainingEstimatedTokensAfterTrim,
            roundEvaluation
        });
        
        return {
            history: trimmedHistory,
            trimStartIndex: finalTrimStartIndex,
            contextManagementDecision: {
                enabled: true,
                mode: 'trim',
                source: this.resolveContextManagementPolicy(config).source,
                action: 'trim_applied'
            }
        };
    }

    /**
     * 获取用于 API 调用的历史（保持向后兼容的简化版本）
     */
    async getHistoryWithContextTrim(
        conversationId: string,
        config: BaseChannelConfig,
        historyOptions: GetHistoryOptions,
        precomputedDynamicContextText?: string,
        promptModeSnapshot?: ResolvedPromptModeSnapshot,
        modelOverride?: string,
        dynamicContextStrategy: DynamicContextStrategy = 'single'
    ): Promise<Content[]> {
        const result = await this.getHistoryWithContextTrimInfo(conversationId, config, historyOptions, precomputedDynamicContextText, promptModeSnapshot, modelOverride, dynamicContextStrategy);
        return result.history;
    }
}
