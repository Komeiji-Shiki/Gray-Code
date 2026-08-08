/**
 * toolCategory 测试
 *
 * 覆盖：
 * - groupToolsByCategory：按分类分组、缺省/未知分类归入 other、保持工具数组顺序
 * - normalizeToolCategory：分类 key 归一化
 * - getCategoryName / getCategoryIcon：已知分类返回对应文案/图标，未知分类回退「其他」
 */
import { describe, it, expect } from 'vitest'
import {
  groupToolsByCategory,
  normalizeToolCategory,
  getCategoryName,
  getCategoryIcon
} from '../toolCategory'

describe('groupToolsByCategory', () => {
  it('按分类分组并保持工具原有顺序', () => {
    const tools = [
      { name: 'read_file', category: 'file' },
      { name: 'search_in_files', category: 'search' },
      { name: 'write_file', category: 'file' },
      { name: 'execute_command', category: 'terminal' }
    ]
    const grouped = groupToolsByCategory(tools)
    expect(Object.keys(grouped)).toEqual(['file', 'search', 'terminal'])
    expect(grouped.file.map(t => t.name)).toEqual(['read_file', 'write_file'])
    expect(grouped.search.map(t => t.name)).toEqual(['search_in_files'])
  })

  it('缺省分类与未知分类统一归入 other，MCP 保持独立分组', () => {
    const tools = [
      { name: 'no_category', category: undefined },
      { name: 'unknown_category', category: 'whatever' },
      { name: 'mcp_tool', category: 'mcp' }
    ]
    const grouped = groupToolsByCategory(tools)
    expect(Object.keys(grouped)).toEqual(['other', 'mcp'])
    expect(grouped.other.map(t => t.name)).toEqual(['no_category', 'unknown_category'])
  })

  it('空数组返回空分组', () => {
    expect(groupToolsByCategory([])).toEqual({})
  })
})

describe('normalizeToolCategory', () => {
  it('已知分类原样返回，缺省/未知分类归入 other', () => {
    expect(normalizeToolCategory('file')).toBe('file')
    expect(normalizeToolCategory('mcp')).toBe('mcp')
    expect(normalizeToolCategory(undefined)).toBe('other')
    expect(normalizeToolCategory('')).toBe('other')
    expect(normalizeToolCategory('whatever')).toBe('other')
  })
})

describe('getCategoryName / getCategoryIcon', () => {
  it('已知分类返回本地化名称与图标', () => {
    expect(getCategoryName('file')).toBe('文件操作')
    expect(getCategoryName('mcp')).toBe('MCP 工具')
    expect(getCategoryName('sandbox')).toBe('沙箱')
    expect(getCategoryIcon('file')).toBe('codicon-file')
    expect(getCategoryIcon('mcp')).toBe('codicon-plug')
    expect(getCategoryIcon('sandbox')).toBe('codicon-terminal')
  })

  it('未知分类回退「其他」文案与默认图标', () => {
    expect(getCategoryName('whatever')).toBe('其他')
    expect(getCategoryIcon('whatever')).toBe('codicon-extensions')
  })
})
