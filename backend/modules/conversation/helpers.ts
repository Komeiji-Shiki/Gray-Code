/**
 * LimCode - 辅助工具函数
 * 
 * 提供便捷的消息构建和处理函数
 */

import type { Content, ContentPart } from './types';

/**
 * 判断消息是否为「真实 user 消息」（新回合边界）。
 *
 * MED-3 / H1-1：回合边界 = 真实用户输入。排除 functionResponse（工具结果）与
 * isSummary/isAutoSummary 总结消息——总结发生在回合内（SummarizeService 以 insertIndex
 * 在历史中间插入总结消息），不构成新回合；新回合只由新的真实 user 消息开始。
 * 同时排除 isSummarized（已被总结覆盖的原始消息）：逻辑截断语义下它们不再参与回合识别、
 * 发送与统计，但原文仍保留在历史中。
 *
 * 谓词统一入口：ConversationManager.addMessage / addContent / addBatch 的清空主会话信箱
 * 判定，与 formatHistoryForAPI 的当轮边界（lastNonFunctionResponseUserIndex）和回合列表
 * （roundStartIndices）必须使用同一谓词，否则出现“信箱未清空但 agentInbox 被当历史剥离”
 * 的行为分叉。
 */
export function isRealUserMessage(message: {
    role?: string;
    isFunctionResponse?: boolean;
    isSummary?: boolean;
    isAutoSummary?: boolean;
    isSummarized?: boolean;
    isUserInput?: boolean;
    source?: 'user' | 'background_task';
}): boolean {
    return message.role === 'user'
        && message.source !== 'background_task'
        && !message.isFunctionResponse
        && !message.isSummary
        && !message.isAutoSummary
        && !message.isSummarized;
}

/**
 * 构建包含多个 parts 的消息
 * 
 * Gemini 允许一个消息包含多个 parts，可以混合文本和多模态内容
 * 
 * @example
 * ```typescript
 * const message = buildMessage('user', [
 *     createImagePart('image/jpeg', imageData1),
 *     { text: '第一张图片的描述' },
 *     createImagePart('image/jpeg', imageData2),
 *     { text: '第二张图片的描述' },
 *     createVideoPart('video/mp4', videoData),
 *     { text: '请分析这些内容' }
 * ]);
 * ```
 */
export function buildMessage(
    role: 'user' | 'model' | 'system',
    parts: ContentPart[]
): Content {
    return {
        role,
        parts: [...parts]
    };
}

/**
 * 创建用户消息
 */
export function buildUserMessage(parts: ContentPart[]): Content {
    return buildMessage('user', parts);
}

/**
 * 创建系统消息
 */
export function buildSystemMessage(parts: ContentPart[]): Content {
    return buildMessage('system', parts);
}

/**
 * 创建模型消息
 */
export function buildModelMessage(parts: ContentPart[]): Content {
    return buildMessage('model', parts);
}

/**
 * 合并多个 parts 到现有消息
 * 
 * @example
 * ```typescript
 * let message = buildUserMessage([{ text: '初始文本' }]);
 * message = appendParts(message, [
 *     createImagePart('image/jpeg', imageData),
 *     { text: '追加的文本' }
 * ]);
 * ```
 */
export function appendParts(message: Content, additionalParts: ContentPart[]): Content {
    return {
        ...message,
        parts: [...message.parts, ...additionalParts]
    };
}

/**
 * 在消息开头插入 parts
 */
export function prependParts(message: Content, newParts: ContentPart[]): Content {
    return {
        ...message,
        parts: [...newParts, ...message.parts]
    };
}

/**
 * 获取消息中的所有文本内容
 * 
 * @param message 消息对象
 * @param separator 多个文本之间的分隔符，默认为空格
 * @returns 合并后的文本
 */
export function getMessageText(message: Content, separator: string = ' '): string {
    return message.parts
        .filter(part => part.text)
        .map(part => part.text!)
        .join(separator);
}

