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

  it('parses binary attribute case-insensitively', () => {
    const parsed = parseMessageToNodes('<lim-context type="file" title="image" binary="TRUE">ignored</lim-context>')

    expect(parsed.contexts[0].isTextContent).toBe(false)
    expect(parsed.contexts[0].content).toBe('')
  })
})
