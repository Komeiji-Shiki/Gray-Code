/**
 * API 历史格式化纯函数（拆分自 ConversationManager.ts 的 formatHistoryForAPI / toDisplayMessages）。
 *
 * 不依赖 this：输入历史数组 + GetHistoryOptions，输出格式化后的 ConversationHistory；
 * 由 getHistoryForAPI / getHistoryForAPIFrom 直接 import 使用。
 * 注意：本文件内容按原文件缩进保留（纯移动，不重排）。
 */

import { t } from '../../../i18n';
import type { Content, ContentPart, ConversationHistory } from '../types';
import type { GetHistoryOptions } from './types';
import { cleanFunctionResponseForAPI, ensureBackgroundTaskSourceForDisplay, isRealUserMessage } from '../helpers';

/** 把历史映射为返回给前端的显示消息：补绝对 index、过滤内部字段、深拷贝 */
export function toDisplayMessages(history: ConversationHistory): Content[] {
    return history.map((message, index) => {
        // 过滤后端内部字段（turnDynamicContext 数据量大且前端无需使用）
        const { turnDynamicContext, ...rest } = ensureBackgroundTaskSourceForDisplay(message);
        return { ...JSON.parse(JSON.stringify(rest)), index } as Content;
    });
}

/**
 * 获取适合 API 调用的对话历史（格式化实现）。
 *
 * 此函数返回格式化的历史记录，移除内部字段（如 token 计数）。
 *
 * 思考内容过滤策略：
 * - 默认情况下，只保留最后一个非函数响应 user 消息及之后的思考内容和签名
 * - 如果启用 sendHistoryThoughts，则保留所有历史思考内容
 * - 如果启用 sendHistoryThoughtSignatures，则保留所有历史思考签名（按渠道类型过滤）
 *
 * @param rawContents 原始历史内容
 * @param options 选项对象（向后兼容：如果传入 boolean，视为 includeThoughts）
 * @returns 格式化的对话历史，移除了 token 计数字段
 */
