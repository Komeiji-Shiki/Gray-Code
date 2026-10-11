/** 历史消息到 Anthropic 内容块的转换；块顺序与思考签名在此统一维护。 */
import type { Content, ContentPart } from '../../../conversation/types';
import { USER_INPUT_BOUNDARY_MARKER } from '../base';
import { convertFunctionCallToXML, convertFunctionResponseToXML } from '../../../../tools/xmlFormatter';
import { convertFunctionCallToJSON, convertFunctionResponseToJSON } from '../../../../tools/jsonFormatter';
import { serializeToolResultForLLM } from '../toolResponseFormatter';
import {
    isImageMimeType,
    isPdfMimeType,
    isTextMimeType,
    buildTextAttachmentContent,
    buildUnsupportedAttachmentText
} from '../mediaParts';

/**
 * 转换为 Anthropic 消息格式
 *
 * Anthropic 格式：
 * - role: "user" | "assistant"
 * - content: array of content blocks
 */
export function convertToAnthropicMessages(
    history: Content[],
    toolMode: string = 'function_call'
): any[] {
    const messages: any[] = [];
    
    // 根据模式使用不同的转换策略
    if (toolMode === 'function_call') {
        convertHistoryFunctionCallMode(history, messages);
    } else {
        // XML 或 JSON 模式
        convertHistoryTextMode(history, messages, toolMode as 'xml' | 'json');
    }
    
    return messages;
}

/**
 * 追加一条转换后的消息，相邻同角色消息自动合并
 *
 * 修改原因（H1-3 防御）：总结功能（SummarizeService）会把总结消息以 role:'user'
 * 插入历史，可能紧随 functionResponse（tool_result）之后，或与真实 user 消息相邻，
 * 形成连续两条 user 消息；Anthropic Messages API 对同角色相邻消息敏感（部分端点
 * 要求严格交替）。这里把连续同角色输出合并为一条消息（content block 数组拼接）——
 * tool_result 与 text 允许共存于同一条 user 消息，语义不变。
 *
 * 注意：只合并真正同角色的连续条目。assistant(tool_use) 与 user(tool_result) 角色
 * 不同，天然交替，不会跨 tool_use 边界错误合并。assistant 连续消息同样合并
 * （防御，很少发生）。
 */
function pushMergedMessage(messages: any[], role: string, contentArray: any[], isUserInput = false): void {
    const last = messages[messages.length - 1];
    if (last && last.role === role) {
        // 合并相邻同角色消息时，在真实用户输入前插入边界标识：合并后模型只看到
        // 同一 role 的连续 content 块，无法分辨哪一段才是本轮用户输入。
        const boundary = isUserInput
            ? [{ type: 'text', text: USER_INPUT_BOUNDARY_MARKER }]
            : [];
        last.content.push(...boundary, ...contentArray);
    } else {
        messages.push({ role, content: contentArray });
    }
}

/**
 * Function Call 模式转换
 *
 * - functionCall 使用 type: "tool_use"
 * - functionResponse 使用 type: "tool_result"
 * - 思考内容使用 type: "thinking"，包含 thinking 和 signature 字段
 * - 加密思考使用 type: "redacted_thinking"，包含 data 字段
 */
