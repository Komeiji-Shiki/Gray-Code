/**
 * toolLocalization 测试
 *
 * 覆盖：
 * - 有 i18n 条目的内置工具：显示名/描述返回本地化文案（默认语言 zh-CN）
 * - 无条目的工具（如 MCP 外部工具）：显示名机械转换（snake_case → Title Case）、描述回退原文
 * - MCP 工具：通过 codec 解码出原始工具名后机械转换（serverId/toolName 含下划线也能正确解析）
 */
import { describe, it, expect } from 'vitest'
import { getToolDisplayName, getToolDescription } from '../toolLocalization'

describe('getToolDisplayName', () => {
  it('有 i18n 条目的内置工具返回本地化名称', () => {
    expect(getToolDisplayName('read_file')).toBe('读取文件')
    expect(getToolDisplayName('apply_diff')).toBe('应用diff')
    expect(getToolDisplayName('get_activity_stats')).toBe('获取活动统计')
  })

  it('无 i18n 条目的工具回退为机械转换（snake_case → Title Case）', () => {
    expect(getToolDisplayName('custom_tool')).toBe('Custom Tool')
  })

  it('MCP 工具解码出原始工具名后机械转换（不再显示编码名/serverId）', () => {
    expect(getToolDisplayName('mcp__some_server__tool')).toBe('Tool')
    // serverId 含下划线也能正确解析
    expect(getToolDisplayName('mcp__server_a__search')).toBe('Search')
    expect(getToolDisplayName('mcp__mcp_1785407697930_5wldv41__Search')).toBe('Search')
    // toolName 含双下划线不会被 split 截断（naive split('__') 会得到 "My"）
    expect(getToolDisplayName('mcp__server__my__tool')).toBe('My Tool')
  })

  it('非标准 MCP 名称（无法解码）回退为机械转换', () => {
    expect(getToolDisplayName('mcp__server')).toBe('Mcp Server')
    // 缺少第二个分隔符（serverId/toolName 之间为单下划线）→ 不是合法 MCP 编码名，回退机械转换
    expect(getToolDisplayName('mcp__some_server_tool')).toBe('Mcp Some Server Tool')
  })
})

describe('getToolDescription', () => {
  it('有 i18n 条目的内置工具返回本地化描述', () => {
    expect(getToolDescription('read_file', 'en fallback')).toContain('读取工作区文件')
    expect(getToolDescription('get_activity_stats', 'en fallback')).toContain('使用时间统计')
    expect(getToolDescription('sandbox', 'en fallback')).toContain('隔离的沙箱')
  })

  it('无 i18n 条目的工具回退后端原文', () => {
    expect(getToolDescription('mcp__external', 'Server provided description')).toBe('Server provided description')
  })
})
