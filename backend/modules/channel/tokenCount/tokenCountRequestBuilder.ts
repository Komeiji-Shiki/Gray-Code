/**
 * GrayCode - Token 计数请求体构造
 *
 * 由 TokenCountService.ts 拆分而来：把「Content → 各渠道 token 计数请求体」
 * 的内容转换逻辑抽为纯函数（token 计数职责的一部分）。
 */

import { cleanContentForAPI } from '../../conversation';
import type { Content } from '../../conversation';
import {
    isImageMimeType,
    isPdfMimeType,
    isTextMimeType,
    buildTextAttachmentContent,
    buildUnsupportedAttachmentText
} from '../formatters/mediaParts';
import { serializeToolResultForLLM } from '../formatters/toolResponseFormatter';

/** 构建 Gemini countTokens 请求体 */
export function buildGeminiCountRequestBody(contents: Content[]): { contents: any[] } {
    const geminiContents = contents.map(content => {
        const cleaned = cleanContentForAPI(content);
        return {
            role: cleaned.role,
            parts: cleaned.parts.map(part => {
                if ('text' in part && part.text !== undefined) {
                    return { text: part.text };
                }
                return part;
            })
        };
    });

    return {
        contents: geminiContents
    };
}

/**
 * 构建 OpenAI 兼容 count 请求的 messages 数组（对齐 openai.ts convertHistoryFunctionCallMode 的消息形态）：
 * - functionCall → assistant 消息的 tool_calls（旧实现拍成空文本，工具调用 token 漏计）
 * - functionResponse → role:tool 消息（旧实现拍成空文本，工具结果 token 漏计）
 * - system / 文本 / 图片维持原格式
 */
export function buildOpenAICountMessages(contents: Content[]): any[] {
    const messages: any[] = [];
    for (const content of contents) {
        const cleaned = cleanContentForAPI(content);
        const role = cleaned.role === 'model' ? 'assistant' : cleaned.role;

        const textParts = cleaned.parts.filter(p => 'text' in p && p.text);
        const functionCallParts = cleaned.parts.filter(p => p.functionCall);
        const functionResponseParts = cleaned.parts.filter(p => p.functionResponse);

        if (functionCallParts.length > 0) {
            // assistant 消息：文本并入 content，调用挂 tool_calls
            messages.push({
                role: 'assistant',
                content: textParts.length > 0 ? textParts.map(p => p.text).join('\n') : null,
                tool_calls: functionCallParts.map((p, index) => ({
                    id: p.functionCall!.id || `call_${Date.now()}_${index}`,
                    type: 'function',
                    function: {
                        name: p.functionCall!.name,
                        arguments: typeof p.functionCall!.args === 'string'
                            ? p.functionCall!.args
                            : JSON.stringify(p.functionCall!.args)
                    }
                }))
            });
        }

        // 工具结果独立为 role:tool 消息
        for (const part of functionResponseParts) {
            const resp = part.functionResponse!;
            messages.push({
                role: 'tool',
                tool_call_id: resp.id || '',
                content: serializeToolResultForLLM(resp.name, resp.response as Record<string, unknown>)
            });
        }

        // 普通消息（文本 + 图片，含 system）
        if (functionCallParts.length === 0 && functionResponseParts.length === 0) {
            messages.push({
                role,
                content: cleaned.parts.map(part => {
                    if ('text' in part && part.text) {
                        return { type: 'text' as const, text: part.text };
                    }
                    if ('inlineData' in part && part.inlineData) {
                        const { mimeType, data } = part.inlineData;
                        if (isImageMimeType(mimeType)) {
                            return {
                                type: 'image_url' as const,
                                image_url: {
                                    url: `data:${mimeType};base64,${data}`
                                }
                            };
                        }
                        if (isTextMimeType(mimeType)) {
                            return { type: 'text' as const, text: buildTextAttachmentContent(data) };
                        }
                        return { type: 'text' as const, text: buildUnsupportedAttachmentText(mimeType) };
                    }
                    return { type: 'text' as const, text: '' };
                })
            });
        }
    }

    return messages;
}

/**
 * 构建 OpenAI Responses count 请求的 input 数组。
 * 对于 Responses API，我们将所有内容转换为 input 数组，系统消息提取为 instructions。
 */
