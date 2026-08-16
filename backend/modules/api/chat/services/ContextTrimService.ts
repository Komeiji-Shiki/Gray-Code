/**
 * GrayCode - 上下文裁剪服务
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
 *
 * 实现说明：本文件只保留 ContextTrimService 的对外 API 与轻量委托；各职责已按
 * 「上下文窗口解析 / 策略 / 回合识别 / 保留用户输入 / 裁剪起点归一化 / token 累加 /
 * 裁剪计划 / fallback / 主流程」拆到 ./contextTrim/ 下的独立模块。
 */

import type { Content } from '../../../conversation/types';
import type { ConversationManager, GetHistoryOptions } from '../../../conversation/ConversationManager';
import type { PromptManager } from '../../../prompt';
import type { DynamicContextStrategy, ResolvedPromptModeSnapshot } from '../../../settings/types';
import type { BaseChannelConfig } from '../../../config/configs/base';
import type { ConversationRound, ContextTrimInfo } from '../utils';
import type { TokenEstimationService } from './TokenEstimationService';
import type { MessageBuilderService } from './MessageBuilderService';
import { Logger } from '../../../../core/logger';

import {
    resolveModelContextWindowForConfig,
    resolveMaxContextTokensForConfig,
    resolveMaxOutputTokensForConfig,
    DEFAULT_MAX_CONTEXT_TOKENS,
    type MaxContextResolution
} from './contextTrim/contextWindowResolution';
import {
    identifyConversationRounds,
    calculateContextThreshold,
    findLastSummaryIndex
} from './contextTrim/roundDetection';
import {
    createPreservedUserInputsMessage,
    PRESERVED_USER_INPUT_MAX_CHARS
} from './contextTrim/preservedUserInputs';
import { computeValidSuffixMap } from './contextTrim/historyNormalization';
import {
    getHistoryWithGranularFallback,
    ContextBudgetExceededError
} from './contextTrim/granularFallback';
import {
    getHistoryWithContextTrimInfo,
    type ContextTrimEvaluationOptions
} from './contextTrim/contextTrimInfo';
import { planContextTrimStartIndex } from './contextTrim/contextTrimPlanner';
import { clearTrimState as clearTrimStateForService } from './contextTrim/trimState';

export {
    DEFAULT_MAX_CONTEXT_TOKENS,
    resolveModelContextWindowForConfig,
    resolveMaxContextTokensForConfig,
    resolveMaxOutputTokensForConfig
};
export type { MaxContextResolution };
export { PRESERVED_USER_INPUT_MAX_CHARS };
export { ContextBudgetExceededError };
export type { ContextTrimEvaluationOptions };

export class ContextTrimService {
    private readonly log = Logger.get('ContextTrim');

    constructor(
        private conversationManager: ConversationManager,
        private promptManager: PromptManager,
        private tokenEstimationService: TokenEstimationService,
        private messageBuilderService: MessageBuilderService
    ) {}

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
        await clearTrimStateForService(this.conversationManager, conversationId);
    }

    /**
     * PERF：一次从右向左扫描，预计算每个下标 i 的「切片 fullHistory.slice(i) 是否通过
     * validateHistoryIntegrity」判定（validSuffix[i]）。
     *
     * 保留为私有方法以兼容既有测试对 (service as any).computeValidSuffixMap 的调用；
     * 实现委托到 contextTrim/historyNormalization。
     */
    private computeValidSuffixMap(fullHistory: Content[]): boolean[] {
        return computeValidSuffixMap(fullHistory);
    }

    /**
     * 保留用户输入档案构造（私有方法，兼容既有测试对
     * (service as any).createPreservedUserInputsMessage 的调用）。
     */
    private createPreservedUserInputsMessage(fullHistory: Content[], beforeIndex: number): Content | undefined {
        return createPreservedUserInputsMessage(fullHistory, beforeIndex);
    }

    /**
     * 解析当前轮应使用的最大上下文 token 数。
     */
    resolveMaxContextTokens(config: BaseChannelConfig, modelOverride?: string): MaxContextResolution {
        return resolveMaxContextTokensForConfig(config, modelOverride);
    }

    /**
     * 识别对话回合
     */
    identifyRounds(history: Content[]): ConversationRound[] {
        return identifyConversationRounds(history);
    }

    /**
     * 计算上下文阈值
     */
    calculateThreshold(threshold: number | string, maxContextTokens: number, fallbackRatio = 0.8): number {
        return calculateContextThreshold(threshold, maxContextTokens, fallbackRatio);
    }

    /**
     * 查找历史中最后一个总结消息的索引
     */
    findLastSummaryIndex(history: Content[]): number {
        return findLastSummaryIndex(history);
    }

    /**
     * 计算上下文裁剪后应该从哪个索引开始获取历史
     */
    calculateContextTrimStartIndex(
        history: Content[],
        config: BaseChannelConfig,
        latestTokenCount: number,
        modelOverride?: string
    ): number {
        return planContextTrimStartIndex(history, config, latestTokenCount, modelOverride, this.log);
    }

    /**
     * 自动总结不可用或失败时的请求级细粒度裁剪。
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
        return getHistoryWithGranularFallback(
            {
                conversationManager: this.conversationManager,
                tokenEstimationService: this.tokenEstimationService,
                log: this.log
            },
            conversationId,
            config,
            historyOptions,
            modelOverride,
            dynamicContextStrategy,
            stableStartIndex,
            fixedPromptTokens
        );
    }

    /**
     * 获取用于 API 调用的历史，应用总结过滤和上下文阈值裁剪
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
        return getHistoryWithContextTrimInfo(
            {
                conversationManager: this.conversationManager,
                promptManager: this.promptManager,
                tokenEstimationService: this.tokenEstimationService,
                messageBuilderService: this.messageBuilderService,
                log: this.log
            },
            conversationId,
            config,
            historyOptions,
            precomputedDynamicContextText,
            promptModeSnapshot,
            modelOverride,
            dynamicContextStrategy,
            evaluationOptions
        );
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