/**
 * 获取消息中的所有文本 parts
 */
export function getTextParts(message: Content): ContentPart[] {
    return message.parts.filter(part => part.text !== undefined);
}

/**
 * 获取消息中的所有多模态 parts（inlineData 或 fileData）
 */
export function getMultimediaParts(message: Content): ContentPart[] {
    return message.parts.filter(part => part.inlineData || part.fileData);
}

/**
 * 检查消息是否包含多模态内容
 */
export function hasMultimedia(message: Content): boolean {
    return message.parts.some(part => part.inlineData || part.fileData);
}

/**
 * 检查历史记录中是否有连续的相同 role
 * 
 * Gemini API 允许连续的相同 role，这在某些场景下很有用
 * 例如：用户连续发送多条消息，或模型分多次回答
 */
export function hasConsecutiveSameRole(history: Content[]): boolean {
    for (let i = 1; i < history.length; i++) {
        if (history[i].role === history[i - 1].role) {
            return true;
        }
    }
    return false;
}

/**
 * 获取连续相同 role 的消息组
 * 
 * @returns 消息组数组，每组包含连续的相同 role 消息
 * 
 * @example
 * ```typescript
 * const history = [
 *     { role: 'user', parts: [{ text: 'A' }] },
 *     { role: 'user', parts: [{ text: 'B' }] },
 *     { role: 'model', parts: [{ text: 'C' }] },
 *     { role: 'user', parts: [{ text: 'D' }] }
 * ];
 * 
 * const groups = groupByConsecutiveRole(history);
 * // 返回: [
 * //   [{ role: 'user', ... }, { role: 'user', ... }],
 * //   [{ role: 'model', ... }],
 * //   [{ role: 'user', ... }]
 * // ]
 * ```
 */
export function groupByConsecutiveRole(history: Content[]): Content[][] {
    if (history.length === 0) {
        return [];
    }

    const groups: Content[][] = [];
    let currentGroup: Content[] = [history[0]];

    for (let i = 1; i < history.length; i++) {
        if (history[i].role === history[i - 1].role) {
            currentGroup.push(history[i]);
        } else {
            groups.push(currentGroup);
            currentGroup = [history[i]];
        }
    }
    groups.push(currentGroup);

    return groups;
}

/**
 * 合并连续相同 role 的消息为单个消息
 * 
 * 注意：这会改变历史结构，谨慎使用！
 * 某些情况下连续相同 role 是有意义的，不应该合并
 * 
 * @example
 * ```typescript
 * const history = [
 *     { role: 'user', parts: [{ text: 'A' }] },
 *     { role: 'user', parts: [{ text: 'B' }] }
 * ];
 * 
 * const merged = mergeConsecutiveSameRole(history);
 * // 返回: [
 * //   { role: 'user', parts: [{ text: 'A' }, { text: 'B' }] }
 * // ]
 * ```
 */
export function mergeConsecutiveSameRole(history: Content[]): Content[] {
    if (history.length === 0) {
        return [];
    }

    const result: Content[] = [];
    let current: Content = {
        role: history[0].role,
        parts: [...history[0].parts]
    };

    for (let i = 1; i < history.length; i++) {
        if (history[i].role === current.role) {
            // 合并 parts
            current.parts.push(...history[i].parts);
        } else {
            result.push(current);
            current = {
                role: history[i].role,
                parts: [...history[i].parts]
            };
        }
    }
    result.push(current);

    return result;
}

/**
 * 统计消息中 parts 的数量
 */
export function countParts(message: Content): {
    total: number;
    text: number;
    inlineData: number;
    fileData: number;
    functionCall: number;
    functionResponse: number;
    thought: number;
} {
    const counts = {
        total: message.parts.length,
        text: 0,
        inlineData: 0,
        fileData: 0,
        functionCall: 0,
        functionResponse: 0,
        thought: 0
    };

    for (const part of message.parts) {
        if (part.text) counts.text++;
        if (part.inlineData) counts.inlineData++;
        if (part.fileData) counts.fileData++;
        if (part.functionCall) counts.functionCall++;
        if (part.functionResponse) counts.functionResponse++;
        if (part.thought === true) counts.thought++;
    }

    return counts;
}

