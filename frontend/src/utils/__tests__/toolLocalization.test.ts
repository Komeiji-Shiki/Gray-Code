/**
 * toolLocalization 测试
 *
 * 覆盖：
 * - 有 i18n 条目的内置工具：显示名/描述返回本地化文案（默认语言 zh-CN）
 * - 无条目的工具（如 MCP 外部工具）：显示名机械转换（snake_case → Title Case）、描述回退原文
 */
import { describe, it, expect } from 'vitest'
import { getToolDisplayName, getToolDescription } from '../toolLocalization'

describe('getToolDisplayName', () => {
  it('有 i18n 条目的内置工具返回本地化名称', () => {
    expect(getToolDisplayName('read_file')).toBe('读取文件')
    expect(getToolDisplayName('apply_diff')).toBe('应用差异')
  })

  it('无 i18n 条目的工具回退为机械转换（snake_case → Title Case）', () => {
    expect(getToolDisplayName('mcp__some_server_tool')).toBe('Mcp Some Server Tool')
    expect(getToolDisplayName('custom_tool')).toBe('Custom Tool')
  })
})

describe('getToolDescription', () => {
  it('有 i18n 条目的内置工具返回本地化描述', () => {
    expect(getToolDescription('read_file', 'en fallback')).toContain('读取工作区文件')
  })

  it('无 i18n 条目的工具回退后端原文', () => {
    expect(getToolDescription('mcp__external', 'Server provided description')).toBe('Server provided description')
  })
})
