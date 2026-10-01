import { readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vitest'

const item = readFileSync(path.resolve(process.cwd(), 'src/components/message/MessageItem.vue'), 'utf8')
const footer = readFileSync(path.resolve(process.cwd(), 'src/components/message/messageItem/MessageFooter.vue'), 'utf8')

test('统计信息常时显示，楼层号在悬停、聚焦或最后一条消息上显示', () => {
  expect(item).toMatch(/\.message-floor\s*\{[^}]*opacity:\s*0/)
  expect(item).toMatch(/\.message-item:hover \.message-floor/)
  // 最后一条消息之后可能还跟着检查点等元素，按“后面没有其他消息”判断而不是 :last-child。
  expect(item).toContain('.message-item:not(:has(~ .message-item)) .message-floor')
  expect(item).not.toMatch(/:deep\(\.message-footer\)\s*\{[^}]*opacity:\s*0/)
})

test('用户消息为右对齐浅底块，不再有强调色描边', () => {
  expect(item).toMatch(/\.user-message\s*\{[^}]*margin:[^;]*auto;/)
  expect(item).not.toMatch(/\.user-message\s*\{[^}]*--gc-link/)
  expect(footer).toMatch(/\.message-footer\s*\{[^}]*margin-top:\s*var\(--gc-space-2\)/)
})
