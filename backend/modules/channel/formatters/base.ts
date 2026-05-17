/**
 * LimCode - 格式转换器基类
 * 
 * 定义格式转换器的抽象接口
 */

import type { Content } from '../../conversation/types';
import type { ChannelConfig } from '../../config/types';
import type { ToolDeclaration } from '../../../tools/types';
import type {
    GenerateRequest,
    GenerateResponse,
    StreamChunk,
    HttpRequestOptions
} from '../types';
import type { RequestPromptContext } from '../types';
import { deserializePromptContextCache } from '../../prompt/promptContextCache';

/**
 * 格式转换器基类
 * 
 * 所有格式转换器都必须继承此类并实现抽象方法
 */
export abstract class BaseFormatter {
    /**
     * 构建 HTTP 请求
     *
     * 将统一的 GenerateRequest 转换为特定 API 的请求格式
     *
     * @param request 生成请求
     * @param config 渠道配置
     * @param tools 工具声明列表（可选）
     * @returns HTTP 请求选项
     */
    abstract buildRequest(
        request: GenerateRequest,
        config: ChannelConfig,
        tools?: ToolDeclaration[]
    ): HttpRequestOptions;
    
    /**
     * 解析响应
     * 
     * 将 API 响应转换为统一的 GenerateResponse 格式
     * 
     * @param response 原始响应
     * @returns 标准化的响应
     */
    abstract parseResponse(response: any): GenerateResponse;
    
    /**
     * 解析流式响应块
     * 
     * 将流式响应块转换为 StreamChunk 格式
     * 
     * @param chunk 原始响应块
     * @returns 标准化的流式响应块
     */
    abstract parseStreamChunk(chunk: any): StreamChunk;
    
    /**
     * 验证配置
     * 
     * 检查配置是否适用于此格式转换器
     * 
     * @param config 渠道配置
     * @returns 是否有效
     */
    abstract validateConfig(config: ChannelConfig): boolean;
    
    /**
     * 获取支持的配置类型
     *
     * @returns 配置类型
     */
    abstract getSupportedType(): string;
    
    /**
     * 转换工具声明
     *
     * 将统一的工具声明格式转换为特定 API 的工具格式
     *
     * @param tools 工具声明数组
     * @returns 转换后的工具格式
     */
    abstract convertTools(tools: ToolDeclaration[]): any;
    
    /**
     * 查找动态提示词插入点的索引
     *
     * 查找连续的最后一组带有 isUserInput 标记的消息
     * 返回这组消息的第一条索引，动态提示词会被插入到该消息之前
     *
     * @param history 处理后的历史消息
     * @returns 插入点索引，找不到返回 -1
     */
    protected findLastUserMessageGroupIndex(history: Content[]): number {
        let firstIndex = -1;
        let foundMarkedMessage = false;
        
        // 从后向前查找
        for (let i = history.length - 1; i >= 0; i--) {
            if (history[i].isUserInput) {
                // 找到用户输入消息，记录索引，继续向前查找连续的用户输入消息
                firstIndex = i;
                foundMarkedMessage = true;
            } else if (foundMarkedMessage) {
                // 已找到用户输入消息，但当前消息不是，说明连续组结束
                break;
            }
            // 如果还没找到用户输入消息，继续向前查找
        }
        
        return firstIndex;
    }

    /**
     * 查找当前回合的动态上下文稳定插入点。
     *
     * turnDynamicContext 是 ToolIterationLoopService 在新用户回合开始时写到该回合用户消息上的缓存。
     * 同一用户回合内，后续模型继续、工具结果、隐藏 functionResponse 都不应改变动态上下文位置，
     * 所以只要历史里还能找到这个缓存锚点，就必须插回该消息前，而不是重新按历史尾部计算。
     *
     * 如果当前最新用户输入还没有缓存（旧历史或测试构造），则退回到最后一组用户输入消息，
     * 避免把上一回合的缓存误判成本回合锚点。
     */
    private findCurrentTurnStartIndex(history: Content[]): number {
        const latestUserInputIndex = this.findLastUserMessageGroupIndex(history);
        for (let i = history.length - 1; i >= 0; i--) {
            const message = history[i];
            if (
                message.role === 'user' &&
                message.isUserInput &&
                !!message.turnDynamicContext
            ) {
                return latestUserInputIndex < 0 || i >= latestUserInputIndex ? i : latestUserInputIndex;
            }
        }

        return latestUserInputIndex;
    }

    private findUserMessageGroupEndExclusiveIndex(history: Content[], startIndex: number): number {
        if (startIndex < 0 || startIndex >= history.length) {
            return -1;
        }

        let endIndex = startIndex + 1;
        while (
            endIndex < history.length &&
            history[endIndex].role === 'user' &&
            history[endIndex].isUserInput
        ) {
            endIndex++;
        }

        return endIndex;
    }
    
    /**
     * 清理历史消息中的内部字段
     *
     * 移除不应该发送给 API 的内部标记字段（如 isUserInput）
     *
     * @param history 历史消息
     * @returns 清理后的历史消息
     */
    protected cleanInternalFields(history: Content[]): Content[] {
        return history.map(content => {
            const { isUserInput, turnDynamicContext, turnDynamicContextStrategy, ...rest } = content;
            return rest;
        });
    }

