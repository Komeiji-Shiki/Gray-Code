/**
 * GrayCode - Anthropic 格式转换器
 *
 * 将统一格式转换为 Anthropic Claude API 格式
 *
 * ## Anthropic API 特点
 *
 * 1. 认证：使用 x-api-key 头部
 * 2. 版本：需要 anthropic-version 头部
 * 3. 消息格式：content 是数组，每项有 type 字段
 * 4. 多模态：{"type": "image", "source": {"type": "base64", "media_type": "...", "data": "..."}}
 * 5. 工具调用：使用 tool_use 和 tool_result
 *
 * ## 工具调用处理流程
 *
 * ### Function Call 模式
 * - AI 返回 content 中包含 type: "tool_use"
 * - functionResponse 使用 type: "tool_result"
 *
 * ### XML/JSON 模式
 * - 与 OpenAI 类似，工具转换为提示词
 */

import { createHash } from 'crypto';
import { BaseFormatter, ensureStrictSchema } from './base';
import type { AnthropicConfig } from '../../config/types';
import type { ToolDeclaration } from '../../../tools/types';
import { convertToolsToXML } from '../../../tools/xmlFormatter';
import { convertToolsToJSON } from '../../../tools/jsonFormatter';
import { applyCustomBody, resolveConfiguredStream } from '../../config/configs/base';
import { convertThoughtSignatures, convertToAnthropicMessages } from './anthropic/messages';
import { parseAnthropicResponse, parseAnthropicStreamChunk } from './anthropic/responses';
import type {
    GenerateRequest,
    GenerateResponse,
    StreamChunk,
    HttpRequestOptions
} from '../types';

const ANTHROPIC_USER_ID_PREFIX = 'graycode-conversation-';

/**
 * Anthropic 格式转换器
 *
 * 支持 Anthropic Claude API 的完整功能：
 * - 文本内容
 * - 多模态（图片）
 * - 工具调用（tool_use/tool_result）
 * - Token 统计
 * - 流式和非流式输出
 */
export class AnthropicFormatter extends BaseFormatter {
    /**
     * 构建 Anthropic API 请求
     */
    buildRequest(
        request: GenerateRequest,
        config: AnthropicConfig,
        tools?: ToolDeclaration[]
    ): HttpRequestOptions {
        const { history } = request;
        const toolMode = (config as any).toolMode || 'function_call';
        
        // 处理系统指令
        let systemInstruction = (config as any).systemInstruction || '';
        
        // 追加静态系统提示词（操作系统、时区、语言、工作区路径 - 可被 API provider 缓存）
        if (request.dynamicSystemPrompt) {
            systemInstruction = systemInstruction
                ? `${systemInstruction}\n\n${request.dynamicSystemPrompt}`
                : request.dynamicSystemPrompt;
        }
        
        // 处理工具描述 - 替换占位符或追加到系统提示词
        // 准备工具定义内容
        let toolsContent = '';
        let mcpToolsContent = '';
        
        if (tools && tools.length > 0) {
            if (toolMode === 'xml') {
                // XML 模式：工具转换为 XML
                toolsContent = convertToolsToXML(tools);
            } else if (toolMode === 'json') {
                // JSON 模式：工具转换为 JSON
                toolsContent = convertToolsToJSON(tools);
            }
        }
        
        // MCP 工具由外部传入
        if (request.mcpToolsContent) {
            mcpToolsContent = request.mcpToolsContent;
        }
        
        // 替换占位符（如果存在）
        if (systemInstruction.includes('{{$TOOLS}}') || systemInstruction.includes('{{$MCP_TOOLS}}')) {
            // 替换 TOOLS 占位符
            systemInstruction = systemInstruction.replace(/\{\{\$TOOLS\}\}/g, toolsContent);
            // 替换 MCP_TOOLS 占位符
            systemInstruction = systemInstruction.replace(/\{\{\$MCP_TOOLS\}\}/g, mcpToolsContent);
        } else if (toolsContent) {
            // 如果没有占位符但有工具内容，追加到末尾
            systemInstruction = systemInstruction
                ? `${systemInstruction}\n\n${toolsContent}`
                : toolsContent;
        }
        
        // 转换思考签名格式
        let processedHistory = convertThoughtSignatures(history);
        processedHistory = this.injectPromptContextMessages(
            processedHistory,
            this.getPromptContextForRequest(request),
            request.dynamicContextStrategy,
            { stripPreservedThoughtParts: config.sendHistoryThoughts !== true }
        );
        
        // 清理内部字段（如 isUserInput），这些字段不应该发送给 API
        // Anthropic 不接受中途的 system 消息，保留预设指定的位置并转换为 user。
        // 这里保留 isUserInput：紧随其后的 convertToAnthropicMessages 在合并相邻同角色
        // 消息时要用它判断真实用户输入的边界，插入 [User Input] 标识；该标记不会进入
        // 请求体（messages 由 parts 重建）。
        processedHistory = this.cleanInternalFieldsKeepingUserInput(processedHistory).map(message =>
            message.role === 'system' ? { ...message, role: 'user' as const } : message
        );
        
        // 转换历史消息为 Anthropic 格式
        const messages = convertToAnthropicMessages(processedHistory, toolMode);
        
        // 构建请求体
        const body: any = {
            model: config.model,
            messages: messages
        };
        
        // 添加系统指令（Anthropic 使用独立的 system 字段）
        if (systemInstruction) {
            body.system = systemInstruction;
        }
        
        // 添加工具（Function Call 模式）
        // strictToolsEnabled: 启用后，标记了 strict: true 的工具会带上 strict 字段
        
        const strictEnabled = !!(config as any).strictToolsEnabled;
        if (tools && tools.length > 0 && toolMode === 'function_call') {
            body.tools = this.convertTools(tools, strictEnabled);
        }
        
        // 添加生成配置
        const genConfig = this.buildGenerationConfig(config);
        Object.assign(body, genConfig);
        
        // 决定是否使用流式（始终发送 stream 字段）
        const useStream = resolveConfiguredStream(config);
        body.stream = useStream;
        
        // 构建 URL
        const baseUrl = config.url.endsWith('/')
            ? config.url.slice(0, -1)
            : config.url;
        
        const url = `${baseUrl}/messages`;
        
        // 构建请求头
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            'anthropic-version': '2023-06-01'
        };