export function formatHistoryForAPI(
    rawContents: ReadonlyArray<Content>,
    options: GetHistoryOptions | boolean = false
): ConversationHistory {
    let history = rawContents as ConversationHistory;
    
    // 向后兼容：如果传入 boolean，视为 includeThoughts
    const opts: GetHistoryOptions = typeof options === 'boolean'
        ? { includeThoughts: options }
        : options;
    
    // 应用起始索引（用于上下文裁剪）
    // 注意：startIndex >= history.length 时必须返回空历史而不是完整历史，
    // slice 自动钳制超界索引（防御性修复，当前调用方已钳制）。
    const startIndex = opts.startIndex ?? 0;
    if (startIndex > 0) {
        history = history.slice(startIndex);
    }
    
    const includeThoughts = opts.includeThoughts ?? false;
    const sendHistoryThoughts = opts.sendHistoryThoughts ?? false;
    const sendHistoryThoughtSignatures = opts.sendHistoryThoughtSignatures ?? false;
    // 当前轮次配置：默认发送当前思考内容
    const sendCurrentThoughts = opts.sendCurrentThoughts ?? true;
    const sendCurrentThoughtSignatures = opts.sendCurrentThoughtSignatures ?? (opts.channelType === 'gemini' || opts.channelType === 'gemini-interactions' || opts.channelType === 'anthropic' || opts.channelType === 'openai-responses');
    const channelType = opts.channelType;
    // 历史思考回合数，默认 -1 表示全部
    const historyThinkingRounds = opts.historyThinkingRounds ?? -1;
    
    // redactedThinking 是 Anthropic 渠道专有字段（openai-responses 规范同样支持
    // redacted_thinking 回传）；其他渠道（gemini/openai/custom/未知）不识别该字段，
    // 原样透传会作为未知字段进入请求体（Anthropic 历史切到 Gemini 续聊可能 400）。
    // 按渠道白名单剥除：仅 anthropic / openai-responses 保留，其余一律剔除；
    // 剥空后的 part 由下方空 part 过滤兜底（keys.length === 0 → 丢弃）。
    const keepRedactedThinking = channelType === 'anthropic' || channelType === 'openai-responses';

    /**
     * 剔除 part 中的 redactedThinking 字段（非 anthropic/openai-responses 渠道）。
     *
     * redactedThinking 是 Anthropic 加密思考（redacted_thinking）的 Base64 存储形态，
     * 仅 Anthropic / openai-responses API 要求回传；Gemini / OpenAI 等渠道不认识该字段。
     */
    const cleanRedactedThinking = (part: ContentPart): ContentPart => {
        if (keepRedactedThinking || !part.redactedThinking) {
            return part;
        }
        const { redactedThinking, ...rest } = part;
        return rest;
    };
    
    // 找到最后一个真实 user 消息的索引（H1-1：与回合识别同谓词；总结与内部回流
    // 不构成真实用户边界）。该索引仅控制历史思考内容，不改写 agentInbox。
    let lastNonFunctionResponseUserIndex = -1;
    for (let i = history.length - 1; i >= 0; i--) {
        const message = history[i];
        if (isRealUserMessage(message)) {
            lastNonFunctionResponseUserIndex = i;
            break;
        }
    }
    
    // 识别所有回合并计算哪些回合需要发送历史思考
    // 回合定义：从一个真实 user 消息（排除 functionResponse / 总结消息，H1-1 与 MED-3 同谓词）
    // 开始，到下一个真实 user 消息之前结束
    const roundStartIndices: number[] = [];
    for (let i = 0; i < history.length; i++) {
        const message = history[i];
        if (isRealUserMessage(message)) {
            roundStartIndices.push(i);
        }
    }
    
    // 计算需要发送历史思考的消息索引范围
    // historyThinkingRounds 控制发送多少轮非最新回合的思考
    let historyThoughtMinIndex = 0;  // 最小索引（包含）
    let historyThoughtMaxIndex = lastNonFunctionResponseUserIndex;  // 最大索引（不包含，由 sendCurrentThoughts 控制）
    
    if (historyThinkingRounds === 0) {
        // 0 表示不发送任何历史回合的思考
        // 设置 min > max 使范围无效
        historyThoughtMinIndex = history.length;
        historyThoughtMaxIndex = -1;
    } else if (historyThinkingRounds > 0) {
        // 正数 n 表示发送最近 n 轮非最新回合的思考
        // 例如 historyThinkingRounds=1，总共有 5 个回合（索引 0-4），最新回合是 4
        // 那么只发送回合 3（倒数第二回合）的思考
        const totalRounds = roundStartIndices.length;
        
        if (totalRounds > 1) {
            // 需要跳过的回合数 = 总回合数 - 1（最新回合） - historyThinkingRounds
            const roundsToSkip = Math.max(0, totalRounds - 1 - historyThinkingRounds);
            
            if (roundsToSkip > 0 && roundsToSkip < totalRounds) {
                // 从 roundsToSkip 回合开始发送
                historyThoughtMinIndex = roundStartIndices[roundsToSkip];
            }
        }
    }
    // historyThinkingRounds === -1 时保持默认值，发送所有历史回合的思考
    
    /**
     * 处理单个 part 的思考签名
     * 根据配置决定是否保留签名，并按渠道类型过滤
     *
     * 注意：思考签名发送不依赖于 includeThoughts（渠道是否支持思考）
     * 这是因为历史中的签名可能来自任何渠道（如 Gemini），而当前使用其他渠道继续对话
     * 用户可能希望将 Gemini 产生的签名发送给其他渠道
     *
     * @param part 要处理的 part
     * @param isHistoryPart 是否是历史消息中的 part
     * @param messageIndex 消息在历史中的索引
     */
    const processThoughtSignatures = (
        part: ContentPart,
        isHistoryPart: boolean,
        messageIndex: number
    ): ContentPart => {
        // 1. 处理历史消息的签名
        if (isHistoryPart) {
            if (!sendHistoryThoughtSignatures) {
                const { thoughtSignatures, thoughtSignature, ...rest } = part as any;
                return rest;
            }
            // 检查是否在允许的历史思考回合范围内
            const isInHistoryThoughtRange = messageIndex >= historyThoughtMinIndex && messageIndex < historyThoughtMaxIndex;
            if (!isInHistoryThoughtRange) {
                const { thoughtSignatures, thoughtSignature, ...rest } = part as any;
                return rest;
            }
        } else {
            // 2. 处理当前轮次的签名
            // 当前轮次的签名发送由 sendCurrentThoughtSignatures 独立控制
            if (!sendCurrentThoughtSignatures) {
                const { thoughtSignatures, thoughtSignature, ...rest } = part as any;
                return rest;
            }
        }

        if (!part.thoughtSignatures) {
            return part;
        }
        
        // 3. 如果指定了渠道类型，只保留对应格式的签名
        if (channelType && part.thoughtSignatures[channelType]) {
            return {
                ...part,
                thoughtSignatures: {
                    [channelType]: part.thoughtSignatures[channelType]
                }
            };
        }
        
        // 如果没有指定渠道类型或没有对应格式的签名，保留原样
        return part;
    };
    
    /**
     * 支持的图片 MIME 类型
     */
    const IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
    
    /**
     * 支持的文档 MIME 类型
     */
    const DOCUMENT_MIME_TYPES = ['application/pdf', 'text/plain'];
    
    /**
     * 清理 inlineData 中的元数据字段
     *
     * 根据渠道类型决定保留哪些字段：
     * - Gemini: 保留 mimeType, data, displayName（Gemini API 支持 displayName）
     * - OpenAI/Anthropic: 只保留 mimeType, data（不支持 displayName）
     *
     * id 和 name 字段仅用于存储和前端显示，始终不发送给 AI
     *
     * 多模态能力过滤策略：
     * - 用户主动提交的附件不受多模态工具配置影响
     * - 对于工具响应消息：
     *   - 如果渠道不支持多模态（如 OpenAI function_call），始终过滤
     *   - 如果渠道支持但不支持历史多模态，只过滤历史中的多模态数据
     *   - 否则保留多模态数据
     *
     * @param part 要处理的 ContentPart
     * @param isFunctionResponse 是否是工具响应消息
     * @param isHistoryMessage 是否是历史消息（当前轮次之前的消息）
     */
    const cleanInlineData = (part: ContentPart, isFunctionResponse: boolean, isHistoryMessage: boolean): ContentPart | null => {
        if (!part.inlineData) {
            return part;
        }
        
        // 获取多模态能力配置
        const capability = opts.multimodalCapability;
        
        // 多模态能力过滤策略（仅对工具响应消息生效）：
        // 用户主动提交的附件不受多模态工具配置影响
        if (capability && isFunctionResponse) {
            const mimeType = part.inlineData.mimeType;
            
            // 首先检查渠道是否支持此类型的多模态
            // 如果不支持，即使是当前轮次也要过滤（如 OpenAI function_call 模式）
            const isImage = IMAGE_MIME_TYPES.includes(mimeType);
            const isDocument = DOCUMENT_MIME_TYPES.includes(mimeType);
            
            if (isImage && !capability.supportsImages) {
                // 渠道不支持图片（如 OpenAI function_call），始终过滤
                return null;
            }
            
            if (isDocument && !capability.supportsDocuments) {
                // 渠道不支持文档，始终过滤
                return null;
            }
            
            // 渠道支持此类型，但需要检查是否支持历史多模态
            // 如果是历史消息且不支持历史多模态，则过滤
            if (isHistoryMessage && !capability.supportsHistoryMultimodal) {
                return null;
            }
        }
        
        // 根据渠道类型决定是否保留 displayName
        // Gemini 支持 displayName，OpenAI/Anthropic 不支持
        if (channelType === 'gemini') {
            // Gemini: 保留 displayName，移除 id 和 name
            const { id, name, ...cleanedInlineData } = part.inlineData;
            return {
                ...part,
                inlineData: cleanedInlineData
            };
        } else {
            // OpenAI/Anthropic/Custom: 移除 id, name, displayName
            const { id, name, displayName, ...cleanedInlineData } = part.inlineData;
            return {
                ...part,
                inlineData: cleanedInlineData
            };
        }
    };
    
    // 首先收集所有被拒绝的工具调用 ID
    const rejectedToolCallIds = new Set<string>();
    for (const message of history) {
        for (const part of message.parts ?? []) {
            if (part.functionCall?.rejected && part.functionCall.id) {
                rejectedToolCallIds.add(part.functionCall.id);
            }
        }
    }

    // BR-08：不可随请求发送的 call id。
    // functionCall 必须在其所属消息的「紧随其后的连续 functionResponse 块」内
    // （或同一条消息内）存在配对响应，否则整体剔除：
    // - 中断/取消残留的孤儿调用（无任何响应，含 rejected 与未标记 rejected 两种）
    // - 迟到结算把响应追加到用户消息之后的错位形态（响应存在但不在块内）
    // 两种形态都会产生「assistant tool_calls 无配对 tool 消息」→ OpenAI/Anthropic 400。
    // 被剔除调用的配对 functionResponse 一并剔除（否则变成孤儿 tool 消息 400）。
    const droppedCallIds = new Set<string>();
    for (let i = 0; i < history.length; i++) {
        const message = history[i];
        const blockIds = new Set<string>();
        // 同一条消息内携带的 functionResponse（中断残留/修复数据的混合形态）
        for (const part of message.parts ?? []) {
            const id = part.functionResponse?.id;
            if (id) blockIds.add(id);
        }
        // 紧随其后的连续 functionResponse 消息块
        for (let j = i + 1; j < history.length && history[j]?.isFunctionResponse; j++) {
            for (const part of history[j].parts ?? []) {
                const id = part.functionResponse?.id;
                if (id) blockIds.add(id);
            }
        }
        for (const part of message.parts ?? []) {
            const callId = part.functionCall?.id;
            if (callId && !blockIds.has(callId)) {
                droppedCallIds.add(callId);
            }
        }
    }
    
    // 已见的 functionCall id 集合（BR-07 防御）：functionCall → functionResponse
    // 按 id 一一对应。functionCall 被截断/reroll 后，残留的孤儿 functionResponse
    // 在 Anthropic 渠道会引用不存在的 tool_use（400 错误），需要在下发前剔除。
    // 顺序遍历历史：先登记 functionCall id，再校验后续 functionResponse 是否匹配。
    const seenFunctionCallIds = new Set<string>();
    
    /**
     * 清理 functionCall 中的内部字段
     *
     * rejected 字段是内部使用的，用于标记用户拒绝执行的工具
     * 不应该发送给 AI API，因为 API 不识别此字段
     *
     * BR-08：无配对响应（或响应不在紧随 FR 块内）的调用整体丢弃该 part。
     * 否则剥离 rejected 后变成普通 tool_calls 但无 tool 消息 → 400。
     * 有配对响应（用户显式拒绝，占位响应已写入）的调用：保留，仅剥字段，
     * 由 processFunctionResponse 把响应改写为拒绝态，成对发送让 AI 感知拒绝。
     */
    const cleanFunctionCall = (part: ContentPart): ContentPart | null => {
        if (!part.functionCall) {
            return part;
        }
        
        if (part.functionCall.id && droppedCallIds.has(part.functionCall.id)) {
            return null;
        }
        
        // 移除 rejected 字段
        const { rejected, ...cleanedFunctionCall } = part.functionCall;
        return {
            ...part,
            functionCall: cleanedFunctionCall
        };
    };
    
    /**
     * 处理 functionResponse
     *
     * 如果对应的 functionCall 被标记为 rejected，
     * 需要将 response 修改为表示被拒绝的状态，
     * 这样 AI 才能知道工具没有被执行
     *
     * 同时清理不应发送给 AI 的内部字段（如 diffContentId）
     */
    const processFunctionResponse = (part: ContentPart, isHistoryMessage: boolean): ContentPart => {
        if (!part.functionResponse) {
            return part;
        }
        
        // 检查对应的 functionCall 是否被拒绝
        if (part.functionResponse.id && rejectedToolCallIds.has(part.functionResponse.id)) {
            // 修改 response 为表示被拒绝的状态
            return {
                ...part,
                functionResponse: {
                    ...part.functionResponse,
                    response: {
                        success: false,
                        error: t('modules.api.chat.errors.userRejectedTool'),
                        rejected: true
                    }
                }
            };
        }
        
        // 清理不应发送给 AI 的内部字段。agentInbox 已经作为工具结果历史发给模型后保持不变：
        // mailbox drain/claim 负责一次性消费，稳定历史字节负责 provider 前缀缓存命中。
        const cleanedResponse = cleanFunctionResponseForAPI(
            part.functionResponse.response as Record<string, unknown>,
            isHistoryMessage
        );
        
        return {
            ...part,
            functionResponse: {
                ...part.functionResponse,
                response: cleanedResponse as Record<string, unknown>
            }
        };
    };
    
    /**
     * 处理单条消息
     */
    const processMessage = (message: Content, index: number): Content | null => {
        const isHistoryMessage = index < lastNonFunctionResponseUserIndex;
        // 检查消息是否是工具响应（用于决定是否应用多模态能力过滤）
        const isFunctionResponse = !!message.isFunctionResponse;
        
        // 登记本消息中的 functionCall id（BR-07）：后续的 functionResponse 只有
        // 出现在该集合中才被保留，被截断/reroll 后残留的孤儿 functionResponse 将被过滤。
        for (const part of message.parts ?? []) {
            if (part.functionCall?.id) {
                seenFunctionCallIds.add(part.functionCall.id);
            }
        }
        
        let parts = message.parts ?? [];
        
        // 处理思考内容 (Thought Text/Reasoning Content)
        // 注意：思考发送不依赖于 includeThoughts（渠道是否支持思考）
        // 这是因为历史中的思考内容可能来自任何渠道（如 Gemini），而当前使用其他渠道继续对话
        // 用户可能希望将 Gemini 产生的思考内容发送给 OpenAI/Anthropic 渠道
        const hasResponsesReasoningMetadata = (part: ContentPart) => {
            if (!part.thought) return false;
            const metadata = part.openaiResponsesReasoning;
            return !!part.thoughtSignatures?.['openai-responses'] || !!(
                metadata && (
                    typeof metadata.id === 'string' ||
                    typeof metadata.status === 'string' ||
                    (Array.isArray(metadata.summary) && metadata.summary.length > 0) ||
                    (Array.isArray(metadata.content) && metadata.content.length > 0)
                )
            );
        };
        if (isHistoryMessage) {
            // 历史消息：根据 sendHistoryThoughts 配置和 historyThinkingRounds 决定
            if (!sendHistoryThoughts) {
                // 仅过滤掉纯思考内容；带签名或 Responses reasoning 元数据（可回传的
                // reasoning item）保留——它们不是普通 thought 文本，而是无状态多轮
                // 请求恢复推理上下文所需的协议数据（DeepSeek 等端点依赖）。
                parts = parts.filter(part => !part.thought || part.thoughtSignatures || hasResponsesReasoningMetadata(part));
            } else {
                // 检查当前消息是否在允许的历史思考回合范围内
                const isInHistoryThoughtRange = index >= historyThoughtMinIndex && index < historyThoughtMaxIndex;
                if (!isInHistoryThoughtRange) {
                    parts = parts.filter(part => !part.thought || hasResponsesReasoningMetadata(part));
                }
            }
        } else {
            // 当前轮次 (Latest Round)
            // 当前轮次的思考发送由 sendCurrentThoughts 独立控制
            if (!sendCurrentThoughts) {
                // 仅过滤掉纯思考内容；带签名或 Responses reasoning 元数据的 part 保留
                parts = parts.filter(part => !part.thought || part.thoughtSignatures || hasResponsesReasoningMetadata(part));
            }
        }
        
        // 处理思考签名、清理 inlineData 元数据、清理 functionCall 内部字段、处理被拒绝的工具响应
        // 注意：只有历史中的工具响应消息才会应用 supportsHistoryMultimodal 过滤
        // 当前轮次的工具响应始终保留多模态数据
        parts = parts
            .map(part => processThoughtSignatures(part, isHistoryMessage, index))
            .map(part => cleanRedactedThinking(part))
            .map(part => cleanInlineData(part, isFunctionResponse, isHistoryMessage))
            .map(part => part ? cleanFunctionCall(part) : part)
            .map(part => part ? processFunctionResponse(part, isHistoryMessage) : part)
            // 过滤空 part：
            // - null（被 cleanInlineData 等过滤）
            // - 空对象
            // - 仅包含 thought: true 的“空 thought 块”（常见于：原本只有 thoughtSignatures，后续又被配置过滤掉签名）
            //   这类 part 在不同模型/渠道下可能导致兼容性问题。
            .filter((part): part is ContentPart => {
                if (part === null) return false;
                // BR-07：孤儿 functionResponse 过滤——functionResponse.id 必须匹配
                // 已见的 functionCall id（见 processMessage 开头的登记）。无 id 的
                // functionResponse（Gemini 等按顺序配对的渠道）保守保留，不做激进过滤。
                // BR-08：被剔除调用（droppedCallIds）的配对 functionResponse 一并剔除，
                // 避免留下孤儿 tool 消息再次触发 400。
                if (part.functionResponse && part.functionResponse.id
                    && (droppedCallIds.has(part.functionResponse.id)
                        || !seenFunctionCallIds.has(part.functionResponse.id))) {
                    return false;
                }
                const keys = Object.keys(part);
                if (keys.length === 0) return false;
                if (keys.length === 1 && keys[0] === 'thought' && (part as any).thought === true) return false;
                return true;
            });
        
        if (parts.length === 0) {
            return null;
        }
        
        // 保留必要的元数据字段
        // BR-01：白名单过滤——id/parentId 等节点字段只用于存储与前端定位，不发送给模型
        //        （新增字段必须显式加入白名单才会下发）。
        const result: Content = {
            role: message.role,
            parts
        };
        
        // 保留 isUserInput 标记（用于确定动态提示词插入位置）
        if (message.isUserInput) {
            result.isUserInput = true;
        }

        // preserve 动态上下文策略需要在 formatter 构建请求时读取旧回合缓存。
        // 字段本身仍会在 formatter.cleanInternalFields 中被过滤，不会直接发送给模型。
        if (opts.includeTurnDynamicContext && message.turnDynamicContext) {
            result.turnDynamicContext = message.turnDynamicContext;
            result.turnDynamicContextStrategy = message.turnDynamicContextStrategy;
        }
        
        return result;
    };
    
    // 处理所有消息
    return history
        .map((message, index) => processMessage(message, index))
        .filter((message): message is Content => message !== null);
}
