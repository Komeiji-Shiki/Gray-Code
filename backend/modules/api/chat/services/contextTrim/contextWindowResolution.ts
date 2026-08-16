/**
 * 上下文窗口解析（纯函数模块，从 ContextTrimService 抽离）。
 *
 * 负责把「渠道配置 + 模型覆盖」解析为本次请求可用的上下文预算：
 * - 显式配置 maxContextTokens 优先
 * - 其次当前模型在 models 列表中声明的 contextWindow
 * - 最后回退到默认值 256000
 *
 * 对 OpenAI/Responses/Anthropic 这类组合上下文窗口，输入预算还要扣除本次
 * 请求可能占用的最大输出 token；Gemini 原生模型的 inputTokenLimit 本身就是
 * 输入上限，不重复扣除 outputTokenLimit。
 *
 * 不依赖任何服务实例，便于单测与复用（SummarizeService、SubAgent 也直接引用）。
 */

import type { BaseChannelConfig, ModelInfo } from '../../../../config/configs/base';

export const DEFAULT_MAX_CONTEXT_TOKENS = 256000;

type ContextWindowSource = 'config.maxContextTokens' | 'model.contextWindow' | 'default';
type OutputTokenSource = 'config.options' | 'model.maxOutputTokens' | 'none';

export interface MaxContextResolution {
    /** 原始/声明的模型上下文窗口（组合窗口或 provider input limit）。 */
    maxContextTokens: number;
    /** 当前请求可使用的输入 token 预算（已扣除组合窗口中的输出预留）。 */
    maxInputTokens: number;
    /** 本次请求采用的最大输出 token 预留；未知时为空。 */
    maxOutputTokens?: number;
    /** maxContextTokens 是否与输出共享同一个组合窗口。 */
    contextWindowIncludesOutput: boolean;
    source: ContextWindowSource;
    outputTokenSource: OutputTokenSource;
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

function resolveModelInfo(config: BaseChannelConfig, modelOverride?: string): ModelInfo | undefined {
    const candidateModelId = resolveCandidateModelId(config, modelOverride);
    if (!candidateModelId) return undefined;
    const modelList = Array.isArray((config as { models?: unknown }).models)
        ? ((config as { models?: ModelInfo[] }).models as ModelInfo[])
        : [];
    return modelList.find(model => model?.id === candidateModelId);
}

/** 读取当前渠道真正会发送的显式最大输出 token 配置。 */
function resolveConfiguredOutputTokens(config: BaseChannelConfig): number | undefined {
    const options = (config as { options?: Record<string, unknown> }).options;
    const optionsEnabled = (config as { optionsEnabled?: Record<string, unknown> }).optionsEnabled;
    if (!options || !optionsEnabled) return undefined;

    let enabledKey: string;
    let valueKey: string;
    switch (config.type) {
        case 'gemini':
        case 'gemini-interactions':
            enabledKey = 'maxOutputTokens';
            valueKey = 'maxOutputTokens';
            break;
        case 'openai':
        case 'anthropic':
            enabledKey = 'max_tokens';
            valueKey = 'max_tokens';
            break;
        case 'openai-responses':
            enabledKey = 'max_output_tokens';
            valueKey = 'max_output_tokens';
            break;
        default:
            return undefined;
    }

    if (optionsEnabled[enabledKey] !== true) return undefined;
    return normalizePositiveTokenValue(options[valueKey]);
}

/**
 * Gemini 原生 / Interactions 的 inputTokenLimit 是输入上限；
 * OpenAI-compatible/OpenAI Responses/Anthropic 的 context window 通常是输入+输出组合窗口。
 * 模型条目可以显式覆盖该判断，供第三方模型列表适配。
 */
function resolveContextWindowIncludesOutput(config: BaseChannelConfig, modelInfo?: ModelInfo): boolean {
    if (typeof modelInfo?.contextWindowIncludesOutput === 'boolean') {
        return modelInfo.contextWindowIncludesOutput;
    }
    return config.type === 'openai'
        || config.type === 'openai-responses'
        || config.type === 'anthropic';
}

function buildResolution(
    config: BaseChannelConfig,
    maxContextTokens: number,
    source: ContextWindowSource,
    modelInfo?: ModelInfo,
    modelId?: string
): MaxContextResolution {
    const configuredOutputTokens = resolveConfiguredOutputTokens(config);
    const modelOutputTokens = normalizePositiveTokenValue(modelInfo?.maxOutputTokens);
    const maxOutputTokens = configuredOutputTokens ?? modelOutputTokens;
    const outputTokenSource: OutputTokenSource = configuredOutputTokens !== undefined
        ? 'config.options'
        : (modelOutputTokens !== undefined ? 'model.maxOutputTokens' : 'none');
    const contextWindowIncludesOutput = resolveContextWindowIncludesOutput(config, modelInfo);
    const maxInputTokens = contextWindowIncludesOutput
        ? Math.max(1, maxContextTokens - (maxOutputTokens ?? 0))
        : maxContextTokens;

    return {
        maxContextTokens,
        maxInputTokens,
        ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
        contextWindowIncludesOutput,
        source,
        outputTokenSource,
        configMaxContextTokens: config.maxContextTokens,
        modelId,
        modelContextWindow: modelInfo?.contextWindow
    };
}

/** 返回当前实际选择模型声明的窗口；未能识别模型时不把渠道显示上限伪装成模型硬边界。 */
export function resolveModelContextWindowForConfig(
    config: BaseChannelConfig,
    modelOverride?: string
): MaxContextResolution | undefined {
    const candidateModelId = resolveCandidateModelId(config, modelOverride);
    if (!candidateModelId) return undefined;
    const modelInfo = resolveModelInfo(config, modelOverride);
    const modelContextWindow = normalizePositiveTokenValue(modelInfo?.contextWindow);
    if (modelContextWindow === undefined) return undefined;
    return buildResolution(config, modelContextWindow, 'model.contextWindow', modelInfo, candidateModelId);
}

/** 解析上下文管理的窗口与输入预算：显式渠道上限优先，模型窗口和默认值依次回退。 */
export function resolveMaxContextTokensForConfig(
    config: BaseChannelConfig,
    modelOverride?: string
): MaxContextResolution {
    const configuredMax = normalizePositiveTokenValue(config.maxContextTokens);
    const candidateModelId = resolveCandidateModelId(config, modelOverride);
    const modelInfo = resolveModelInfo(config, modelOverride);
    if (configuredMax !== undefined) {
        return buildResolution(config, configuredMax, 'config.maxContextTokens', modelInfo, candidateModelId || undefined);
    }

    const modelWindow = resolveModelContextWindowForConfig(config, modelOverride);
    if (modelWindow) return modelWindow;

    return buildResolution(config, DEFAULT_MAX_CONTEXT_TOKENS, 'default', modelInfo, candidateModelId || undefined);
}

/** 仅解析当前渠道/模型可用的最大输出预留，供需要单独展示预算的调用方使用。 */
export function resolveMaxOutputTokensForConfig(
    config: BaseChannelConfig,
    modelOverride?: string
): number | undefined {
    return resolveMaxContextTokensForConfig(config, modelOverride).maxOutputTokens;
}