        // 如果启用了 strict tool use，注入 structured-outputs beta header
        // Anthropic strict 模式必要的 beta header
        // 此 header 是 Anthropic strict 模式的必要条件
        if (strictEnabled && body.tools?.some((t: any) => t.strict === true)) {
            const existingBeta = headers['anthropic-beta'];
            const strictBeta = 'structured-outputs-2025-12-15';
            headers['anthropic-beta'] = existingBeta
                ? `${existingBeta},${strictBeta}`
                : strictBeta;
        }
        
        // 只有当 apiKey 存在时才添加认证头
        if (config.apiKey) {
            if ((config as any).useAuthorizationHeader) {
                // 使用 Authorization Bearer 格式
                headers['Authorization'] = `Bearer ${config.apiKey}`;
            } else {
                // 使用原生 x-api-key 格式
                headers['x-api-key'] = config.apiKey;
            }
        }
        
        // 应用自定义标头（如果启用）
        if ((config as any).customHeadersEnabled && (config as any).customHeaders) {
            for (const header of (config as any).customHeaders) {
                // 只添加启用的、有键名的标头
                if (header.enabled && header.key && header.key.trim()) {
                    headers[header.key.trim()] = header.value || '';
                }
            }
        }
        
        // 修改原因：并行 SubAgent 与主会话共用同一 API Key 时，provider/网关侧需要区分不同运行域的请求。
        // 修改方式：启用 anthropicUserIdEnabled 且请求携带 conversationId（SubAgent 传 runId）时，
        //          注入 Anthropic 官方 metadata.user_id 字段（sha256 哈希，不泄露原始 ID）。
        // 修改目的：与 OpenAI 渠道的 DeepSeek user_id 机制对齐，主会话与各 SubAgent 的缓存/风控域互不混淆。
        const anthropicUserId = this.buildAnthropicUserId(request, config);
        if (anthropicUserId) {
            body.metadata = { ...(body.metadata || {}), user_id: anthropicUserId };
        }

        // 如果启用了 Prompt Caching，注入手动缓存断点
        // 缓存层级顺序：tools -> system -> messages
        // 在每个层级的最后一个内容块上添加 cache_control 标记
        // 支持 5 分钟（默认）或 1 小时 TTL
        if ((config as any).promptCachingEnabled) {
            const ttl = (config as any).promptCachingTtl || '5m';
            this.injectCacheBreakpoints(body, ttl);
        }
        
