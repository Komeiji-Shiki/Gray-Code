/**
 * GrayCode - MCP 工具适配器
 *
 * 将 MCP 工具转换为内置工具格式，支持 XML/JSON/Function Call
 *
 * WP12：MCP 工具名编解码统一走 mcpToolNameCodec（mcp__<serverId>__<toolName>），
 * 不再使用旧的单下划线 mcp_<serverId>_<tool> 约定与手写 split('_') 解析。
 */

import type { ToolDeclaration, Tool, ToolResult, MultimodalData } from '../../tools/types';
import type { McpToolDefinition, McpToolCallResult } from './types';
import { encodeMcpToolName, decodeMcpToolName } from './mcpToolNameCodec';

/**
 * MCP 工具参数 JSON Schema
 */
export interface McpToolSchema {
    type: 'object';
    properties?: Record<string, any>;
    required?: string[];
    [key: string]: any;
}

/**
 * 将 MCP 工具定义转换为 ToolDeclaration
 *
 * @param tool MCP 工具定义
 * @param serverId 服务器 ID（用于区分不同服务器的工具）
 * @returns 标准工具声明
 */
export function mcpToolToDeclaration(
    tool: McpToolDefinition,
    serverId: string
): ToolDeclaration {
    // WP12：统一用 codec 编码 MCP 工具名（mcp__<serverId>__<toolName>，
    // 支持 serverId/toolName 含单下划线的边界情况）
    const toolName = encodeMcpToolName(serverId, tool.name);

    // 将 MCP 的 inputSchema 转换为 ToolDeclaration 的 parameters
    const parameters = convertInputSchemaToParameters(tool.inputSchema);

    return {
        name: toolName,
        description: tool.description || `MCP Tool: ${tool.name}`,
        category: 'mcp',
        parameters
    };
}

/**
 * 将 MCP inputSchema 转换为 ToolDeclaration parameters
 */
function convertInputSchemaToParameters(inputSchema?: McpToolSchema): ToolDeclaration['parameters'] {
    if (!inputSchema) {
        return {
            type: 'object',
            properties: {},
            required: []
        };
    }

    return {
        ...inputSchema,
        type: 'object',
        properties: inputSchema.properties || {},
        required: inputSchema.required || []
    };
}

/**
 * 将 MCP 工具调用结果转换为 ToolResult
 *
 * MCP 支持返回多种内容类型：
 * - TextContent: { type: 'text', text: string }
 * - ImageContent: { type: 'image', data: string, mimeType: string }
 * - EmbeddedResource: { type: 'resource', uri: string, ... }
 *
 * @param mcpResult MCP 工具调用结果
 * @returns 标准工具结果
 */
export function mcpResultToToolResult(mcpResult: McpToolCallResult): ToolResult {
    // 成功和失败都可能包含截图、来源和结构化详情，统一读取后再标记结果状态。
    const textContents: string[] = [];
    const multimodalData: MultimodalData[] = [];

    if (mcpResult.content) {
        for (const content of mcpResult.content) {
            switch (content.type) {
                case 'text':
                    if (content.text) {
                        textContents.push(content.text);
                    }
                    break;

                case 'image':
                case 'audio':
                    // MCP 图片内容
                    if (content.data) {
                        multimodalData.push({
                            mimeType: content.mimeType || (content.type === 'audio' ? 'audio/wav' : 'image/png'),
                            data: content.data,
                            name: content.uri
                        });
                    }
                    break;

                case 'resource':
                    // 嵌入资源 - 可能包含文本或二进制数据
                    if (content.resource?.text !== undefined || content.text !== undefined) {
                        textContents.push(content.resource?.text ?? content.text ?? '');
                    } else if (content.resource?.blob || content.data) {
                        multimodalData.push({
                            mimeType: content.resource?.mimeType || content.mimeType || 'application/octet-stream',
                            data: content.resource?.blob || content.data!,
                            name: content.resource?.uri || content.uri
                        });
                    }
                    break;
                case 'resource_link':
                    if (content.uri) {
                        textContents.push([content.name, content.uri, content.description].filter(Boolean).join('\n'));
                    }
                    break;
            }
        }
    }

    const text = textContents.join('\n');
    const mirroredJson = mcpResult.structuredContent !== undefined && textContents.length === 1
        && mcpResult.content?.some(content => content.type === 'text' && content.text === text)
        && isMirroredJsonText(text, mcpResult.structuredContent);
    if (mcpResult.isError || !mcpResult.success) {
        const error = mcpResult.error || (!mirroredJson && text) || (mirroredJson ? 'MCP tool returned an error' : 'Unknown error');
        const details: Record<string, unknown> = {};
        if (mcpResult.executionStatus) details.executionStatus = mcpResult.executionStatus;
        if (mcpResult.inputRequired) details.inputRequired = mcpResult.inputRequired;
        if (mcpResult.structuredContent !== undefined) details.structuredContent = mcpResult.structuredContent;
        if (text && text !== error && !mirroredJson) details.text = text;
        return { success: false, error,
            ...(Object.keys(details).length ? { data: details } : {}),
            ...(multimodalData.length ? { multimodal: multimodalData } : {}) };
    }

    return {
        success: true,
        data: mcpResult.structuredContent !== undefined
            ? (textContents.length > 0
                ? { ...(!mirroredJson ? { text } : {}), structuredContent: mcpResult.structuredContent }
                : mcpResult.structuredContent)
            : (textContents.length > 0 ? text : undefined),
        multimodal: multimodalData.length > 0 ? multimodalData : undefined
    };
}

/** 只忽略字符串外的排版空白，不通过解析后的数值比较丢掉原文数字精度。 */
function isMirroredJsonText(text: string, value: unknown): boolean {
    try {
        JSON.parse(text);
        return text.replace(/("(?:[^"\\]|\\.)*")|\s+/g, (_match, quoted: string | undefined) => quoted ?? '') === JSON.stringify(value);
    } catch { return false; }
}
