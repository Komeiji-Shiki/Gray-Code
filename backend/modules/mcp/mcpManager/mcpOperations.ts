/**
 * GrayCode MCP 操作执行层
 *
 * 从 McpManager 抽离：工具调用 / 资源读取 / 提示获取的底层执行逻辑。
 * 纯执行函数：接收 clients 映射与运行时信息，不持有 McpManager 实例状态。
 */

import { t } from '../../../i18n';
import type {
    McpServerInfo,
    McpToolCallRequest,
    McpToolCallResult,
    McpResourceReadRequest,
    McpResourceContent,
    McpPromptGetRequest,
    McpPromptMessage
} from '../types';
import type { StdioMcpClient } from '../StdioClient';
import type { HttpMcpClient } from '../HttpClient';

type McpClient = StdioMcpClient | HttpMcpClient;

/**
 * 执行工具调用
 */
export async function performToolCall(
    clients: Map<string, McpClient>,
    info: McpServerInfo,
    request: McpToolCallRequest
): Promise<McpToolCallResult> {
    const client = clients.get(info.config.id);
    if (!client) {
        return {
            success: false,
            error: t('modules.mcp.errors.clientNotConnected')
        };
    }

    // 调用前校验工具存在性：服务器声明了工具列表（非空）时，未知工具名直接失败，
    // 避免把过期缓存/拼写错误中的工具名发给服务器（服务器端错误文案通常不直观）。
    // 列表为空（未声明或未拉到）时不拦截，保持原有透传行为。
    if (Array.isArray(info.capabilities?.tools) && info.capabilities.tools.length > 0) {
        const tool = info.capabilities.tools.find(t => t.name === request.toolName);
        if (!tool) {
            return {
                success: false,
                error: `Tool "${request.toolName}" not found on MCP server "${info.config.name}"`
            };
        }
    }
    
    try {
        const result = await client.callTool(request.toolName, request.arguments, request.signal);
        return {
            success: !result.isError,
            // 透传 uri：McpToolCallResult.content 类型契约声明了 uri?（types.ts），
            // 服务器返回 resource 类型内容时携带的 uri 不能在此被丢弃
            content: (result.content || []).map(c => ({
                type: c.type as 'text' | 'image' | 'resource',
                text: c.text,
                data: c.data,
                mimeType: c.mimeType,
                uri: c.uri
            })),
            isError: result.isError
        };
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : t('modules.mcp.errors.toolCallFailed')
        };
    }
}

/**
 * 执行资源读取
 */
export async function performResourceRead(
    clients: Map<string, McpClient>,
    info: McpServerInfo,
    request: McpResourceReadRequest
): Promise<McpResourceContent | null> {
    const client = clients.get(info.config.id);
    if (!client) {
        throw new Error(t('modules.mcp.errors.clientNotConnected'));
    }
    
    const result = await client.readResource(request.uri, request.signal);
    const contents = result.contents || [];
    if (contents.length === 0) {
        return null;
    }
    
    // 返回全部内容：多段文本聚合为一段（按换行连接），避免只取 contents[0]
    // 丢失服务器返回的其余内容；无文本内容（如纯 blob）时退回首个内容的原始字段。
    // uri 不能只取 first.uri：首段可能是 blob、文本来自后续段（来源错标），或
    // 多段文本来源不同（静默丢弃）。各文本段 uri 一致时直接采用；不一致时按段
    // 以 "[uri] " 前缀标注进聚合文本（结果类型只支持单一 uri，无法逐一表达）。
    const first = contents[0];
    const textContents = contents.filter(c => typeof c.text === 'string');
    const textUris = Array.from(new Set(textContents.map(c => c.uri)));
    const singleUri = textUris.length === 1;
    return {
        uri: singleUri ? textUris[0] : first.uri,
        mimeType: first.mimeType,
        text: textContents.length > 0
            ? textContents.map(c => (singleUri ? c.text as string : `[${c.uri}] ${c.text as string}`)).join('\n')
            : first.text,
        blob: first.blob
    };
}

/**
 * 执行提示获取
 */
export async function performPromptGet(
    clients: Map<string, McpClient>,
    info: McpServerInfo,
    request: McpPromptGetRequest
): Promise<McpPromptMessage[]> {
    const client = clients.get(info.config.id);
    if (!client) {
        throw new Error(t('modules.mcp.errors.clientNotConnected'));
    }
    
    const result = await client.getPrompt(request.promptName, request.arguments, request.signal);
    return result.messages.map(m => ({
        role: m.role as 'user' | 'assistant',
        content: {
            type: m.content.type as 'text' | 'image' | 'resource',
            text: m.content.text
        }
    }));
}