        // 应用自定义 body（如果启用）
        const finalBody = applyCustomBody(body, (config as any).customBody, (config as any).customBodyEnabled);
        
        // 构建请求选项
        return {
            url,
            method: 'POST',
            headers,
            body: finalBody,
            timeout: config.timeout,
            stream: useStream
        };
    }
    
    /**
     * Anthropic Messages API 支持 metadata.user_id 官方字段。
     *
     * 只有渠道启用 anthropicUserIdEnabled 且调用方传入 conversationId 时才生成。
     * 主聊天请求传真实对话 ID，SubAgent 传 runId，各运行域彼此区分。
     *
     * 续跑（continueFromRunId）时 executor 会把 conversationId 直接沿用旧 runId，
     * 因此 user_id 哈希输入与旧 run 一致，运行域天然相同，无需额外字段。
     *
     * user_id 使用 ID 的 sha256 哈希，稳定且不包含原始对话信息。
     */
    private buildAnthropicUserId(request: GenerateRequest, config: AnthropicConfig): string | undefined {
        if (!(config as any).anthropicUserIdEnabled) {
            return undefined;
        }

        const domainId = request.conversationId?.trim();
        if (!domainId) {
            return undefined;
        }

        const digest = createHash('sha256')
            .update(domainId, 'utf8')
            .digest('hex');

        return `${ANTHROPIC_USER_ID_PREFIX}${digest}`;
    }
    
    /**
     * 构建生成配置
     */
    private buildGenerationConfig(config: AnthropicConfig): any {
        const genConfig: any = {};
        const optionsEnabled = (config as any).optionsEnabled || {};
        
        // max_tokens: Anthropic API 强制要求该字段，无条件发送（未显式配置时用 65535 兜底）
        genConfig.max_tokens = config.options?.max_tokens ?? 65535;
        
        if (optionsEnabled.temperature && config.options?.temperature !== undefined) {
            genConfig.temperature = config.options.temperature;
        }
        
        if (optionsEnabled.top_p && config.options?.top_p !== undefined) {
            genConfig.top_p = config.options.top_p;
        }
        
        if (optionsEnabled.top_k && config.options?.top_k !== undefined) {
            genConfig.top_k = config.options.top_k;
        }
        
        if (config.options?.stop_sequences && config.options.stop_sequences.length > 0) {
            genConfig.stop_sequences = config.options.stop_sequences;
        }
        
        // 添加 thinking 配置（如果启用）
        const thinkingEnabled = optionsEnabled.thinking;
        const thinking = config.options?.thinking;
        
        if (thinkingEnabled && thinking) {
            const thinkingType = thinking.type || 'enabled';
            const thinkingDisplay = thinking.display;  // 'omitted' | 'summarized' | undefined
            
            if (thinkingType === 'adaptive') {
                // 自适应思考模式（Opus 4.6+）
                genConfig.thinking = {
                    type: 'adaptive'
                };
                
                // 思考内容显示模式（Opus 4.7+ 默认 omitted）
                if (thinkingDisplay) {
                    genConfig.thinking.display = thinkingDisplay;
                }
                
                // effort 通过 output_config 发送
                let effort: string | undefined = thinking.effort;
                // 自定义模式：使用 effortCustom 的值原样透传
                if (effort === 'custom') {
                    effort = thinking.effortCustom?.trim() || undefined;
                }
                if (effort) {
                    genConfig.output_config = {
                        effort
                    };
                }
            } else if (thinkingType === 'enabled') {
                // 传统手动思考模式
                const thinkingConfig: any = {
                    type: 'enabled'
                };
                
                // 思考内容显示模式
                if (thinkingDisplay) {
                    thinkingConfig.display = thinkingDisplay;
                }
                
                // 思考预算（budget_tokens）
                if (thinking.budget_tokens && thinking.budget_tokens > 0) {
                    thinkingConfig.budget_tokens = thinking.budget_tokens;
                } else {
                    // 默认预算
                    thinkingConfig.budget_tokens = 10000;
                }
                
                genConfig.thinking = thinkingConfig;
            }
        }
        
        return genConfig;
    }

    /**
     * 注入手动缓存断点
     *
     * 根据 Anthropic Prompt Caching 的缓存前缀层级（tools -> system -> messages），
     * 在各层级的最后一个可缓存内容块上添加 cache_control 标记。
     *
     * 最多使用 4 个缓存断点（Anthropic 限制），当前策略使用最多 3 个：
     * 1. tools 数组的最后一个工具
     * 2. system 内容（转为数组格式后的最后一个块）
     * 3. messages 中最后一条 user 消息的最后一个 content block
     *
     * @param body - 请求体
     * @param ttl - 缓存 TTL：'5m'（默认，1.25x 写入价格）或 '1h'（2x 写入价格）
     */
    private injectCacheBreakpoints(body: any, ttl: string = '5m'): void {
        const cacheControl: any = { type: 'ephemeral' as const };
        if (ttl === '1h') {
            cacheControl.ttl = '1h';
        }

        // 1. 在 tools 的最后一个工具上添加缓存断点
        if (body.tools && Array.isArray(body.tools) && body.tools.length > 0) {
            body.tools[body.tools.length - 1].cache_control = cacheControl;
        }

        // 2. 将 system 从字符串转为内容块数组格式，并在最后一个块上添加缓存断点
        // Anthropic 支持 system 为字符串或内容块数组，使用数组格式才能添加 cache_control
        if (body.system && typeof body.system === 'string') {
            body.system = [
                {
                    type: 'text',
                    text: body.system,
                    cache_control: cacheControl
                }
            ];
        } else if (Array.isArray(body.system) && body.system.length > 0) {
            body.system[body.system.length - 1].cache_control = cacheControl;
        }

        // 3. 在 messages 中最后一条 user 消息的最后一个 content block 上添加缓存断点
        // 这样可以缓存大部分历史消息前缀
        if (body.messages && Array.isArray(body.messages) && body.messages.length > 0) {
            // 从后向前找最后一条 user 消息
            for (let i = body.messages.length - 1; i >= 0; i--) {
                const msg = body.messages[i];
                if (msg.role === 'user' && Array.isArray(msg.content) && msg.content.length > 0) {
                    // 确保 content block 是对象格式（Anthropic 消息通常已经是对象数组）
                    const lastBlock = msg.content[msg.content.length - 1];
                    if (typeof lastBlock === 'object' && lastBlock !== null) {
                        lastBlock.cache_control = cacheControl;
                        break;
                    }
                }
            }
        }
    }

    parseResponse(response: any): GenerateResponse {
        return parseAnthropicResponse(response);
    }

    parseStreamChunk(chunk: any): StreamChunk {
        return parseAnthropicStreamChunk(chunk);
    }
    
    /**
     * 验证配置（不验证 API Key）
     */
    validateConfig(config: any): boolean {
        if (config.type !== 'anthropic') {
            return false;
        }
        
        const anthropicConfig = config as AnthropicConfig;
        
        // 检查必需字段（不验证 apiKey）
        if (!anthropicConfig.url || !anthropicConfig.model) {
            return false;
        }
        
        return true;
    }
    
    /**
     * 获取支持的配置类型
     */
    getSupportedType(): string {
        return 'anthropic';
    }
    
    /**
     * 转换工具声明为 Anthropic 格式
     *
     * Anthropic 格式：
     * [{
     *   "name": "...",
     *   "description": "...",
     *   "input_schema": {...}  // JSON Schema
     * }]
     */
    convertTools(tools: ToolDeclaration[], strictEnabled?: boolean): any {
        if (!tools || tools.length === 0) {
            return undefined;
        }
        
        // Anthropic strict 工具数量上限为 20（API 限制）
        
        const ANTHROPIC_STRICT_TOOL_LIMIT = 20;
        let strictCount = 0;

        return tools.map(tool => {
            // 判断此工具是否启用 strict
            let useStrict = false;
            if (strictEnabled && tool.strict === true) {
                if (strictCount < ANTHROPIC_STRICT_TOOL_LIMIT) {
                    useStrict = true;
                    strictCount++;
                } else {
                    // 超过 20 个 strict 工具，降级为非 strict，记录警告
                    console.warn(
                        `[Anthropic] strict tool limit (${ANTHROPIC_STRICT_TOOL_LIMIT}) exceeded, ` +
                        `tool "${tool.name}" downgraded to non-strict`
                    );
                }
            }

            const toolDef: any = {
                name: tool.name,
                description: tool.description,
                input_schema: useStrict
                    ? ensureStrictSchema(tool.parameters)
                    : tool.parameters
            };

            if (useStrict) {
                toolDef.strict = true;
            }

            return toolDef;
        });
    }
}
