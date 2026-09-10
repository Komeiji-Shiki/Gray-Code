/**
 * MCP 资源与提示模板浏览 — RPC 与数据整形（纯 .ts，.vue 保持薄）。
 *
 * 与 messageViewModes 同模式：模块级纯函数 + 可 mock 的 sendToExtension 薄封装，
 * 组件只负责展示与交互状态，全部整形/校验逻辑在此可单测。
 *
 * 只读语义：只读 live manager（后端 mcp.listResources/readResource/listPrompts/getPrompt），
 * 不触碰服务器增删改与连接逻辑，不改设置草稿协议。
 * 失败语义：失败抛 Error（message 为后端原文），不假装成功；缺处理器由调用方按
 * desktopOnly 提示（见 isMissingHandlerError / isDesktopHost）。
 */

import { sendToExtension } from '@/utils/vscode'

export const MCP_BROWSE_REQUESTS = {
  listResources: 'mcp.listResources',
  readResource: 'mcp.readResource',
  listPrompts: 'mcp.listPrompts',
  getPrompt: 'mcp.getPrompt'
} as const

export type McpBrowseStatus = 'connected' | 'connecting' | 'disconnected' | 'error' | string

export interface McpBrowseResource {
  uri: string
  name: string
  description?: string
  mimeType?: string
}

export interface McpBrowsePromptArg {
  name: string
  description?: string
  required?: boolean
}

export interface McpBrowsePrompt {
  name: string
  description?: string
  arguments?: McpBrowsePromptArg[]
}

export interface McpResourcesServerEntry {
  serverId: string
  serverName: string
  status: McpBrowseStatus
  lastError?: string
  resources: McpBrowseResource[]
}

export interface McpPromptsServerEntry {
  serverId: string
  serverName: string
  status: McpBrowseStatus
  lastError?: string
  prompts: McpBrowsePrompt[]
}

export interface McpResourceContent {
  contents?: McpResourceContent[]
  uri: string
  mimeType?: string
  text?: string
  blob?: string
}

export interface McpPromptMessageContent {
  resource?: McpResourceContent
  [key: string]: unknown
  type: 'text' | 'image' | 'resource' | string
  text?: string
  data?: string
  mimeType?: string
  uri?: string
}

export interface McpPromptMessage {
  role: 'user' | 'assistant' | string
  content: McpPromptMessageContent
}

export interface ResourceView {
  kind: 'text' | 'image' | 'file' | 'empty'
  text?: string
  imageUrl?: string
  mimeType?: string
  uri: string
}

export interface PromptMessageView {
  role: 'user' | 'assistant'
  kind: 'text' | 'image' | 'file' | 'resource' | 'empty'
  text?: string
  imageUrl?: string
  mimeType?: string
  uri?: string
}

/** 提取 RPC 错误原文（失败显示具体错误原文，不假装成功）。 */
export function extractRpcErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || String(error)
  if (typeof error === 'string') return error
  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>
    if (typeof record.message === 'string' && record.message.trim()) return record.message
    // 扩展宿主错误信封 { code, message } 或 { error: { message } }
    const nested = record.error as Record<string, unknown> | undefined
    if (nested && typeof nested.message === 'string' && nested.message.trim()) return nested.message
    try {
      return JSON.stringify(error)
    } catch {
      return String(error)
    }
  }
  return String(error ?? 'Unknown error')
}

/**
 * 是否为“宿主无对应处理器”错误。
 * VSCode 扩展宿主未注册 mcp.* 只读入口时会回 UNKNOWN_TYPE / Unknown message type；
 * 桌面宿主缺接线时会抛“尚未接入此接口”。命中即由调用方提示“该入口当前仅桌面版可用”。
 */
export function isMissingHandlerError(error: unknown): boolean {
  const message = extractRpcErrorMessage(error)
  return (
    /Unknown message type/i.test(message) ||
    /UNKNOWN_TYPE/.test(message) ||
    /尚未接入/.test(message) ||
    /No handler/i.test(message)
  )
}

/** 是否运行在独立桌面宿主（platform/main.ts 注入 __GRAYCODE_HOST）。 */
export function isDesktopHost(): boolean {
  try {
    return typeof window !== 'undefined' && !!window.__GRAYCODE_HOST
  } catch {
    return false
  }
}

/** 仅已连接服务器可展开浏览。 */
export function isBrowsableStatus(status: unknown): boolean {
  return status === 'connected'
}

