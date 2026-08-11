/**
 * MCP 工具名称编解码器 (WP12)
 *
 * 统一单一来源：编解码逻辑已迁入 shared/mcpToolNameCodec.ts（跨端唯一事实源），
 * 本文件仅作 re-export，保持既有导入方（McpManager / toolAdapter / subagents /
 * tool-execution/result.ts / mcp/index.ts / 测试）import 不破。
 *
 * 导出面与迁移前完全一致：
 *   MCP_TOOL_PREFIX / MCP_TOOL_SEPARATOR / MCP_SERVER_ID_PATTERN /
 *   encodeMcpToolName / decodeMcpToolName / isMcpToolName
 */
export * from '../../../shared/mcpToolNameCodec';
