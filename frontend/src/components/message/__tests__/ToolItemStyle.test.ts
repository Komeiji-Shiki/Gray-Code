import { readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vitest'

const item = readFileSync(path.resolve(process.cwd(), 'src/components/message/toolMessage/ToolItem.vue'), 'utf8')
const style = item.split('<style scoped>')[1].split('</style>')[0]
const compactSelector = '.tool-item:is(.status-success, .status-error, .status-warning):not(:has(.permission-request))'

function rule(selector: string, source = style): string {
  const start = source.indexOf(`${selector} {`)
  expect(start).toBeGreaterThanOrEqual(0)
  return source.slice(start, source.indexOf('}', start) + 1)
}

test('长摘要只压缩自己的空间，不把工具名称、状态和操作挤成竖排', () => {
  expect(rule('.tool-summary')).toMatch(/min-width:\s*0/)
  expect(rule('.tool-info')).toMatch(/flex:\s*0 0 auto/)
  expect(rule('.tool-info')).toMatch(/flex-wrap:\s*wrap/)
  expect(rule('.tool-name')).toMatch(/flex:\s*0 0 auto/)
  expect(rule('.tool-name')).toMatch(/white-space:\s*nowrap/)
  expect(rule('.tool-name')).not.toContain('overflow-wrap: anywhere')
  expect(rule('.status-icon-wrapper')).toMatch(/flex-shrink:\s*0/)
  expect(rule('.tool-approval-badge')).toMatch(/flex-shrink:\s*0/)
  expect(rule('.tool-duration')).toMatch(/flex-shrink:\s*0/)
  expect(rule('.tool-action-buttons')).toMatch(/flex-shrink:\s*0/)

  const description = rule(`${compactSelector} .tool-description`)
  expect(description).toMatch(/flex:\s*1 1 0/)
  expect(description).toMatch(/min-width:\s*0/)
  expect(description).toMatch(/overflow:\s*hidden/)
  expect(description).toMatch(/text-overflow:\s*ellipsis/)
  expect(description).toMatch(/white-space:\s*nowrap/)
})

test('窄分栏与缩放按工具卡片宽度堆叠摘要及操作，不依赖窗口断点', () => {
  expect(rule('.tool-item')).toMatch(/container-name:\s*gc-tool-item/)
  expect(rule('.tool-item')).toMatch(/container-type:\s*inline-size/)
  const narrow = style.slice(style.indexOf('@container gc-tool-item'))
  expect(narrow).toContain('(max-width: 32rem)')
  expect(rule('.tool-header', narrow)).toMatch(/flex-direction:\s*column/)
  expect(rule(`${compactSelector} .tool-summary`, narrow)).toMatch(/flex-direction:\s*column/)
  expect(rule(`${compactSelector} .tool-description`, narrow)).toMatch(/flex:\s*none/)
  expect(rule('.tool-action-buttons')).toMatch(/flex-wrap:\s*wrap/)
  expect(style).not.toMatch(/@media\s*\(max-width:/)
})

test('工具头部只引用 gc 语义 token', () => {
  const header = style.slice(style.indexOf('.tool-item {'), style.indexOf('/* 流式参数预览 */'))
  expect(header).not.toMatch(/var\((?!--gc-)/)
})

test('待审批摘要保留完整描述，只有终态摘要收成单行', () => {
  expect(rule('.tool-description')).toMatch(/white-space:\s*pre-wrap/)
  expect(rule('.tool-description')).toMatch(/overflow-wrap:\s*anywhere/)
  expect(rule(`${compactSelector} .tool-summary`)).toMatch(/flex-direction:\s*row/)
})