function asNonEmptyString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function normalizeResourceDef(raw: unknown): McpBrowseResource | null {
  if (!raw || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  const uri = asNonEmptyString(record.uri).trim()
  const name = asNonEmptyString(record.name).trim()
  if (!uri || !name) return null
  const out: McpBrowseResource = { uri, name }
  if (typeof record.description === 'string' && record.description) out.description = record.description
  if (typeof record.mimeType === 'string' && record.mimeType) out.mimeType = record.mimeType
  return out
}

function normalizePromptDef(raw: unknown): McpBrowsePrompt | null {
  if (!raw || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  const name = asNonEmptyString(record.name).trim()
  if (!name) return null
  const out: McpBrowsePrompt = { name }
  if (typeof record.description === 'string' && record.description) out.description = record.description
  if (Array.isArray(record.arguments)) {
    const args: McpBrowsePromptArg[] = []
    for (const item of record.arguments) {
      if (!item || typeof item !== 'object') continue
      const arg = item as Record<string, unknown>
      const argName = asNonEmptyString(arg.name).trim()
      if (!argName) continue
      const normalized: McpBrowsePromptArg = { name: argName }
      if (typeof arg.description === 'string' && arg.description) normalized.description = arg.description
      if (typeof arg.required === 'boolean') normalized.required = arg.required
      args.push(normalized)
    }
    out.arguments = args
  }
  return out
}

/** 整形 mcp.listResources 原始响应为按服务器分组的条目（容忍 success 包裹与裸数组）。 */
export function normalizeResourcesPayload(payload: unknown): McpResourcesServerEntry[] {
  if (!payload || typeof payload !== 'object') return []
  const record = payload as Record<string, unknown>
  const list = Array.isArray(record.resources)
    ? record.resources
    : Array.isArray(record.servers)
      ? record.servers
      : Array.isArray(payload)
        ? (payload as unknown[])
        : []
  const out: McpResourcesServerEntry[] = []
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue
    const item = entry as Record<string, unknown>
    const serverId = asNonEmptyString(item.serverId).trim()
    if (!serverId) continue
    const serverName = asNonEmptyString(item.serverName).trim() || serverId
    const status = (typeof item.status === 'string' ? item.status : 'disconnected') as McpBrowseStatus
    const resources = Array.isArray(item.resources)
      ? (item.resources.map(normalizeResourceDef).filter(Boolean) as McpBrowseResource[])
      : []
    const normalized: McpResourcesServerEntry = { serverId, serverName, status, resources }
    if (typeof item.lastError === 'string' && item.lastError) normalized.lastError = item.lastError
    out.push(normalized)
  }
  return out
}

/** 整形 mcp.listPrompts 原始响应为按服务器分组的条目。 */
export function normalizePromptsPayload(payload: unknown): McpPromptsServerEntry[] {
  if (!payload || typeof payload !== 'object') return []
  const record = payload as Record<string, unknown>
  const list = Array.isArray(record.prompts)
    ? record.prompts
    : Array.isArray(record.servers)
      ? record.servers
      : Array.isArray(payload)
        ? (payload as unknown[])
        : []
  const out: McpPromptsServerEntry[] = []
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue
    const item = entry as Record<string, unknown>
    const serverId = asNonEmptyString(item.serverId).trim()
    if (!serverId) continue
    const serverName = asNonEmptyString(item.serverName).trim() || serverId
    const status = (typeof item.status === 'string' ? item.status : 'disconnected') as McpBrowseStatus
    const prompts = Array.isArray(item.prompts)
      ? (item.prompts.map(normalizePromptDef).filter(Boolean) as McpBrowsePrompt[])
      : []
    const normalized: McpPromptsServerEntry = { serverId, serverName, status, prompts }
    if (typeof item.lastError === 'string' && item.lastError) normalized.lastError = item.lastError
    out.push(normalized)
  }
  return out
}

/**
 * 资源内容 → 展示视图。
 * 文本直接展示；图片（mime image/* + blob base64）走附件形式（data URL 交由 <img> 渲染）。
 */
export function toResourceView(
  content: McpResourceContent | null | undefined,
  uriFallback = ''
): ResourceView {
  const uri =
    content && typeof content.uri === 'string' && content.uri.trim()
      ? content.uri
      : uriFallback
  const mimeType = content && typeof content.mimeType === 'string' ? content.mimeType : ''
  const text = content && typeof content.text === 'string' ? content.text : ''
  const blob = content && typeof content.blob === 'string' ? content.blob : ''
  const isImageMime = mimeType.toLowerCase().startsWith('image/')
  if (blob && isImageMime) {
    return { kind: 'image', imageUrl: `data:${mimeType};base64,${blob}`, mimeType, uri }
  }
  if (text) return { kind: 'text', text, mimeType, uri }
  if (typeof content?.blob === 'string') return { kind: 'file', mimeType, uri }
  return { kind: 'empty', mimeType, uri }
}