function convertHistoryFunctionCallMode(history: Content[], messages: any[]): void {
    // 成对过滤：rejected functionCall 及其配对 functionResponse 一起丢弃，
    // 避免「tool_use 被滤掉而 tool_result 残留」的孤儿 tool_result 400。
    const rejectedCallIds = new Set<string>();
    for (const content of history) {
        for (const part of content.parts) {
            if (part.functionCall?.rejected && part.functionCall.id) {
                rejectedCallIds.add(part.functionCall.id);
            }
        }
    }

    for (const content of history) {
        const role = content.role === 'model' ? 'assistant' : content.role;
        
        const textParts: ContentPart[] = [];
        const functionCallParts: ContentPart[] = [];
        const functionResponseParts: ContentPart[] = [];
        const mediaParts: ContentPart[] = [];
        let hasThinkingParts = false;
        // 思考块仍按原 parts 顺序组装，此处只记录是否存在，其他类型独立分类。
        for (const part of content.parts) {
            if ('text' in part && !part.thought) textParts.push(part);
            if (('text' in part && part.thought) || part.redactedThinking || (part as any).signature) hasThinkingParts = true;
            if (part.functionCall && !part.functionCall.rejected) functionCallParts.push(part);
            if (part.functionResponse && !(part.functionResponse.id && rejectedCallIds.has(part.functionResponse.id))) functionResponseParts.push(part);
            if (part.inlineData || part.fileData) mediaParts.push(part);
        }
        
        if (functionCallParts.length > 0) {
            // assistant 消息包含 tool_use
            const contentArray: any[] = [];
            
            // 添加思考内容（如果有）- 包括普通思考和加密思考
            addThinkingBlocks(contentArray, content.parts);
            
            // 添加文本内容
            for (const part of textParts) {
                if (part.text) {
                    contentArray.push({
                        type: 'text',
                        text: part.text
                    });
                }
            }
            
            // 添加 tool_use
            for (const [index, part] of functionCallParts.entries()) {
                const fc = part.functionCall!;
                contentArray.push({
                    type: 'tool_use',
                    // 无 id 时生成：计数器+随机后缀保证同消息内多个 tool_use 不重复
                    // （对齐 openai.ts 的 _${index} 做法；裸 Date.now() 同毫秒会碰撞）
                    id: fc.id || `toolu_${Date.now()}_${index}_${Math.random().toString(36).slice(2, 8)}`,
                    name: fc.name,
                    input: fc.args
                });
            }
            
            pushMergedMessage(messages, 'assistant', contentArray);
        }

        // 工具结果独立生成（与 functionCall 解耦）：同一历史消息同时携带
        // functionCall + functionResponse（如中断残留/修复数据的混合形态）时，
        // 原来的 else-if 会吞掉 functionResponse，导致 assistant tool_use
        // 后没有对应 tool_result → Anthropic 400。这里改为独立分支。
        if (functionResponseParts.length > 0) {
            // user 消息包含 tool_result；同消息的 textParts 一并并入 content
            // （Anthropic tool_result 与 text 块可共存），避免 text + functionResponse
            // 混合形态把文本丢掉。
            const contentArray: any[] = [];

            // 添加文本内容
            for (const part of textParts) {
                if (part.text) {
                    contentArray.push({
                        type: 'text',
                        text: part.text
                    });
                }
            }

            for (const [index, part] of functionResponseParts.entries()) {
                const resp = part.functionResponse!;
                const toolUseId = resp.id || `toolu_${Date.now()}_${index}_${Math.random().toString(36).slice(2, 8)}`;

                // 修改原因：Anthropic 官方支持 tool_result.content 为块数组（text/image/document），
                // 旧实现只序列化文本，read_file 等工具返回的嵌套多模态（functionResponse.parts 中的
                // inlineData 图片/PDF，以及 DeepSeek Vision 预处理后从 PDF 栅格化的分页图片）会被
                // 静默丢弃。这里把嵌套媒体转换为 content 块一并发送。
                const mediaBlocks = resp.parts?.length
                    ? buildFunctionResponseMediaBlocks(resp.parts)
                    : [];
                if (mediaBlocks.length === 0) {
                    contentArray.push({
                        type: 'tool_result',
                        tool_use_id: toolUseId,
                        content: serializeToolResultForLLM(resp.name, resp.response as Record<string, unknown>)
                    });
                    continue;
                }

                // 文本结果 + 媒体块合并为 content 块数组（Anthropic 允许 tool_result 的
                // content 同时包含 text/image/document 块）。
                const resultBlocks: any[] = [];
                const textResult = serializeToolResultForLLM(resp.name, resp.response as Record<string, unknown>);
                if (textResult) {
                    resultBlocks.push({ type: 'text', text: textResult });
                }
                resultBlocks.push(...mediaBlocks);
                contentArray.push({
                    type: 'tool_result',
                    tool_use_id: toolUseId,
                    content: resultBlocks
                });
            }
            // 工具结果消息可能同时携带截图/文件等附件；作为同一 user 消息的后续内容块发送，
            // 避免 functionResponse 分支吞掉 mediaParts。
            contentArray.push(...buildMessageContent([], mediaParts));

            pushMergedMessage(messages, 'user', contentArray, content.isUserInput === true);
        }

        // 普通消息独立生成：必须同时排除 functionCall 与 functionResponse。
        // 若挂成 else-if（仅排除 functionResponse），"text + functionCall"
        // 同消息的最普通形态会把文本输出两次，tool_use 与 tool_result
        // 被分隔 → 400。与 openai.ts 的修复保持一致。
        if (
            functionCallParts.length === 0 &&
            functionResponseParts.length === 0 &&
            (textParts.length > 0 || mediaParts.length > 0 || hasThinkingParts)
        ) {
            // 普通消息（可能包含文本、多媒体和/或思考内容）
            const contentArray: any[] = [];
            
            // 添加思考内容（如果有）- 包括普通思考和加密思考
            addThinkingBlocks(contentArray, content.parts);
            
            // 添加普通内容
            contentArray.push(...buildMessageContent(textParts, mediaParts));
            
            pushMergedMessage(messages, role, contentArray, role === 'user' && content.isUserInput === true);
        }
    }
}

