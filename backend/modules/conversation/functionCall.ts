/**
 * LimCode - 函数调用工具
 * 
 * 提供创建和处理 Gemini 函数调用的工具函数
 * 支持单个函数调用和并行函数调用
 */

import type { ContentPart, Content } from './types';

/**
 * 创建函数调用 ContentPart
 *
 * @param name 函数名
 * @param args 函数参数
 * @param id 可选的函数调用 ID
 * @param thoughtSignatures 可选的思考签名（多格式支持）
 * @returns ContentPart 对象
 *
 * @example
 * ```typescript
 * // 不带思考签名
 * const call = createFunctionCall('get_weather', {
 *     location: 'Boston',
 *     unit: 'celsius'
 * });
 *
 * // 带思考签名（Gemini 3 必需）
 * const callWithThought = createFunctionCall(
 *     'get_weather',
 *     { location: 'Boston' },
 *     undefined,
 *     { gemini: 'thought_signature' }
 * );
 * ```
 */
export function createFunctionCall(
    name: string,
    args: Record<string, unknown> = {},
    id?: string,
    thoughtSignatures?: Record<string, string>
): ContentPart {
    const functionCall: ContentPart['functionCall'] = {
        name,
        args
    };
    
    if (id) {
        functionCall.id = id;
    }
    
    const part: ContentPart = { functionCall };
    
    if (thoughtSignatures) {
        part.thoughtSignatures = thoughtSignatures;
    }
    
    return part;
}

/**
 * 创建包含单个函数调用的消息
 *
 * @param name 函数名
 * @param args 函数参数
 * @param id 可选的函数调用 ID
 * @param thoughtSignatures 可选的思考签名（多格式支持）
 * @returns Content 消息对象
 *
 * @example
 * ```typescript
 * const message = createFunctionCallMessage('get_weather', {
 *     location: 'Boston'
 * });
 *
 * // 带思考签名（Gemini 3）
 * const messageWithThought = createFunctionCallMessage(
 *     'get_weather',
 *     { location: 'Boston' },
 *     undefined,
 *     { gemini: 'signature' }
 * );
 *
 * await manager.addContent('chat-001', message);
 * ```
 */
export function createFunctionCallMessage(
    name: string,
    args: Record<string, unknown> = {},
    id?: string,
    thoughtSignatures?: Record<string, string>
): Content {
    return {
        role: 'model',
        parts: [createFunctionCall(name, args, id, thoughtSignatures)]
    };
}

/**
 * 创建并行函数调用消息
 *
 * Gemini 支持在一个消息中并行调用多个函数
 * 每个函数调用可以有独立的思考签名
 *
 * @param calls 函数调用数组
 * @returns Content 消息对象
 *
 * @example
 * ```typescript
 * const message = createParallelFunctionCalls([
 *     { name: 'get_weather', args: { location: 'Boston' } },
 *     { name: 'get_weather', args: { location: 'San Francisco' } },
 *     { name: 'get_news', args: { topic: 'technology' } }
 * ]);
 *
 * // 带思考签名（Gemini 3）
 * const messageWithThoughts = createParallelFunctionCalls([
 *     {
 *         name: 'get_weather',
 *         args: { location: 'Boston' },
 *         thoughtSignatures: { gemini: 'signature1' }
 *     },
 *     {
 *         name: 'get_weather',
 *         args: { location: 'SF' },
 *         thoughtSignatures: { gemini: 'signature2' }
 *     }
 * ]);
 *
 * await manager.addContent('chat-001', message);
 * ```
 */
export function createParallelFunctionCalls(
    calls: Array<{
        name: string;
        args?: Record<string, unknown>;
        id?: string;
        thoughtSignatures?: Record<string, string>;
    }>
): Content {
    return {
        role: 'model',
        parts: calls.map(call =>
            createFunctionCall(call.name, call.args, call.id, call.thoughtSignatures)
        )
    };
}

/**
 * 从消息中提取所有函数调用
 *
 * @param message 消息对象
 * @param includeThoughtSignatures 是否包含思考签名
 * @returns 函数调用数组
 */
export function extractFunctionCalls(
    message: Content,
    includeThoughtSignatures: boolean = false
): Array<{
    name: string;
    args: Record<string, unknown>;
    id?: string;
    thoughtSignatures?: Record<string, string>;
}> {
    return message.parts
        .filter(part => part.functionCall)
        .map(part => {
            const result: {
                name: string;
                args: Record<string, unknown>;
                id?: string;
                thoughtSignatures?: Record<string, string>;
            } = {
                name: part.functionCall!.name,
                args: part.functionCall!.args
            };
            
            if (part.functionCall!.id) {
                result.id = part.functionCall!.id;
            }
            
            if (includeThoughtSignatures && part.thoughtSignatures) {
                result.thoughtSignatures = part.thoughtSignatures as Record<string, string>;
            }
            
            return result;
        });
}

/**
 * 检查消息是否包含函数调用
 */
export function hasFunctionCalls(message: Content): boolean {
    return message.parts.some(part => part.functionCall !== undefined);
}

/**
 * 检查消息是否包含并行函数调用（多个函数调用）
 */