export function buildOpenAIResponsesCountInput(contents: Content[]): { input: any[]; instructions: string } {
    let instructions = '';
    const inputParts: any[] = [];

    for (const content of contents) {
        const cleaned = cleanContentForAPI(content);
        if (cleaned.role === 'system') {
            for (const part of cleaned.parts) {
                if ('text' in part && part.text) {
                    instructions += (instructions ? '\n' : '') + part.text;
                }
            }
            continue;
        }

        // user/model 消息都放入 input
        for (const part of cleaned.parts) {
            if ('text' in part && part.text) {
                inputParts.push({ type: 'text', text: part.text });
            } else if ('inlineData' in part && part.inlineData) {
                const { mimeType, data } = part.inlineData;
                if (isImageMimeType(mimeType)) {
                    inputParts.push({
                        type: 'input_image',
                        image_url: `data:${mimeType};base64,${data}`
                    });
                } else if (isTextMimeType(mimeType)) {
                    inputParts.push({ type: 'text', text: buildTextAttachmentContent(data) });
                } else {
                    inputParts.push({ type: 'text', text: buildUnsupportedAttachmentText(mimeType) });
                }
            }
        }
    }

    return { input: inputParts, instructions };
}

/**
 * 构建 Anthropic count_tokens 请求体内容（对齐 anthropic.ts buildRequest 的消息形态）：
 * - system 消息提取到独立 system 字段（count_tokens 与 Messages API 一样只接受
 *   user/assistant 角色，旧实现把 system 塞进 messages 会漏计/报错）
 * - 图片/PDF → image/document 块（旧实现拍成空文本，图片 token 漏计）
 * - functionCall/functionResponse → tool_use/tool_result 块（旧实现拍成空文本，
 *   工具调用与结果 token 漏计）
 */
export function buildAnthropicCountPayload(contents: Content[]): { messages: any[]; system?: string } {
    const systemTexts: string[] = [];
    const messages: any[] = [];
    for (const content of contents) {
        const cleaned = cleanContentForAPI(content);
        if (cleaned.role === 'system') {
            for (const part of cleaned.parts) {
                if ('text' in part && part.text) {
                    systemTexts.push(part.text);
                }
            }
            continue;
        }
        const role = cleaned.role === 'model' ? 'assistant' : cleaned.role;
        const contentBlocks: any[] = [];
        for (const part of cleaned.parts) {
            if ('text' in part && part.text !== undefined) {
                contentBlocks.push({ type: 'text', text: part.text });
            } else if (part.inlineData) {
                const { mimeType, data } = part.inlineData;
                if (isImageMimeType(mimeType)) {
                    contentBlocks.push({ type: 'image', source: { type: 'base64', media_type: mimeType, data } });
                } else if (isPdfMimeType(mimeType)) {
                    contentBlocks.push({ type: 'document', source: { type: 'base64', media_type: mimeType, data } });
                } else if (isTextMimeType(mimeType)) {
                    contentBlocks.push({ type: 'text', text: buildTextAttachmentContent(data) });
                } else {
                    contentBlocks.push({ type: 'text', text: buildUnsupportedAttachmentText(mimeType) });
                }
            } else if (part.functionCall) {
                const fc = part.functionCall;
                contentBlocks.push({
                    type: 'tool_use',
                    // 无 id 时生成（与 anthropic.ts convertHistoryFunctionCallMode 一致），
                    // 保证 count_tokens 结构校验通过
                    id: fc.id || `toolu_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                    name: fc.name,
                    input: fc.args
                });
            } else if (part.functionResponse) {
                const resp = part.functionResponse;
                contentBlocks.push({
                    type: 'tool_result',
                    tool_use_id: resp.id || `toolu_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                    content: serializeToolResultForLLM(resp.name, resp.response as Record<string, unknown>)
                });
            }
        }
        if (contentBlocks.length === 0) {
            // 空消息（如思考被剥离）：保留一个空 text 块，避免 count_tokens 结构校验报错
            contentBlocks.push({ type: 'text', text: '' });
        }
        messages.push({ role, content: contentBlocks });
    }

    return {
        messages,
        system: systemTexts.length > 0 ? systemTexts.join('\n') : undefined
    };
}
