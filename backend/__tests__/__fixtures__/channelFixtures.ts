/**
 * 测试共享 fixture：渠道 formatter 测试的 config builder 系列
 * （createOpenAIConfig / createAnthropicConfig / createOpenAIResponsesConfig）。
 *
 * 这是测试共享 fixture，禁止在测试内复制。
 *
 * 收敛说明（createConfig 收敛批次）：
 * - createConfig(Partial<OpenAIConfig>) 原在 3 处重复定义（openaiDeepSeekUserId /
 *   openaiDynamicContextPreserve / effortCustom(OpenAI)），统一为 effortCustom 的形态
 *   （id/name/url/model/options 取该处默认）；其余调用点显式传回各自的 id/name/url/model：
 *   - openaiDeepSeekUserId：{ id:'openai-compatible-test', name:'OpenAI Compatible Test',
 *     url:'https://api.deepseek.com/v1', model:'deepseek-chat' }（DeepSeek 端点语义是断言前提）；
 *   - openaiDynamicContextPreserve：{ url:'https://example.test/v1', model:'test-model' }。
 * - createConfig(Partial<AnthropicConfig>) 原在 3 处重复定义（anthropicUserId / anthropicRoleMerge /
 *   effortCustom(Anthropic)），统一为 anthropicUserId 的形态；effortCustom 显式传 model/optionsEnabled/options，
 *   anthropicRoleMerge 显式传回 id/name。
 * - createConfig(Partial<OpenAIResponsesConfig>) 原在 2 处重复定义（openaiResponsesReasoning /
 *   effortCustom(Responses)），统一为 effortCustom 的形态；openaiResponsesReasoning 显式传回
 *   id/name/preferStream/sendHistoryThoughtSignatures/options（其 options 默认值被断言直接依赖）。
 * - 未收敛：api/openaiThoughtBackfill.test.ts 的 createConfig(type, sendHistoryThoughts,
 *   sendCurrentThoughts) 为唯一的位置参数形态（BaseChannelConfig + createdAt/updatedAt），保留本地。
 */
import type { AnthropicConfig } from '../../modules/config/configs/anthropic';
import type { OpenAIConfig } from '../../modules/config/configs/openai';
import type { OpenAIResponsesConfig } from '../../modules/config/configs/openai-responses';

/**
 * 构造最小 OpenAIConfig（effortCustom 形态：id 'openai-test' / url api.openai.com / model gpt-5 /
 * 默认 options.reasoning effort 'custom' + effortCustom 'max'）。
 * 差异点：DeepSeek/代理端点用例显式传 id/name/url/model；动态上下文用例显式传 url/model。
 */
export function createOpenAIConfig(overrides: Partial<OpenAIConfig> = {}): OpenAIConfig {
    return {
        id: 'openai-test',
        name: 'OpenAI Test',
        type: 'openai',
        enabled: true,
        url: 'https://api.openai.com/v1',
        apiKey: 'test-key',
        model: 'gpt-5',
        preferStream: false,
        timeout: 30000,
        toolMode: 'function_call',
        optionsEnabled: { reasoning: true },
        options: {
            reasoning: { effort: 'custom', effortCustom: 'max' }
        },
        ...overrides
    } as OpenAIConfig;
}

/**
 * 构造最小 AnthropicConfig（anthropicUserId 形态：model 'claude-sonnet-4-20250514'，
 * anthropicUserIdEnabled 默认 false）。
 * 差异点：effortCustom 用例显式传 model 'claude-opus-4-6' + optionsEnabled/options；
 * anthropicRoleMerge 用例显式传回 id/name。
 */
export function createAnthropicConfig(overrides: Partial<AnthropicConfig> = {}): AnthropicConfig {
    return {
        id: 'anthropic-test',
        name: 'Anthropic Test',
        type: 'anthropic',
        enabled: true,
        url: 'https://api.anthropic.com/v1',
        apiKey: 'test-key',
        model: 'claude-sonnet-4-20250514',
        preferStream: false,
        timeout: 30000,
        toolMode: 'function_call',
        anthropicUserIdEnabled: false,
        ...overrides
    } as AnthropicConfig;
}

/**
 * 构造最小 OpenAIResponsesConfig（effortCustom 形态：id 'openai-responses-test'，
 * 默认 options.reasoning effort 'custom' + effortCustom 'ultra'）。
 * 差异点：openaiResponsesReasoning 用例显式传回 id 'responses-test' / preferStream true /
 * sendHistoryThoughtSignatures true / options（含 stream + reasoning 'medium'）。
 */
export function createOpenAIResponsesConfig(overrides: Partial<OpenAIResponsesConfig> = {}): OpenAIResponsesConfig {
    return {
        id: 'openai-responses-test',
        name: 'OpenAI Responses Test',
        type: 'openai-responses',
        enabled: true,
        url: 'https://api.openai.com/v1',
        apiKey: 'test-key',
        model: 'gpt-5',
        preferStream: false,
        timeout: 30000,
        toolMode: 'function_call',
        optionsEnabled: { reasoning: true },
        options: {
            reasoning: { effort: 'custom', effortCustom: 'ultra' }
        },
        ...overrides
    } as OpenAIResponsesConfig;
}
