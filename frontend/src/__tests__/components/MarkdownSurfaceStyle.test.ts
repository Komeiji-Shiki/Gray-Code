import { readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vitest'

const source = readFileSync(path.resolve(process.cwd(), 'src/components/common/MarkdownRenderer.vue'), 'utf8')
const rule = (selector: string) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/,\s*/g, ',\\s*')
  return [...source.matchAll(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 'g'))].map(match => match[1]).join(';')
}

test('表格是圆角填充面板，只保留淡的横向行线', () => {
  const table = rule('.markdown-content :deep(table)')
  expect(table).toMatch(/border-collapse:\s*separate/)
  expect(table).toMatch(/border-radius:\s*var\(--gc-radius-lg\)/)
  expect(table).toMatch(/background:\s*var\(--gc-surface-raised\)/)
  const cells = rule('.markdown-content :deep(th), .markdown-content :deep(td)')
  expect(cells).not.toMatch(/border:\s*1px solid/)
  expect(cells).toMatch(/border-bottom:\s*1px solid var\(--gc-border-subtle\)/)
  expect(rule('.markdown-content :deep(tbody tr:last-child td)')).toMatch(/border-bottom:\s*0/)
})

test('代码块标题与正文不再描边，圆角与卡片一致', () => {
  const header = rule('.markdown-content :deep(.code-block-header)')
  const body = rule('.markdown-content :deep(.code-block-container pre.code-block-wrapper)')
  for (const part of [header, body]) {
    expect(part).not.toMatch(/border:\s*1px solid var\(--gc-border-subtle\)/)
    expect(part).toMatch(/var\(--gc-radius-lg\)/)
  }
})

test('引用块右侧圆角，左侧保留引用色条', () => {
  const quote = rule('.markdown-content :deep(blockquote)')
  expect(quote).toMatch(/border-left:\s*3px solid/)
  expect(quote).toMatch(/border-radius:\s*0 var\(--gc-radius-md\) var\(--gc-radius-md\) 0/)
})
