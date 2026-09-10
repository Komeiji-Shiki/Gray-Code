import { describe, expect, test, vi, beforeEach } from 'vitest'

vi.mock('@/utils/vscode', () => ({
  sendToExtension: vi.fn()
}))

import { sendToExtension } from '@/utils/vscode'
import {
  MCP_BROWSE_REQUESTS,
  extractRpcErrorMessage,
  isMissingHandlerError,
  isBrowsableStatus,
  normalizeResourcesPayload,
  normalizePromptsPayload,
  toResourceView,
  toPromptMessageViews,
  normalizePromptArgs,
  findMissingRequiredArg,
  fetchMcpResources,
  fetchMcpPrompts,
  fetchMcpResourceContent,
  fetchMcpPromptMessages
} from '../mcpBrowse'

const mockedSend = vi.mocked(sendToExtension)

beforeEach(() => {
  mockedSend.mockReset()
})

describe('mcpBrowse 错误原文与宿主判定', () => {
  test('extractRpcErrorMessage 保留后端原文', () => {
    expect(extractRpcErrorMessage(new Error('MCP 服务器不存在：x'))).toBe('MCP 服务器不存在：x')
    expect(extractRpcErrorMessage('plain')).toBe('plain')
    expect(extractRpcErrorMessage({ message: 'wrapped' })).toBe('wrapped')
    expect(extractRpcErrorMessage({ error: { message: 'nested' } })).toBe('nested')
  })

  test('isMissingHandlerError 识别 VSCode 缺处理器与桌面缺接线', () => {
    expect(isMissingHandlerError(new Error('Unknown message type: mcp.listResources'))).toBe(true)
    expect(isMissingHandlerError(new Error('UNKNOWN_TYPE'))).toBe(true)
    expect(isMissingHandlerError(new Error('桌面宿主尚未接入此接口：mcp.listResources'))).toBe(true)
    expect(isMissingHandlerError(new Error('MCP 服务器不存在：x'))).toBe(false)
  })

  test('isBrowsableStatus 仅 connected 可展开', () => {
    expect(isBrowsableStatus('connected')).toBe(true)
    expect(isBrowsableStatus('disconnected')).toBe(false)
    expect(isBrowsableStatus('error')).toBe(false)
    expect(isBrowsableStatus('connecting')).toBe(false)
  })
})

describe('mcpBrowse 列表整形', () => {
  test('normalizeResourcesPayload 过滤非法条目并保留状态与错误', () => {
    const out = normalizeResourcesPayload({
      success: true,
      resources: [
        {
          serverId: 's1',
          serverName: 'S One',
          status: 'connected',
          resources: [
            { uri: 'file:///a', name: 'A', mimeType: 'text/plain' },
            { uri: '', name: 'bad' },
            null
          ]
        },
        { serverId: '', serverName: 'bad', status: 'connected', resources: [] },
        {
          serverId: 's2',
          serverName: 'S Two',
          status: 'disconnected',
          lastError: 'connect failed',
          resources: []
        }
      ]
    })
    expect(out).toHaveLength(2)
    expect(out[0].serverId).toBe('s1')
    expect(out[0].resources).toHaveLength(1)
    expect(out[0].resources[0].uri).toBe('file:///a')
    expect(out[1].status).toBe('disconnected')
    expect(out[1].lastError).toBe('connect failed')
  })

  test('normalizePromptsPayload 保留参数定义', () => {
    const out = normalizePromptsPayload({
      success: true,
      prompts: [
        {
          serverId: 's1',
          serverName: 'S',
          status: 'connected',
          prompts: [
            { name: 'p1', description: 'd', arguments: [{ name: 'q', required: true }] },
            { name: '', description: 'bad' }
          ]
        }
      ]
    })
    expect(out).toHaveLength(1)
    expect(out[0].prompts).toHaveLength(1)
    expect(out[0].prompts[0].arguments?.[0]).toMatchObject({ name: 'q', required: true })
  })

  test('空/非法 payload 返回空数组而不抛错', () => {
    expect(normalizeResourcesPayload(null)).toEqual([])
    expect(normalizeResourcesPayload({})).toEqual([])
    expect(normalizePromptsPayload(undefined)).toEqual([])
  })
})

