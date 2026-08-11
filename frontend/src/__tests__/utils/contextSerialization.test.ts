import { describe, expect, it } from 'vitest'
import { createContextNode } from '../../types/editorNode'
import { serializeNodes } from '../../types/editorNode'
import { parseMessageToNodes } from '../../types/contextParser'

function context(overrides: Partial<Parameters<typeof createContextNode>[0]> = {}) {
  return createContextNode({
    id: 'ctx-1',
    type: 'file',
    title: 'a "quoted" <title>',
    content: 'before </lim-context> after & more',
    filePath: 'dir/a&b.ts',
    language: 'typescript',
    isTextContent: true,
    enabled: true,
    addedAt: 1,
    ...overrides
  })
}

describe('context node serialization', () => {
  it('escapes attributes and closing-tag-like content, then decodes it on parse', () => {
    const serialized = serializeNodes([context()])

    expect(serialized).toContain('title="a &quot;quoted&quot; &lt;title&gt;"')
    expect(serialized).toContain('before &lt;/lim-context&gt; after & more')

    const parsed = parseMessageToNodes(serialized)
    expect(parsed.contexts).toHaveLength(1)
    expect(parsed.contexts[0].title).toBe('a "quoted" <title>')
    expect(parsed.contexts[0].content).toBe('before </lim-context> after & more')
    expect(parsed.contexts[0].filePath).toBe('dir/a&b.ts')
  })

  it('escapes opening lim-context tags in content to avoid parse drift, then decodes them back', () => {
    // 开标签转义：正文中的 <lim-context ...>（后随空白或 >）若原样保留，解析侧会把它当作
    // 新的上下文块起点，造成“序列化 → 解析 → 再序列化”漂移。此处验证转义与还原的往返一致性。
    const serialized = serializeNodes([context({ content: 'see <lim-context type="file"> below' })])

    // 开标签被转义，闭标签本身（序列化器生成的）不被误伤
    expect(serialized).toContain('see &lt;lim-context type="file"> below')
    expect(serialized).toContain('<lim-context type="file"')

    const parsed = parseMessageToNodes(serialized)
    // 转义后的开标签不会开启新的上下文块
    expect(parsed.contexts).toHaveLength(1)
    expect(parsed.contexts[0].content).toBe('see <lim-context type="file"> below')
  })

  it('parses binary attribute case-insensitively', () => {
    const parsed = parseMessageToNodes('<lim-context type="file" title="image" binary="TRUE">ignored</lim-context>')

    expect(parsed.contexts[0].isTextContent).toBe(false)
    expect(parsed.contexts[0].content).toBe('')
  })
})