/**
 * 创建纯文本消息
 */
export function createTextMessage(role: 'user' | 'model' | 'system', text: string): Content {
    return {
        role,
        parts: [{ text }]
    };
}

/**
 * 创建包含多个文本的消息
 * 
 * @example
 * ```typescript
 * const message = createMultiTextMessage('user', [
 *     '第一段文本',
 *     '第二段文本',
 *     '第三段文本'
 * ]);
 * ```
 */
export function createMultiTextMessage(
    role: 'user' | 'model' | 'system',
    texts: string[]
): Content {
    return {
        role,
        parts: texts.map(text => ({ text }))
    };
}

/**
 * 清理 functionResponse 中不应发送给 API 的内部字段
 *
 * 过滤的字段包括：
 * - 顶层：diffContentId, diffId, diffs, pendingDiffId,
 *          agentInbox（A-COMM 信箱消息，drain 一次性语义，仅当轮随工具结果返回给模型，禁止历史重放）
 * - data 字段中的：diffContentId, diffId, diffs, pendingDiffId, toolId, terminalId, multiRoot, command, cwd, shell,
 *                   channelName, modelId（subagents 运行时元数据，仅供 UI 展示）, agentInbox
 * - data.results 数组中的：diffContentId, pendingDiffId
 *
 * 保留的字段：killed, duration（AI 需要知道命令执行状态）；
 *             subagents 的 steps / toolsUsed（告知主模型子代理是否调用过工具及调用数量，不参与剥离）
 *
 * @param response functionResponse.response 对象
 * @param isHistoryMessage 是否是历史消息（当前回合之前的消息）。默认 true：历史中的
 *        agentInbox 必须剥离（drain 一次性语义，禁止跨轮重放、prompt 膨胀）；当轮
 *        （false）保留 agentInbox——injectInboxMessages 注入的 agent→main 信箱消息随工具
 *        结果落盘后，下一轮请求仍属当前回合，必须保留主模型才能真正看到（HIGH-1）。
 * @returns 清理后的 response 对象
 */
export function cleanFunctionResponseForAPI(
    response: Record<string, unknown> | undefined,
    isHistoryMessage = true
): Record<string, unknown> | undefined {
    // H1-3：数组也是 typeof 'object'，无法被上面拦截；数组没有内部字段语义，原样返回
    if (!response || typeof response !== 'object' || Array.isArray(response)) {
        return response;
    }
    
    // 过滤顶层内部字段
    // agentInbox：A-COMM 瞬态信箱消息（drain 一次性），只允许当轮随工具结果返回给模型；
    // 历史中的 functionResponse 必须剥离，否则每轮请求都会把 agent 消息重放给模型（prompt 持续膨胀）
    const { diffContentId, diffId, diffs, pendingDiffId, agentInbox, ...rest } = response;
    // HIGH-1：当轮（isHistoryMessage=false）保留 agentInbox，跨轮（默认）剥离防重放
    if (!isHistoryMessage && agentInbox !== undefined) {
        rest.agentInbox = agentInbox;
    }
    
    // 检查 data 字段中是否也有这些字段
    if (rest.data && typeof rest.data === 'object') {
        const {
            diffContentId: dataDiffContentId,
            diffId: dataDiffId,
            diffs: dataDiffs,
            pendingDiffId: dataPendingDiffId,
            toolId: dataToolId,
            terminalId: dataTerminalId,
            multiRoot: dataMultiRoot,
            // execute_command 的元数据，AI 已知
            command: dataCommand,
            cwd: dataCwd,
            shell: dataShell,
            // subagents 运行时元数据（仅供前端 UI 展示，不发给 AI）
            channelName: dataChannelName,
            modelId: dataModelId,
            // steps / toolsUsed 保留给 AI：用于告知子代理是否调用过工具及调用数量
            // （空数组 = 未调用任何工具），不参与剥离。
            agentInbox: dataAgentInbox,
            ...dataRest
        } = rest.data as Record<string, unknown>;
        
        // 检查 data.results 数组中的每个元素是否也有 diffContentId（如 search_in_files 的替换结果）
        if (Array.isArray(dataRest.results)) {
            dataRest.results = (dataRest.results as Array<Record<string, unknown>>).map(item => {
                if (item && typeof item === 'object') {
                    const { diffContentId: itemDiffContentId, pendingDiffId: itemPendingDiffId, ...itemRest } = item;
                    return itemRest;
                }
                return item;
            });
        }
        
        // HIGH-1：当轮保留 data.agentInbox（与顶层同理）
        if (!isHistoryMessage && dataAgentInbox !== undefined) {
            dataRest.agentInbox = dataAgentInbox;
        }
        
        rest.data = dataRest;
    }
    
    return rest;
}