describe('mcpBrowse 内容视图', () => {
  test('toResourceView 文本直接展示', () => {
    const view = toResourceView({ uri: 'u', mimeType: 'text/plain', text: 'hello' }, 'u')
    expect(view).toMatchObject({ kind: 'text', text: 'hello', uri: 'u' })
  })

  test('toResourceView 图片走附件形式（data URL）', () => {
    const view = toResourceView({ uri: 'u', mimeType: 'image/png', blob: 'AAA=' }, 'u')
    expect(view.kind).toBe('image')
    expect(view.imageUrl).toBe('data:image/png;base64,AAA=')
  })

  test('toResourceView 空内容返回 empty', () => {
    expect(toResourceView({ uri: 'u' }, 'u').kind).toBe('empty')
    expect(toResourceView(null, 'u')).toMatchObject({ kind: 'empty', uri: 'u' })
  })

  test('toPromptMessageViews 覆盖文本/图片/resource', () => {
    const views = toPromptMessageViews([
      { role: 'user', content: { type: 'text', text: 'hi' } },
      { role: 'assistant', content: { type: 'image', data: 'BBB=', mimeType: 'image/png' } },
      { role: 'assistant', content: { type: 'resource', text: 'res', uri: 'u' } }
    ])
    expect(views[0]).toMatchObject({ role: 'user', kind: 'text', text: 'hi' })
    expect(views[1].kind).toBe('image')
    expect(views[1].imageUrl).toBe('data:image/png;base64,BBB=')
    expect(views[2]).toMatchObject({ kind: 'resource', text: 'res' })
  })
})

describe('mcpBrowse 提示参数', () => {
  test('normalizePromptArgs 仅保留字符串', () => {
    expect(normalizePromptArgs({ a: '1', b: 2 as unknown as string, c: undefined as unknown as string })).toEqual({
      a: '1'
    })
  })

  test('findMissingRequiredArg 与后端口径一致', () => {
    const def = { name: 'p', arguments: [{ name: 'q', required: true }, { name: 'opt' }] }
    expect(findMissingRequiredArg(def, {})).toBe('q')
    expect(findMissingRequiredArg(def, { q: 'x' })).toBeNull()
    expect(findMissingRequiredArg(def, { q: '' })).toBe('q')
  })
})

describe('mcpBrowse RPC 透传', () => {
  test('fetchMcpResources 透传 serverId 并整形', async () => {
    mockedSend.mockResolvedValue({
      success: true,
      resources: [{ serverId: 's1', serverName: 'S', status: 'connected', resources: [] }]
    })
    const out = await fetchMcpResources('s1')
    expect(mockedSend).toHaveBeenCalledWith(MCP_BROWSE_REQUESTS.listResources, { serverId: 's1' })
    expect(out).toHaveLength(1)
  })

  test('fetchMcpPrompts 空 serverId 时传空对象', async () => {
    mockedSend.mockResolvedValue({ success: true, prompts: [] })
    await fetchMcpPrompts()
    expect(mockedSend).toHaveBeenCalledWith(MCP_BROWSE_REQUESTS.listPrompts, {})
  })

  test('fetchMcpResourceContent 缺参直接抛错不发请求', async () => {
    await expect(fetchMcpResourceContent('', 'u')).rejects.toThrow('serverId')
    expect(mockedSend).not.toHaveBeenCalled()
  })

  test('fetchMcpResourceContent 空内容抛错不假装成功', async () => {
    mockedSend.mockResolvedValue({ success: true, content: null })
    await expect(fetchMcpResourceContent('s', 'u')).rejects.toThrow('为空')
  })

  test('fetchMcpPromptMessages 只透传非空字符串参数', async () => {
    mockedSend.mockResolvedValue({ success: true, messages: [] })
    await fetchMcpPromptMessages('s', 'p', { q: 'x', empty: '' })
    expect(mockedSend).toHaveBeenCalledWith(MCP_BROWSE_REQUESTS.getPrompt, {
      serverId: 's',
      promptName: 'p',
      arguments: { q: 'x', empty: '' }
    })
  })

  test('success=false 信封抛原文', async () => {
    mockedSend.mockResolvedValue({ success: false, error: { message: 'MCP 服务器不存在：x' } })
    await expect(fetchMcpResources('x')).rejects.toThrow('MCP 服务器不存在：x')
  })
})