/**
 * 把 functionResponse.parts 中的嵌套多模态（inlineData/fileData）转换为
 * Anthropic tool_result content 块数组（text/image/document）。
 *
 * 修改原因：Anthropic 官方允许 tool_result.content 为块数组（text/image/document），
 * 旧实现仅序列化文本导致工具返回的图片/PDF 被静默丢弃；该方法与顶层
 * buildMessageContent 的 MIME 分支保持一致（DeepSeek Vision 预处理后
 * PDF 会先被栅格化为分页 image 块，走 image 分支）。
 */
function buildFunctionResponseMediaBlocks(parts: ContentPart[]): any[] {
    const blocks: any[] = [];
    for (const part of parts) {
        if (part.inlineData) {
            const { mimeType, data } = part.inlineData;
            if (isImageMimeType(mimeType)) {
                blocks.push({
                    type: 'image',
                    source: { type: 'base64', media_type: mimeType, data }
                });
            } else if (isPdfMimeType(mimeType)) {
                blocks.push({
                    type: 'document',
                    source: { type: 'base64', media_type: mimeType, data }
                });
            } else if (isTextMimeType(mimeType)) {
                blocks.push({ type: 'text', text: buildTextAttachmentContent(data) });
            } else {
                blocks.push({ type: 'text', text: buildUnsupportedAttachmentText(mimeType) });
            }
        } else if (part.fileData) {
            const { mimeType, fileUri } = part.fileData;
            if (isImageMimeType(mimeType)) {
                blocks.push({
                    type: 'image',
                    source: { type: 'url', url: fileUri }
                });
            } else if (isPdfMimeType(mimeType)) {
                blocks.push({
                    type: 'document',
                    source: { type: 'url', url: fileUri }
                });
            } else {
                blocks.push({ type: 'text', text: buildUnsupportedAttachmentText(mimeType) });
            }
        }
    }
    return blocks;
}

/**
 * 添加思考块到内容数组
 *
 * 处理三种类型的思考内容：
 * 1. 普通思考（thinking）
 * 2. 加密思考（redacted_thinking）
 * 3. 思考签名（signature）
 */
function addThinkingBlocks(
    contentArray: any[],
    parts: ContentPart[]
): void {
    // thinking 和 redacted_thinking 的相对顺序参与上游校验，不能按类型分组。
    // 旧存储把思考文本与签名分为相邻 parts；无文本的签名代表 omitted thinking。
    let pendingThinking: any;
    for (const part of parts) {
        const signature = (part as any).signature;
        if (part.redactedThinking) {
            contentArray.push({
                type: 'redacted_thinking',
                data: part.redactedThinking
            });
            pendingThinking = undefined;
        } else if (part.thought && typeof part.text === 'string') {
            pendingThinking = {
                type: 'thinking',
                thinking: part.text,
                ...(signature ? { signature } : {})
            };
            contentArray.push(pendingThinking);
        } else if (signature) {
            if (pendingThinking && !pendingThinking.signature) {
                pendingThinking.signature = signature;
            } else {
                contentArray.push({ type: 'thinking', thinking: '', signature });
            }
            pendingThinking = undefined;
        } else {
            pendingThinking = undefined;
        }
    }
}

/**
 * 构建消息内容（支持多模态）
 *
 * Anthropic 格式：
 * - 文本：{type: "text", text: "..."}
 * - 图片：{type: "image", source: {type: "base64", media_type: "...", data: "..."}}
 */
function buildMessageContent(textParts: ContentPart[], mediaParts: ContentPart[]): any[] {
    const contentArray: any[] = [];
    
    // 添加多媒体部分（按 MIME 类型转换，不能一律当作图片）
    for (const part of mediaParts) {
        if (part.inlineData) {
            const { mimeType, data } = part.inlineData;
            
            if (isImageMimeType(mimeType)) {
                // 图片 -> image 块（Base64 内联数据）
                contentArray.push({
                    type: 'image',
                    source: {
                        type: 'base64',
                        media_type: mimeType,
                        data
                    }
                });
            } else if (isPdfMimeType(mimeType)) {
                // PDF -> document 块（Anthropic 支持）
                contentArray.push({
                    type: 'document',
                    source: {
                        type: 'base64',
                        media_type: mimeType,
                        data
                    }
                });
            } else if (isTextMimeType(mimeType)) {
                // 文本文件（如 txt）-> 解码为 text 块
                contentArray.push({
                    type: 'text',
                    text: buildTextAttachmentContent(data)
                });
            } else {
                // 其他格式（音视频等）Anthropic 不支持直接发送，转为文本占位
                contentArray.push({
                    type: 'text',
                    text: buildUnsupportedAttachmentText(mimeType)
                });
            }
        } else if (part.fileData) {
            const { mimeType, fileUri } = part.fileData;
            if (isImageMimeType(mimeType)) {
                contentArray.push({
                    type: 'image',
                    source: { type: 'url', url: fileUri }
                });
            } else if (isPdfMimeType(mimeType)) {
                contentArray.push({
                    type: 'document',
                    source: { type: 'url', url: fileUri }
                });
            } else {
                // Anthropic 的 URL source 仅用于受支持的图片/文档，文本和其他文件不能伪装成图片。
                contentArray.push({
                    type: 'text',
                    text: buildUnsupportedAttachmentText(mimeType)
                });
            }
        }
    }
    
    // 添加文本部分
    for (const part of textParts) {
        if (part.text) {
            contentArray.push({
                type: 'text',
                text: part.text
            });
        }
    }
    
    return contentArray;
}

