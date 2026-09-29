import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { loadDiffContent, onMessageFromExtension } from '../../utils/vscode'

const { post } = vi.hoisted(() => ({ post: vi.fn() }))
vi.mock('../../utils/hostTransport', () => ({ getHostTransport: () => ({ postMessage: post, getState() {}, setState() {} }) }))
let unsubscribe: () => void
beforeEach(() => { post.mockReset(); unsubscribe = onMessageFromExtension(() => {}) })
afterEach(() => unsubscribe())

function respond(data: unknown) {
  const requestId = post.mock.calls.at(-1)![0].requestId
  window.dispatchEvent(new MessageEvent('message', { data: { requestId, success: true, data } }))
}

test.each([['', 'created'], ['removed', ''], ['', '']])('原文 %s 与新文 %s 均接受合法空字符串', async (originalContent, newContent) => {
  const pending = loadDiffContent('diff-empty')
  respond({ success: true, originalContent, newContent, filePath: 'source.txt' })
  expect(await pending).toEqual({ originalContent, newContent, filePath: 'source.txt' })
})

test('宿主返回的读取失败保留原始原因，交给卡片显示和重试', async () => {
  const pending = loadDiffContent('missing')
  const requestId = post.mock.calls.at(-1)![0].requestId
  window.dispatchEvent(new MessageEvent('message', { data: { requestId, success: false, error: { message: '这份差异已被清理' } } }))
  await expect(pending).rejects.toThrow('这份差异已被清理')
})
