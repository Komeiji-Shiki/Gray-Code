import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { loadDiffContent, onMessageFromExtension, sendToExtension } from '../../utils/vscode'
import { isProxy, reactive, readonly, toRaw } from 'vue'
import { prepareHostPayload } from '@shared/hostPayload'
import { call } from '../../../../apps/client/src/api'

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

test('宿主 payload 仅复制代理分支，普通附件保持引用且可结构化克隆', async () => {
  const attachment = { data: 'BASE64_DATA'.repeat(20_000) }
  const data = { options: { whitelist: readonly(reactive(['read_file'])) }, attachment }
  const pending = sendToExtension('settings.fixture', data)
  const sent = post.mock.calls.at(-1)![0].data
  expect(sent).not.toBe(data)
  expect(sent.options).not.toBe(data.options)
  expect(sent.attachment).toBe(attachment)
  expect(isProxy(sent.options.whitelist)).toBe(false)
  expect(structuredClone(sent)).toEqual(JSON.parse(JSON.stringify(data)))
  respond({ success: true })
  await pending
  const plain = { focused: true }
  expect(prepareHostPayload(plain, value => isProxy(value) ? toRaw(value) : value)).toBe(plain)
})

test('代理与非 JSON 数据混用时保留根转换，循环引用照常拒绝', () => {
  const unwrap = (value: object) => isProxy(value) ? toRaw(value) : value
  const values = [
    { proxy: reactive({ enabled: true }), missing: undefined, number: Number.NaN, array: [undefined, , 1] },
    { proxy: reactive({ enabled: true }), date: new Date(0), map: new Map([['key', 1]]), set: new Set([1]), callback: () => {} },
    { __v_raw: { untouched: true }, name: '普通字段' },
  ]
  for (const value of values) expect(prepareHostPayload(value, unwrap)).toEqual(JSON.parse(JSON.stringify(value)))
  expect(() => prepareHostPayload({ proxy: reactive({ enabled: true }), bigint: 1n }, unwrap)).toThrow()
  const cycle: { self?: unknown } = {}
  cycle.self = cycle
  expect(() => prepareHostPayload(cycle, unwrap)).toThrow()
})

test('桌面资源上传的代理字段解包时保留原二进制缓冲', async () => {
  const previous = window.graycode
  const invoke = vi.fn().mockResolvedValue({ ok: true, value: 'done' })
  window.graycode = { kind: 'desktop', call: invoke, subscribe: () => () => {} }
  const bytes = new Uint8Array([1, 2, 3])
  try {
    expect(await call('files.upload', { workspaceId: 'w', path: 'a.bin', bytes, extra: reactive({ value: '描述' }) })).toBe('done')
    expect(invoke.mock.calls[0][1].bytes).toBe(bytes)
    expect(isProxy(invoke.mock.calls[0][1].extra)).toBe(false)
  } finally { window.graycode = previous }
})