/**
 * 清理 Content 中不应发送给 API 的内部字段
 *
 * 过滤的字段包括：
 * - Content 元数据：isFunctionResponse, estimatedTokenCount, tokenCountByChannel
 * - inlineData 中的：id, name（仅保留 mimeType, data, displayName）
 * - functionCall 中的：rejected
 * - functionResponse.response 中的内部字段（使用 cleanFunctionResponseForAPI）
 *
 * @param content Content 对象
 * @returns 清理后的 Content 对象
 */
export function cleanContentForAPI(content: Content): Content {
    const cleanedParts = content.parts.map(part => {
        const cleanedPart: ContentPart = {};
        
        // text
        if (part.text !== undefined) {
            cleanedPart.text = part.text;
        }
        
        // inlineData - 只保留 API 需要的字段
        if (part.inlineData) {
            cleanedPart.inlineData = {
                mimeType: part.inlineData.mimeType,
                data: part.inlineData.data
            };
            if (part.inlineData.displayName) {
                cleanedPart.inlineData.displayName = part.inlineData.displayName;
            }
            // 不包含 id, name
        }
        
        // fileData
        if (part.fileData) {
            cleanedPart.fileData = { ...part.fileData };
        }
        
        // functionCall
        if (part.functionCall) {
            cleanedPart.functionCall = {
                name: part.functionCall.name,
                args: part.functionCall.args
            };
            if (part.functionCall.id) {
                cleanedPart.functionCall.id = part.functionCall.id;
            }
            // 不包含 rejected
        }
        
        // functionResponse - 清理内部字段
        if (part.functionResponse) {
            const cleanedResponse = cleanFunctionResponseForAPI(
                part.functionResponse.response as Record<string, unknown>
            );

            cleanedPart.functionResponse = {
                name: part.functionResponse.name,
                response: cleanedResponse as Record<string, unknown>
            };
            if (part.functionResponse.id) {
                cleanedPart.functionResponse!.id = part.functionResponse.id;
            }
            // 不包含 parts（嵌套多模态内容由 ConversationManager 单独处理）
        }
        
        // thoughtSignatures
        if (part.thoughtSignatures) {
            cleanedPart.thoughtSignatures = part.thoughtSignatures;
        }
        
        // thought
        if (part.thought !== undefined) {
            cleanedPart.thought = part.thought;
        }
        
        return cleanedPart;
    });
    
    // 保留必要的元数据字段
    const result: Content = {
        role: content.role,
        parts: cleanedParts
        // 不包含 isFunctionResponse, estimatedTokenCount, tokenCountByChannel 等元数据
    };
    
    // 保留 isUserInput 标记（用于确定动态提示词插入位置）
    if (content.isUserInput) {
        result.isUserInput = true;
    }
    
    return result;
}