/** 提示模板消息 → 展示视图（文本直接展示，图片走附件形式，resource 保留原文）。 */
export function toPromptMessageViews(messages: unknown): PromptMessageView[] {
  if (!Array.isArray(messages)) return []
  return messages.map((item): PromptMessageView => {
    if (!item || typeof item !== 'object') return { role: 'user', kind: 'empty' }
    const role = item.role === 'assistant' ? 'assistant' : 'user'
    const content = item.content as McpPromptMessageContent | undefined
    if (!content) return { role, kind: 'empty' }
    if (content.type === 'resource' && content.resource) {
      const view = toResourceView(content.resource)
      return { ...view, role, kind: view.kind === 'text' ? 'resource' : view.kind }
    }
    if (typeof content.data === 'string') {
      const mime = content.mimeType ?? (content.type === 'image' ? 'image/png' : 'application/octet-stream')
      return { role, kind: mime.startsWith('image/') ? 'image' : 'file', imageUrl: mime.startsWith('image/') ? `data:${mime};base64,${content.data}` : undefined, mimeType: mime, uri: content.uri }
    }
    if (typeof content.text === 'string') return { role, kind: content.type === 'resource' ? 'resource' : 'text', text: content.text, uri: content.uri }
    if (content.type === 'resource_link') return { role, kind: 'resource', text: content.uri ?? '', uri: content.uri, mimeType: content.mimeType }
    const { _meta, ...visible } = content
    return { role, kind: 'text', text: JSON.stringify(visible, null, 2) }
  })
}

/** 提示参数归一化：仅保留字符串键值对（与后端 mcp.getPrompt 校验口径一致）。 */
export function normalizePromptArgs(input: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!input || typeof input !== 'object') return out
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === 'string') out[key] = value
  }
  return out
}

/** 返回缺失的必填参数名，无缺失返回 null（与后端“缺少提示参数”口径一致）。 */
export function findMissingRequiredArg(
  definition: McpBrowsePrompt | null | undefined,
  args: Record<string, string> | undefined
): string | null {
  for (const item of definition?.arguments ?? []) {
    if (item.required && !args?.[item.name]) return item.name
  }
  return null
}

function throwIfFailedEnvelope(raw: unknown, fallback: string): void {
  if (raw && typeof raw === 'object') {
    const record = raw as Record<string, unknown>
    if (record.success === false) {
      throw new Error(extractRpcErrorMessage(record.error) || fallback)
    }
  }
}

/** 列出资源（按服务器分组）。serverId 为空时返回全部服务器。 */
export async function fetchMcpResources(serverId?: string): Promise<McpResourcesServerEntry[]> {
  const data = serverId && serverId.trim() ? { serverId: serverId.trim() } : {}
  const raw = await sendToExtension<Record<string, unknown>>(MCP_BROWSE_REQUESTS.listResources, data)
  throwIfFailedEnvelope(raw, 'MCP 资源列表获取失败')
  return normalizeResourcesPayload(raw)
}

/** 列出提示模板（按服务器分组）。 */
export async function fetchMcpPrompts(serverId?: string): Promise<McpPromptsServerEntry[]> {
  const data = serverId && serverId.trim() ? { serverId: serverId.trim() } : {}
  const raw = await sendToExtension<Record<string, unknown>>(MCP_BROWSE_REQUESTS.listPrompts, data)
  throwIfFailedEnvelope(raw, 'MCP 提示模板列表获取失败')
  return normalizePromptsPayload(raw)
}

/** 读取单个资源内容并转为展示视图。 */
export async function fetchMcpResourceContent(
  serverId: string,
  uri: string
): Promise<{ view: ResourceView; views: ResourceView[]; raw: McpResourceContent }> {
  if (!serverId || !serverId.trim()) throw new Error('需要提供 serverId。')
  if (!uri || !uri.trim()) throw new Error('需要提供资源 URI。')
  const raw = await sendToExtension<{ success?: boolean; content?: McpResourceContent; error?: unknown }>(
    MCP_BROWSE_REQUESTS.readResource,
    { serverId: serverId.trim(), uri: uri.trim() }
  )
  throwIfFailedEnvelope(raw, `MCP 资源读取失败：${uri}`)
  const content = (raw as { content?: McpResourceContent }).content
  if (!content) throw new Error(`MCP 资源为空：${uri}`)
  return { view: toResourceView(content, uri.trim()), views: (content.contents ?? [content]).map(item => toResourceView(item, uri.trim())), raw: content }
}

/** 获取提示模板消息并转为展示视图（只读预览，不执行工具）。 */
export async function fetchMcpPromptMessages(
  serverId: string,
  promptName: string,
  args?: Record<string, string>
): Promise<{ views: PromptMessageView[]; raw: McpPromptMessage[] }> {
  if (!serverId || !serverId.trim()) throw new Error('需要提供 serverId。')
  if (!promptName || !promptName.trim()) throw new Error('需要提供提示模板名称。')
  const normalizedArgs = normalizePromptArgs(args as Record<string, unknown> | undefined)
  const payload: Record<string, unknown> = { serverId: serverId.trim(), promptName: promptName.trim() }
  if (Object.keys(normalizedArgs).length > 0) payload.arguments = normalizedArgs
  const raw = await sendToExtension<{ success?: boolean; messages?: McpPromptMessage[]; error?: unknown }>(
    MCP_BROWSE_REQUESTS.getPrompt,
    payload
  )
  throwIfFailedEnvelope(raw, `MCP 提示获取失败：${promptName}`)
  const messages = Array.isArray((raw as { messages?: unknown }).messages)
    ? ((raw as { messages: McpPromptMessage[] }).messages)
    : []
  return { views: toPromptMessageViews(messages), raw: messages }
}
