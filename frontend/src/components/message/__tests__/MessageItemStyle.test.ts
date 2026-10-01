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

test('用户消息恢复铺满可用宽度，沿用正常两侧内边距', () => {
  const userStyle = item.match(/\.user-message\s*\{([^}]*)\}/)?.[1]
  expect(userStyle).toBeDefined()
  expect(item).toMatch(/\.user-message,\s*\.assistant-message\s*\{[^}]*align-self:\s*stretch/)
  expect(item).toMatch(/\.message-item\s*\{[^}]*padding:\s*var\(--gc-space-2\) var\(--gc-space-4\)/)
  expect(userStyle).toMatch(/margin:\s*var\(--gc-space-3\) 0 var\(--gc-space-2\);/)
  expect(userStyle).not.toMatch(/(?:min-|max-)?width:|padding:|\bauto\b|fit-content|85%|760px/)
})

test('连接区去内部卡片间距，保留首尾留白且不依赖包裹节点', () => {
  expect(item).toMatch(/\.message-item\.message-input-group\s*\{[^}]*margin:\s*0;/)
  expect(item).toMatch(/\.message-item\.message-input-group\s*\{[^}]*padding:\s*var\(--gc-space-1\) var\(--gc-space-4\)/)
  expect(item).toMatch(/\.message-input-group :deep\(\.background-task-card\)\s*\{[^}]*margin:\s*0;/)
  expect(item).toContain('.message-item.message-input-group-start')
  expect(item).toContain('.message-item.message-input-group-end')
  expect(item).toContain('<div v-if="!isBackgroundTask" class="message-header">')
  expect(item).toContain('<template #actions>')
  expect(item).toContain('.message-item:focus-within :deep(.message-actions)')
})

test('用户消息保留浅底，不再有强调色描边', () => {
  expect(item).toMatch(/\.user-message\s*\{[^}]*background:\s*var\(--gc-surface-raised\)/)
  expect(item).not.toMatch(/\.user-message\s*\{[^}]*--gc-link/)
  expect(footer).toMatch(/\.message-footer\s*\{[^}]*margin-top:\s*var\(--gc-space-2\)/)
})