/**
 * XML/JSON 模式转换
 *
 * - functionCall 转回文本
 * - functionResponse 作为 user 消息发送
 */
function convertHistoryTextMode(history: Content[], messages: any[], mode: 'xml' | 'json'): void {
    // 成对过滤：rejected functionCall 及其配对 functionResponse 一起丢弃（见 function_call 模式注释）
    const rejectedCallIds = new Set<string>();
    for (const content of history) {
        for (const part of content.parts) {
            if (part.functionCall?.rejected && part.functionCall.id) {
                rejectedCallIds.add(part.functionCall.id);
            }
        }
    }

    for (const content of history) {
        const role = content.role === 'model' ? 'assistant' : content.role;
        
        // 分离各种类型的 parts
        const functionResponseParts = content.parts.filter(
            p => p.functionResponse && !(p.functionResponse.id && rejectedCallIds.has(p.functionResponse.id))
        );
        const mediaParts = content.parts.filter(p => p.inlineData || p.fileData);
        
        if (functionResponseParts.length > 0) {
            // functionResponse 作为 user 消息发送；同消息的普通 text parts 一并并入
            // （与 function_call 模式分支对齐：text → response 文本 → media 的顺序），
            // 避免 text + functionResponse 混合形态把文本丢掉。
            const contentArray: any[] = [];

            // 添加同消息的普通文本内容
            for (const part of content.parts) {
                if ('text' in part && part.text && !part.thought) {
                    contentArray.push({
                        type: 'text',
                        text: part.text
                    });
                }
            }
            
            for (const part of functionResponseParts) {
                const resp = part.functionResponse!;
                const responseText = mode === 'xml'
                    ? convertFunctionResponseToXML(resp.name, resp.response)
                    : convertFunctionResponseToJSON(resp.name, resp.response);

                contentArray.push({
                    type: 'text',
                    text: responseText
                });
            }
            contentArray.push(...buildMessageContent([], mediaParts));

            pushMergedMessage(messages, 'user', contentArray, content.isUserInput === true);
        } else {
            // 将 functionCall 转回文本，与 text 合并
            const textParts: ContentPart[] = [];
            
            for (const part of content.parts) {
                if (part.thought) {
                    continue;
                }
                
                if (part.inlineData || part.fileData) {
                    continue;
                }
                
                if (part.functionCall && !part.functionCall.rejected) {
                    const callText = mode === 'xml'
                        ? convertFunctionCallToXML(part.functionCall.name, part.functionCall.args)
                        : convertFunctionCallToJSON(part.functionCall.name, part.functionCall.args);
                    textParts.push({ text: callText });
                } else if ('text' in part && part.text) {
                    textParts.push({ text: part.text });
                }
            }
            
            if (textParts.length > 0 || mediaParts.length > 0) {
                const contentArray = buildMessageContent(textParts, mediaParts);
                pushMergedMessage(messages, role, contentArray, role === 'user' && content.isUserInput === true);
            }
        }
    }
}

/**
 * 转换思考签名格式
 *
 * 将内部存储的 thoughtSignatures: { anthropic: "..." } 格式
 * 转换为 Anthropic API 需要的 signature 字段格式
 *
 * Anthropic 思考签名格式（发送时）：
 * content: [
 *   { type: "thinking", thinking: "...", signature: "..." }
 * ]
 *
 * 由于我们在 convertToAnthropicMessages 中处理内容，
 * 这里需要处理 parts 中的 thoughtSignatures
 */
export function convertThoughtSignatures(history: Content[]): Content[] {
    return history.map(content => {
        return {
            ...content,
            parts: content.parts.map(part => {
                // 如果有 thoughtSignatures，提取 anthropic 格式的签名
                if (part.thoughtSignatures?.anthropic) {
                    const { thoughtSignatures, ...restPart } = part;
                    return {
                        ...restPart,
                        // 使用 signature 字段存储，在后续处理中会转换为正确格式
                        signature: thoughtSignatures.anthropic
                    } as ContentPart;
                }
                // 如果有 thoughtSignatures 但没有 anthropic 格式，移除
                if (part.thoughtSignatures) {
                    const { thoughtSignatures, ...restPart } = part;
                    return restPart;
                }
                return part;
            })
        };
    });
}