    /**
     * 从 turnDynamicContext 缓存构建历史 preserve 动态快照消息。
     *
     * 新缓存是 JSON；旧历史纯文本会在反序列化时按一条 user 消息兼容。
     */
    protected createDynamicContextMessagesFromCache(cache: string): Content[] {
        return deserializePromptContextCache(cache).dynamicSnapshotMessages;
    }

    /**
     * 从 GenerateRequest 里取结构化 prompt context。
     *
     * 旧调用路径只传 dynamicContextMessages 时，自动包装成 legacy 插入方式。
     */
    protected getPromptContextForRequest(request: GenerateRequest): RequestPromptContext | undefined {
        if (request.promptContext) {
            return request.promptContext;
        }
        if (!request.dynamicContextMessages) {
            return undefined;
        }
        return {
            beforeHistoryMessages: request.dynamicContextMessages,
            afterHistoryMessages: [],
            historyPlacement: 'legacy'
        };
    }

    /**
     * 按策略插入 prompt context。
     *
     * single：保持旧行为，只在最后一组用户主动消息前插入当前动态上下文。
     * preserve：先把历史里已标记 preserve 的 turnDynamicContext 插回对应 user 消息前，
     * 再把当前动态上下文插到当前回合位置；旧动态上下文不移动、不改写。
     */
    protected injectDynamicContextMessages(
        history: Content[],
        dynamicContextMessages?: Content[],
        strategy: 'single' | 'preserve' = 'single'
    ): Content[] {
        return this.injectPromptContextMessages(
            history,
            dynamicContextMessages
                ? {
                    beforeHistoryMessages: dynamicContextMessages,
                    afterHistoryMessages: [],
                    historyPlacement: 'legacy'
                }
                : undefined,
            strategy
        );
    }

    protected injectPromptContextMessages(
        history: Content[],
        promptContext?: RequestPromptContext,
        strategy: 'single' | 'preserve' = 'single'
    ): Content[] {
        const context = promptContext ?? { beforeHistoryMessages: [], afterHistoryMessages: [], historyPlacement: 'legacy' as const };
        const preservedHistory = strategy === 'preserve'
            ? this.injectPreservedDynamicSnapshots(history)
            : history;

        if (context.historyPlacement === 'entry') {
            const currentTurnStartIndex = this.findCurrentTurnStartIndex(preservedHistory);

            if (currentTurnStartIndex >= 0) {
                return [
                    ...context.beforeHistoryMessages,
                    ...preservedHistory.slice(0, currentTurnStartIndex),
                    ...context.afterHistoryMessages,
                    ...preservedHistory.slice(currentTurnStartIndex)
                ];
            }

            return [
                ...context.beforeHistoryMessages,
                ...preservedHistory,
                ...context.afterHistoryMessages
            ];
        }

        const legacyMessages = [
            ...context.beforeHistoryMessages,
            ...context.afterHistoryMessages
        ];
        return this.injectCurrentDynamicContext(preservedHistory, legacyMessages);
    }

    private injectPreservedDynamicSnapshots(history: Content[]): Content[] {
        const result: Content[] = [];
        const currentTurnStartIndex = this.findCurrentTurnStartIndex(history);
        for (let i = 0; i < history.length; i++) {
            const message = history[i];

            const isHistoricalPreservedTurn =
                currentTurnStartIndex >= 0 &&
                i !== currentTurnStartIndex &&
                message.role === 'user' &&
                message.isUserInput &&
                !!message.turnDynamicContext;

            if (isHistoricalPreservedTurn) {
                result.push(...this.createDynamicContextMessagesFromCache(message.turnDynamicContext!));
            }
            result.push(message);
        }

        return result;
    }

    /**
     * 保持原有单份动态上下文插入逻辑。
     */
    private injectCurrentDynamicContext(history: Content[], dynamicContextMessages?: Content[]): Content[] {
        if (!dynamicContextMessages || dynamicContextMessages.length === 0) {
            return history;
        }

        const insertIndex = this.findCurrentTurnStartIndex(history);

        if (insertIndex >= 0) {
            return [
                ...history.slice(0, insertIndex),
                ...dynamicContextMessages,
                ...history.slice(insertIndex)
            ];
        }

        // 找不到用户主动消息（如自动总结后），插入到历史最前面（总结消息之前）
        return [...dynamicContextMessages, ...history];
    }
}

/**
 * 递归给 JSON Schema 中所有 object 类型注入 additionalProperties: false。
 *
 * strict tool use（Anthropic / OpenAI）要求每个 object 都显式声明
 * additionalProperties: false，否则 API 返回 400。
 *
 * Lim-code 的工具 schema 是手写的，大部分没有此字段，
 * 所以在 formatter 层面统一注入，避免逐个修改工具文件。
 */
export function ensureStrictSchema<T extends Record<string, any>>(schema: T): T {
    if (!schema || typeof schema !== 'object') {
        return schema;
    }

    const result: any = { ...schema };

    // 当前层是 object 类型时，注入 additionalProperties: false
    if (result.type === 'object' && result.properties) {
        if (result.additionalProperties === undefined) {
            result.additionalProperties = false;
        }
    }

    // 递归处理 properties 中的每个属性
    if (result.properties) {
        const newProps: Record<string, any> = {};
        for (const [key, prop] of Object.entries(result.properties)) {
            newProps[key] = ensureStrictSchema(prop as Record<string, any>);
        }
        result.properties = newProps;
    }

    // 递归处理 items（array 类型的元素定义）
    if (result.items && typeof result.items === 'object') {
        result.items = ensureStrictSchema(result.items);
    }

    return result;
}