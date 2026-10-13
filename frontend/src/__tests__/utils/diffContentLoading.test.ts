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
  expect(prepareHostPayload(plain, toRaw)).toBe(plain)
})

test('解除代理不改写值，正式传输保留特殊值和循环关系', () => {
  const value = {
    proxy: reactive({ enabled: true }), missing: undefined, number: Number.NaN, array: [undefined, , 1],
    date: new Date(0), map: new Map([['key', 1]]), set: new Set([1]), bigint: 1n,
    customBody: { json: '{"__v_raw":{"untouched":true}}' }, name: '普通字段'
  }
  const prepared = prepareHostPayload(value, toRaw)
  expect(isProxy(prepared.proxy)).toBe(false)
  expect(prepared.missing).toBeUndefined()
  expect(Object.hasOwn(prepared, 'missing')).toBe(true)
  expect(prepared.number).toBeNaN()
  expect(prepared.date).toBe(value.date)
  expect(prepared.map).toBe(value.map)
  expect(prepared.set).toBe(value.set)
  expect(prepared.bigint).toBe(1n)
  expect(prepared.customBody.json).toBe(value.customBody.json)
  expect(1 in prepared.array).toBe(false)
  const cloned = structuredClone(prepared)
  expect(cloned.proxy.enabled).toBe(true)
  expect(Object.hasOwn(cloned, 'missing')).toBe(true)
  expect(cloned.number).toBeNaN()
  expect(cloned.date.getTime()).toBe(0)
  expect(cloned.map.get('key')).toBe(1)
  expect(cloned.set.has(1)).toBe(true)
  expect(cloned.bigint).toBe(1n)
  expect(1 in cloned.array).toBe(false)
  expect(cloned.customBody.json).toBe(value.customBody.json)
  const cycle: { self?: unknown } = {}
  cycle.self = cycle
  const copied = prepareHostPayload(cycle, toRaw)
  expect(copied.self).toBe(copied)
})

test('没有代理的对象图和循环直接复用，不创建后丢弃数据副本', () => {
  const value = { fields: { enabled: true }, items: [1, , 3], self: undefined as unknown }
  value.self = value
  const create = vi.spyOn(Object, 'create')
  const define = vi.spyOn(Object, 'defineProperty')
  let prepared: typeof value
  let created: number
  let defined: number
  try {
    prepared = prepareHostPayload(value, toRaw)
    created = create.mock.calls.length
    defined = define.mock.calls.length
  } finally {
    create.mockRestore()
    define.mockRestore()
  }
  expect(prepared).toBe(value)
  expect(prepared.self).toBe(prepared)
  expect(created).toBe(0)
  expect(defined).toBe(0)
})

test.each([false, true])('代理先出现=%s时，共享节点和循环仍指向同一副本', proxyFirst => {
  const node = { owner: undefined as unknown, enabled: true }
  const proxy = reactive(node)
  const attachment = { data: 'unchanged' }
  const value = proxyFirst ? { proxy, node, attachment } : { node, proxy, attachment }
  node.owner = value
  const prepared = prepareHostPayload(value, toRaw)
  expect(prepared).not.toBe(value)
  expect(prepared.node).not.toBe(node)
  expect(prepared.proxy).toBe(prepared.node)
  expect(prepared.node.owner).toBe(prepared)
  expect(prepared.attachment).toBe(attachment)
  expect(isProxy(prepared.proxy)).toBe(false)
  expect(node.owner).toBe(value)
})

test('不可克隆的参数由正式发送拒绝，不用JSON改写后重试', async () => {
  post.mockImplementationOnce((message: unknown) => structuredClone(message))
  await expect(sendToExtension('settings.fixture', { callback: () => {} })).rejects.toThrow()
  expect(post).toHaveBeenCalledTimes(1)
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
