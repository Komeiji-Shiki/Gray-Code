/**
 * LimCode - 工具调用解析服务
 *
 * 负责解析和转换各种格式的工具调用：
 * - Function Call 格式（Gemini/OpenAI 原生）
 * - XML 格式（<tool_use> 标签）
 * - JSON 边界标记格式（<<<TOOL_CALL>>>）
 */

import type { Content, ContentPart } from '../../../conversation/types';
import type { ToolMode } from '../../../config/configs/base';
import {
    detectPromptToolMode,
    extractPromptToolParts,
    type PromptToolMode
} from '../../../../tools/promptToolParser';
import { generateToolCallId, type FunctionCallInfo } from '../utils';

function assignFunctionCallIds(parts: ContentPart[]): ContentPart[] {
    return parts.map(part => {
        if (!part.functionCall) {
            return part;
        }
        return {
            ...part,
            functionCall: {
                ...part.functionCall,
                id: part.functionCall.id || generateToolCallId()
            }
        };
    });
}

/**
 * 工具调用解析服务
 *
 * 职责：
 * 1. 从 Content 中提取函数调用（支持多种格式）
 * 2. 将 XML/JSON 格式的工具调用转换为统一的 functionCall 格式
 * 3. 确保所有 functionCall 都有唯一 ID
 */
export class ToolCallParserService {
    /**
     * 从 Content 中提取函数调用
     */
    extractFunctionCalls(content: Content, toolMode: ToolMode = 'function_call'): FunctionCallInfo[] {
        const calls: FunctionCallInfo[] = [];

        for (const part of content.parts) {
            if (part.functionCall) {
                calls.push({
                    name: part.functionCall.name,
                    args: part.functionCall.args,
                    id: part.functionCall.id || generateToolCallId()
                });
                continue;
            }

            if (!part.text || part.thought || toolMode === 'function_call') {
                continue;
            }

            const parsedParts = this.parsePromptText(part.text, toolMode);
            for (const parsedPart of parsedParts) {
                if (!parsedPart.functionCall) {
                    continue;
                }
                calls.push({
                    name: parsedPart.functionCall.name,
                    args: parsedPart.functionCall.args,
                    id: parsedPart.functionCall.id || generateToolCallId()
                });
            }
        }

        return calls;
    }

    /**
     * 将 prompt 模式工具调用转换为 functionCall 格式
     *
     * 注意：此方法会直接修改传入的 content 对象
     */
    convertPromptModeToolCallsToFunctionCalls(content: Content, toolMode: ToolMode = 'function_call'): void {
        if (toolMode === 'function_call') {
            return;
        }

        const promptMode = toolMode as PromptToolMode;
        const newParts: ContentPart[] = [];

        for (const part of content.parts) {
            if (!part.text || part.thought) {
                newParts.push(part);
                continue;
            }

            const parsedParts = this.parsePromptText(part.text, promptMode);
            if (parsedParts.length === 0) {
                newParts.push(part);
                continue;
            }

            newParts.push(...assignFunctionCallIds(parsedParts));
        }

        content.parts = newParts;
    }

    /**
     * 兼容旧名称
     */
    convertXMLToolCallsToFunctionCalls(content: Content, toolMode: ToolMode = 'function_call'): void {
        this.convertPromptModeToolCallsToFunctionCalls(content, toolMode);
    }

    /**
     * 确保 Content 中的所有 functionCall 都有唯一 id
     *
     * 注意：此方法会直接修改传入的 content 对象
     */
    ensureFunctionCallIds(content: Content): void {
        for (const part of content.parts) {
            if (part.functionCall && !part.functionCall.id) {
                part.functionCall.id = generateToolCallId();
            }
        }
    }

    private parsePromptText(text: string, toolMode: ToolMode | PromptToolMode): ContentPart[] {
        if (toolMode === 'function_call') {
            return [];
        }

        const detectedMode = detectPromptToolMode(text);
        const promptMode = (toolMode === 'json' || toolMode === 'xml') ? toolMode : detectedMode;
        if (!promptMode) {
            return [];
        }

        const { parts } = extractPromptToolParts(text, promptMode, {
            flushIncompleteTailAsText: true
        });

        return parts;
    }
}
