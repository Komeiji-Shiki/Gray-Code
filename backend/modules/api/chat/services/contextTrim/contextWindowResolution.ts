/**
 * 上下文窗口解析（纯函数模块，从 ContextTrimService 抽离）。
 *
 * 负责把「渠道配置 + 模型覆盖」解析为本次请求可用的最大上下文 token 数：
 * - 显式配置 maxContextTokens 优先
 * - 其次当前模型在 models 列表中声明的 contextWindow
 * - 最后回退到默认值 256000
 *
 * 不依赖任何服务实例，便于单测与复用（SummarizeService 也直接引用本模块导出）。
 */

import type { BaseChannelConfig, ModelInfo } from '../../../../config/configs/base';

export const DEFAULT_MAX_CONTEXT_TOKENS = 256000;

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
