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
    // 处理错误情况
    if (mcpResult.isError || !mcpResult.success) {
        const errorText = mcpResult.error ||
            mcpResult.content
                ?.filter(c => c.type === 'text')
                .map(c => c.text)
                .join('\n') ||
            'Unknown error';
        
        return {
            success: false,
            error: errorText
        };
    }

    // 处理成功响应
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
                    // MCP 图片内容
                    if (content.data) {
                        multimodalData.push({
                            mimeType: content.mimeType || 'image/png',
                            data: content.data,
                            name: content.uri
                        });
                    }
                    break;

                case 'resource':
                    // 嵌入资源 - 可能包含文本或二进制数据
                    if (content.text) {
                        textContents.push(content.text);
                    } else if (content.data) {
                        multimodalData.push({
                            mimeType: content.mimeType || 'application/octet-stream',
                            data: content.data,
                            name: content.uri
                        });
                    }
                    break;
            }
        }
    }

    return {
        success: true,
        data: textContents.length > 0 ? textContents.join('\n') : undefined,
        multimodal: multimodalData.length > 0 ? multimodalData : undefined
    };
}


