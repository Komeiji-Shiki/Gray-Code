import { t } from '../../i18n';
import type { ChannelConfig, ValidationResult, GeminiConfig, OpenAIConfig, AnthropicConfig } from './types';
import type { OpenAIResponsesConfig } from './configs';

export async function validateConfig(config: ChannelConfig): Promise<ValidationResult> {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (config.autoSummarizeMethod !== undefined && !['summary', 'notes'].includes(config.autoSummarizeMethod)) {
        errors.push('自动总结方式必须是普通总结或笔记管理。');
    }

    // 基础字段验证
    // 非字符串 name（webview/导入来源）直接调用 .trim() 会抛 TypeError，先做类型校验
    if (typeof config.name !== 'string' || config.name.trim().length === 0) {
        errors.push(t('modules.config.validation.nameRequired'));
    }

    if (!config.type) {
        errors.push(t('modules.config.validation.typeRequired'));
    }

    // 重试与超时参数校验：配置来源可能绕过 TS 类型（webview/导入），非法值会令
    // ChannelManager 的 totalAttempts 为 NaN/负数（零次尝试并误报网络错误）或
    // setTimeout 立即/负值触发（请求秒超时）。此处只报错不修改，消费端另有钳制兜底。
    const retryLike = config as { retryCount?: unknown; retryInterval?: unknown; timeout?: unknown };
    if (
        retryLike.retryCount !== undefined &&
        (typeof retryLike.retryCount !== 'number' || !Number.isInteger(retryLike.retryCount) || retryLike.retryCount < 0)
    ) {
        errors.push(t('modules.config.validation.retryCountInvalid'));
    }
    if (
        retryLike.retryInterval !== undefined &&
        (typeof retryLike.retryInterval !== 'number' || !Number.isFinite(retryLike.retryInterval) || retryLike.retryInterval <= 0)
    ) {
        errors.push(t('modules.config.validation.retryIntervalInvalid'));
    }
    if (retryLike.timeout !== undefined && (typeof retryLike.timeout !== 'number' || !Number.isFinite(retryLike.timeout) || retryLike.timeout <= 0)) {
        errors.push(t('modules.config.validation.timeoutInvalid'));
    }

    // 根据类型进行特定验证
    switch (config.type) {
        case 'gemini':
            validateGeminiConfig(config as GeminiConfig, errors, warnings);
            break;

        case 'gemini-interactions':
            // 配置结构与 gemini 同构，复用同一套校验（URL/API Key/模型）
            validateGeminiConfig(config as unknown as GeminiConfig, errors, warnings);
            break;

        case 'openai':
            validateOpenAIConfig(config, errors, warnings);
            break;

        case 'openai-responses':
            validateOpenAIConfig(config, errors, warnings);
            break;

        case 'anthropic':
            validateAnthropicConfig(config as AnthropicConfig, errors, warnings);
            break;

        default:
            // 未知/非法 type：显式报错（此前无 default 分支时静默通过，非法 type 不被拦截）。
            // 注意：switch 穷尽 ChannelType 后此处 config 被收窄为 never，但运行时仍可能收到
            // webview/导入来源的非法 type，故通过断言访问原始 type 字符串。
            // type 为空时上方 typeRequired 已报错，这里避免重复
            const rawType = (config as { type?: string }).type;
            if (rawType) {
                errors.push(t('modules.config.validation.unsupportedType', { type: rawType }));
            }
            break;
    }

    return {
        valid: errors.length === 0,
        errors: errors.length > 0 ? errors : undefined,
        warnings: warnings.length > 0 ? warnings : undefined,
    };
}

function validateGeminiConfig(config: GeminiConfig, errors: string[], warnings: string[]): void {
    // URL 验证
    if (!config.url || !isValidUrl(config.url)) {
        errors.push(t('modules.config.validation.invalidUrl'));
    }

    // API Key 验证 - 仅警告，不阻止创建
    if (!config.apiKey || config.apiKey.trim().length === 0) {
        warnings.push(t('modules.config.validation.apiKeyEmpty'));
    }

    // 模型名称验证（允许为空，表示未选择模型）
    // 仅当有模型列表时，才检查是否选择了模型
    const models = (config as any).models || [];
    if (models.length > 0 && (!config.model || config.model.trim().length === 0)) {
        warnings.push(t('modules.config.validation.modelNotSelected'));
    }

    // 选项验证
    if (config.options) {
        const opts = config.options;

        // 温度参数
        if (opts.temperature !== undefined) {
            if (opts.temperature < 0 || opts.temperature > 2) {
                errors.push(t('modules.config.validation.temperatureRange'));
            }
        }

        // 最大输出 token
        if (opts.maxOutputTokens !== undefined) {
            if (opts.maxOutputTokens < 1) {
                errors.push(t('modules.config.validation.maxOutputTokensMin'));
            }

            // 警告：过大的 token 数
            if (opts.maxOutputTokens > 8192) {
                warnings.push(t('modules.config.validation.maxOutputTokensHigh'));
            }
        }
    }
}

function validateOpenAIConfig(config: OpenAIConfig | OpenAIResponsesConfig, errors: string[], warnings: string[]): void {
    // URL 验证
    if (!config.url || !isValidUrl(config.url)) {
        errors.push(t('modules.config.validation.invalidUrl'));
    }

    // API Key 验证
    if (!config.apiKey || config.apiKey.trim().length === 0) {
        warnings.push(t('modules.config.validation.apiKeyEmpty'));
    }

    // 模型名称验证
    const models = config.models || [];
    if (models.length > 0 && (!config.model || config.model.trim().length === 0)) {
        warnings.push(t('modules.config.validation.modelNotSelected'));
    }
}

function validateAnthropicConfig(config: AnthropicConfig, errors: string[], warnings: string[]): void {
    // URL 验证
    if (!config.url || !isValidUrl(config.url)) {
        errors.push(t('modules.config.validation.invalidUrl'));
    }

    // API Key 验证 - 仅警告，不阻止创建
    if (!config.apiKey || config.apiKey.trim().length === 0) {
        warnings.push(t('modules.config.validation.apiKeyEmpty'));
    }

    // 模型名称验证
    const models = config.models || [];
    if (models.length > 0 && (!config.model || config.model.trim().length === 0)) {
        warnings.push(t('modules.config.validation.modelNotSelected'));
    }

    // 选项验证
    const opts = config.options;
    if (opts) {
        // Anthropic 的 temperature 范围是 0.0 - 1.0
        if (opts.temperature !== undefined && (opts.temperature < 0 || opts.temperature > 1)) {
            errors.push(t('modules.config.validation.temperatureRangeAnthropic'));
        }

        if (opts.max_tokens !== undefined && opts.max_tokens < 1) {
            errors.push(t('modules.config.validation.maxTokensMin'));
        }

        if (opts.top_p !== undefined && (opts.top_p < 0 || opts.top_p > 1)) {
            errors.push(t('modules.config.validation.topPRange'));
        }

        if (opts.top_k !== undefined && opts.top_k < 0) {
            errors.push(t('modules.config.validation.topKMin'));
        }

        // 思考预算：Anthropic 要求 budget_tokens 至少为 1024
        if (opts.thinking?.type === 'enabled' && opts.thinking.budget_tokens !== undefined && opts.thinking.budget_tokens < 1024) {
            warnings.push(t('modules.config.validation.thinkingBudgetMin'));
        }
    }
}

function isValidUrl(url: string): boolean {
    try {
        new URL(url);
        return true;
    } catch {
        return false;
    }
}