export function hasParallelFunctionCalls(message: Content): boolean {
    const callCount = message.parts.filter(
        part => part.functionCall !== undefined
    ).length;
    return callCount > 1;
}

/**
 * 获取消息中的函数调用数量
 */
export function getFunctionCallCount(message: Content): number {
    return message.parts.filter(
        part => part.functionCall !== undefined
    ).length;
}

/**
 * 检查消息是否包含函数响应
 */
export function hasFunctionResponses(message: Content): boolean {
    return message.parts.some(part => part.functionResponse !== undefined);
}

/**
 * 从消息中提取所有函数响应
 */
export function extractFunctionResponses(message: Content): Array<{
    name: string;
    response: Record<string, unknown>;
    parts?: ContentPart[];
}> {
    return message.parts
        .filter(part => part.functionResponse)
        .map(part => part.functionResponse!);
}

/**
 * 创建并行函数响应消息
 * 
 * 用于响应并行函数调用
 * 
 * @param responses 函数响应数组
 * @returns Content 消息对象
 * 
 * @example
 * ```typescript
 * const message = createParallelFunctionResponses([
 *     { name: 'get_weather', response: { temp: 20, condition: 'sunny' } },
 *     { name: 'get_weather', response: { temp: 18, condition: 'cloudy' } }
 * ]);
 * 
 * await manager.addContent('chat-001', message);
 * ```
 */
export function createParallelFunctionResponses(
    responses: Array<{
        name: string;
        response: Record<string, unknown>;
        parts?: ContentPart[];
    }>
): Content {
    return {
        role: 'user',
        parts: responses.map(resp => ({
            functionResponse: resp
        }))
    };
}

/**
 * 按函数名分组函数调用
 *
 * @param message 包含函数调用的消息
 * @param includeThoughtSignatures 是否包含思考签名
 * @returns 按函数名分组的调用
 *
 * @example
 * ```typescript
 * const groups = groupFunctionCallsByName(message);
 * // {
 * //   'get_weather': [
 * //     { name: 'get_weather', args: { location: 'Boston' } },
 * //     { name: 'get_weather', args: { location: 'SF' } }
 * //   ],
 * //   'get_news': [
 * //     { name: 'get_news', args: { topic: 'tech' } }
 * //   ]
 * // }
 * ```
 */
export function groupFunctionCallsByName(
    message: Content,
    includeThoughtSignatures: boolean = false
): Record<string, Array<{
    name: string;
    args: Record<string, unknown>;
    id?: string;
    thoughtSignatures?: Record<string, string>;
}>> {
    const groups: Record<string, Array<{
        name: string;
        args: Record<string, unknown>;
        id?: string;
        thoughtSignatures?: Record<string, string>;
    }>> = {};
    
    const calls = extractFunctionCalls(message, includeThoughtSignatures);
    
    for (const call of calls) {
        if (!groups[call.name]) {
            groups[call.name] = [];
        }
        groups[call.name].push(call);
    }
    
    return groups;
}

/**
 * 统计对话历史中的函数调用
 * 
 * @param history 对话历史
 * @returns 统计信息
 */
export function analyzeFunctionCalls(history: Content[]): {
    totalCalls: number;
    totalResponses: number;
    parallelCalls: number;
    callsByFunction: Record<string, number>;
    averageCallsPerMessage: number;
} {
    let totalCalls = 0;
    let totalResponses = 0;
    let parallelCalls = 0;
    const callsByFunction: Record<string, number> = {};
    let messagesWithCalls = 0;
    
    for (const message of history) {
        const callCount = getFunctionCallCount(message);
        
        if (callCount > 0) {
            totalCalls += callCount;
            messagesWithCalls++;
            
            if (callCount > 1) {
                parallelCalls++;
            }
            
            // 统计每个函数的调用次数
            const calls = extractFunctionCalls(message);
            for (const call of calls) {
                callsByFunction[call.name] = (callsByFunction[call.name] || 0) + 1;
            }
        }
        
        // 统计函数响应
        if (hasFunctionResponses(message)) {
            const responses = extractFunctionResponses(message);
            totalResponses += responses.length;
        }
    }
    
    return {
        totalCalls,
        totalResponses,
        parallelCalls,
        callsByFunction,
        averageCallsPerMessage: messagesWithCalls > 0 
            ? totalCalls / messagesWithCalls 
            : 0
    };
}

/**
 * 检查函数调用和响应是否匹配
 * 
 * @param callMessage 包含函数调用的消息
 * @param responseMessage 包含函数响应的消息
 * @returns 匹配结果
 */
export function matchFunctionCallsAndResponses(
    callMessage: Content,
    responseMessage: Content
): {
    matched: boolean;
    missingResponses: string[];
    extraResponses: string[];
} {
    const calls = extractFunctionCalls(callMessage);
    const responses = extractFunctionResponses(responseMessage);
    
    const callNames = calls.map(c => c.name);
    const responseNames = responses.map(r => r.name);
    
    const missingResponses = callNames.filter(
        name => !responseNames.includes(name)
    );
    const extraResponses = responseNames.filter(
        name => !callNames.includes(name)
    );
    
    return {
        matched: missingResponses.length === 0 && extraResponses.length === 0,
        missingResponses,
        extraResponses
    };
}