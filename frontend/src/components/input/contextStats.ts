/**
 * 上下文统计展示 — RPC 与数据整形（纯 .ts，.vue 保持薄）。
 *
 * 与 messageViewModes 同模式：组件只负责展示与交互状态，整形/口径逻辑在此可单测。
 *
 * 口径说明（先读 stores/chat/computed.ts 与 message/SummaryMessage.vue）：
 * - usedTokens：优先最后一条助手消息的 usageMetadata.totalTokenCount（供应商精确计数），
 *   总结更新且时间戳不早于该用量时使用 summaryTokenStats.estimatedContextTokenCountAfter（估算）。
 *   后端 describeConversation 已按同一口径计算 tokens.usedTokens / source / precise，
 *   前端不再重算，仅做展示与回退（max 缺失时回退 chatStore.maxContextTokens）。
 * - 总结展示字段与 SummaryMessage 一致：compressed 条数（summarizedMessageCount）、
 *   auto 徽标（isAutoSummary）、压缩前后 token（sourceTokenCount → summaryTokenCount，
 *   saved = estimatedTokensSaved）。
 * - breakdown：按来源分账的本地估算，走正式请求的组装流水线，计数器与自动总结判定相同；
 *   usedTokens 是上次请求的接口返回值，两者分词方式不同，界面分开显示，不互相校正。
 * 只读：不触发总结，不推进裁剪状态。
 */

import { sendToExtension } from '@/utils/vscode'

export const CONTEXT_REQUESTS = {
  describe: 'context.describe',
  summaryDetail: 'context.summaryDetail',
  breakdown: 'context.breakdown'
} as const

export type ContextCategoryId = 'messages' | 'systemTools' | 'mcpTools' | 'memory' | 'systemPrompt' | 'dynamicContext'

export interface ContextBreakdownItem {
  id: string
  tokens: number
  /** 工具名和提示词段落标题按原文显示；缺省时界面按 id 翻译。 */
  label?: string
  detail?: string
}

export interface ContextBreakdownCategory {
  id: ContextCategoryId
  tokens: number
  items: ContextBreakdownItem[]
}

export interface ContextBreakdown {
  categories: ContextBreakdownCategory[]
  totalTokens: number
  maxContextTokens: number
  maxInputTokens: number
  softLimitTokens: number
  reservedOutputTokens: number
  autoCompactBufferTokens: number
  freeTokens: number
  managementEnabled: boolean
  tokenizer: string
  model: string
  notices: string[]
  measuredAt: number
}

export interface ContextBreakdownRequest {
  conversationId?: string | null
  configId?: string
  modelOverride?: string
  reasoningEffort?: string
  promptModeId?: string
}

export type ContextUsageRowId = ContextCategoryId | 'reservedOutput' | 'autoCompactBuffer' | 'freeSpace'

export interface ContextUsageRow {
  id: ContextUsageRowId
  tokens: number
  percent: number
  items: ContextBreakdownItem[]
}

/** 面板行与占用条共用一份数据：已用分类在前，再是预留和缓冲，剩余空间始终在最后。 */
export function buildContextUsageRows(breakdown: ContextBreakdown): ContextUsageRow[] {
  const percent = (tokens: number) => tokens / breakdown.maxContextTokens * 100
  const row = (id: ContextUsageRowId, tokens: number, items: ContextBreakdownItem[] = []): ContextUsageRow =>
    ({ id, tokens, percent: percent(tokens), items })
  return [
    ...breakdown.categories.filter(category => category.tokens > 0).map(category => row(category.id, category.tokens, category.items)),
    ...(breakdown.reservedOutputTokens > 0 ? [row('reservedOutput', breakdown.reservedOutputTokens)] : []),
    ...(breakdown.autoCompactBufferTokens > 0 ? [row('autoCompactBuffer', breakdown.autoCompactBufferTokens)] : []),
    row('freeSpace', breakdown.freeTokens)
  ]
}

export type ContextTokenSource = 'provider-usage' | 'summary-estimate' | 'none' | string

export interface ContextSummaryTokenStats {
  sourceTokenCount: number
  summaryTokenCount: number
  estimatedTokensSaved: number
  contextTokenCountBefore?: number
  estimatedContextTokenCountAfter?: number
}

export interface ContextSummaryEntry {
  id?: string
  index: number
  timestamp?: number
  isAutoSummary: boolean
  summarizedMessageCount?: number
  summarizedMessageIds?: string[]
  summaryTokenStats?: ContextSummaryTokenStats
  preview: string
}

export interface ContextDescribeTokens {
  usedTokens: number
  source: ContextTokenSource
  precise: boolean
  maxContextTokens?: number
  maxInputTokens?: number
  contextSource?: string
  tokenUsagePercent?: number
  localEstimate: number
  localEstimateLabel?: string
  preciseTokens?: number
  preciseAvailable?: boolean
  preciseIsProviderCount?: boolean
  preciseMethod?: string
  preciseError?: string
}

export interface ContextDescribeRange {
  total: number
  visibleCount: number
  lastSummaryIndex: number
  summarizedCount: number
  summaryCount: number
  fallbackActive: boolean
  trimStartIndex?: number
  policyEnabled?: boolean
}

export interface ContextDescribeResult {
  conversationId: string
  revision?: number
  tokens: ContextDescribeTokens
  range: ContextDescribeRange
  summaries: ContextSummaryEntry[]
}

export interface ContextSummaryDetail {
  conversationId: string
  summary: ContextSummaryEntry
}

/** 提取 RPC 错误原文（失败显示具体错误原文，不假装成功）。 */
export function extractRpcErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || String(error)
  if (typeof error === 'string') return error
  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>
    if (typeof record.message === 'string' && record.message.trim()) return record.message
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

/** 是否为“宿主无对应处理器”错误（VSCode 扩展宿主缺 context.* 时回 UNKNOWN_TYPE）。 */
export function isMissingHandlerError(error: unknown): boolean {
  const message = extractRpcErrorMessage(error)
  return (
    /Unknown message type/i.test(message) ||
    /UNKNOWN_TYPE/.test(message) ||
    /尚未接入/.test(message) ||
    /No handler/i.test(message)
  )
}

function asFiniteNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function asOptionalFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function normalizeSummaryEntry(raw: unknown): ContextSummaryEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  const index = typeof record.index === 'number' && Number.isFinite(record.index) ? record.index : -1
  if (index < 0) return null
  const entry: ContextSummaryEntry = {
    index,
    isAutoSummary: record.isAutoSummary === true,
    preview: typeof record.preview === 'string' ? record.preview : ''
  }
  if (typeof record.id === 'string' && record.id) entry.id = record.id
  if (typeof record.timestamp === 'number' && Number.isFinite(record.timestamp)) entry.timestamp = record.timestamp
  if (typeof record.summarizedMessageCount === 'number' && Number.isFinite(record.summarizedMessageCount)) {
    entry.summarizedMessageCount = record.summarizedMessageCount
  }
  if (Array.isArray(record.summarizedMessageIds)) {
    entry.summarizedMessageIds = (record.summarizedMessageIds as unknown[]).filter(
      (id): id is string => typeof id === 'string'
    )
  }
  if (record.summaryTokenStats && typeof record.summaryTokenStats === 'object') {
    const stats = record.summaryTokenStats as Record<string, unknown>
    if (
      typeof stats.sourceTokenCount === 'number' &&
      typeof stats.summaryTokenCount === 'number' &&
      typeof stats.estimatedTokensSaved === 'number'
    ) {
      const normalized: ContextSummaryTokenStats = {
        sourceTokenCount: Math.max(0, stats.sourceTokenCount),
        summaryTokenCount: Math.max(0, stats.summaryTokenCount),
        estimatedTokensSaved: Math.max(0, stats.estimatedTokensSaved)
      }
      const before = asOptionalFiniteNumber(stats.contextTokenCountBefore)
      const after = asOptionalFiniteNumber(stats.estimatedContextTokenCountAfter)
      if (before !== undefined) normalized.contextTokenCountBefore = Math.max(0, before)
      if (after !== undefined) normalized.estimatedContextTokenCountAfter = Math.max(0, after)
      entry.summaryTokenStats = normalized
    }
  }
  return entry
}

/** 整形 context.describe 原始响应（缺字段时填保守默认值，不抛错；success=false 时抛原文）。 */
export function normalizeDescribePayload(payload: unknown): ContextDescribeResult {
  if (!payload || typeof payload !== 'object') throw new Error('上下文统计返回为空。')
  const record = payload as Record<string, unknown>
  if (record.success === false) {
    throw new Error(extractRpcErrorMessage(record.error) || '上下文统计获取失败')
  }
  const conversationId = typeof record.conversationId === 'string' ? record.conversationId : ''
  if (!conversationId) throw new Error('上下文统计返回缺少对话 ID。')
  const tokensRaw = (record.tokens ?? {}) as Record<string, unknown>
  const rangeRaw = (record.range ?? {}) as Record<string, unknown>
  const tokens: ContextDescribeTokens = {
    usedTokens: Math.max(0, asFiniteNumber(tokensRaw.usedTokens, 0)),
    source: typeof tokensRaw.source === 'string' ? (tokensRaw.source as ContextTokenSource) : 'none',
    precise: tokensRaw.precise === true,
    localEstimate: Math.max(0, asFiniteNumber(tokensRaw.localEstimate, 0))
  }
  const maxContextTokens = asOptionalFiniteNumber(tokensRaw.maxContextTokens)
  const maxInputTokens = asOptionalFiniteNumber(tokensRaw.maxInputTokens)
  const tokenUsagePercent = asOptionalFiniteNumber(tokensRaw.tokenUsagePercent)
  const preciseTokens = asOptionalFiniteNumber(tokensRaw.preciseTokens)
  if (maxContextTokens !== undefined) tokens.maxContextTokens = maxContextTokens
  if (maxInputTokens !== undefined) tokens.maxInputTokens = maxInputTokens
  if (typeof tokensRaw.contextSource === 'string' && tokensRaw.contextSource) {
    tokens.contextSource = tokensRaw.contextSource
  }
  if (tokenUsagePercent !== undefined) tokens.tokenUsagePercent = tokenUsagePercent
  if (typeof tokensRaw.localEstimateLabel === 'string') tokens.localEstimateLabel = tokensRaw.localEstimateLabel
  if (preciseTokens !== undefined) tokens.preciseTokens = preciseTokens
  if (typeof tokensRaw.preciseAvailable === 'boolean') tokens.preciseAvailable = tokensRaw.preciseAvailable
  if (typeof tokensRaw.preciseIsProviderCount === 'boolean') {
    tokens.preciseIsProviderCount = tokensRaw.preciseIsProviderCount
  }
  if (typeof tokensRaw.preciseMethod === 'string' && tokensRaw.preciseMethod) {
    tokens.preciseMethod = tokensRaw.preciseMethod
  }
  if (typeof tokensRaw.preciseError === 'string' && tokensRaw.preciseError) {
    tokens.preciseError = tokensRaw.preciseError
  }
  const range: ContextDescribeRange = {
    total: Math.max(0, asFiniteNumber(rangeRaw.total, 0)),
    visibleCount: Math.max(0, asFiniteNumber(rangeRaw.visibleCount, 0)),
    lastSummaryIndex: asFiniteNumber(rangeRaw.lastSummaryIndex, -1),
    summarizedCount: Math.max(0, asFiniteNumber(rangeRaw.summarizedCount, 0)),
    summaryCount: Math.max(0, asFiniteNumber(rangeRaw.summaryCount, 0)),
    fallbackActive: rangeRaw.fallbackActive === true
  }
  const trimStartIndex = asOptionalFiniteNumber(rangeRaw.trimStartIndex)
  if (trimStartIndex !== undefined) range.trimStartIndex = trimStartIndex
  if (typeof rangeRaw.policyEnabled === 'boolean') range.policyEnabled = rangeRaw.policyEnabled
  const summaries = Array.isArray(record.summaries)
    ? ((record.summaries as unknown[]).map(normalizeSummaryEntry).filter(Boolean) as ContextSummaryEntry[])
    : []
  const out: ContextDescribeResult = { conversationId, tokens, range, summaries }
  const revision = asOptionalFiniteNumber(record.revision)
  if (revision !== undefined) out.revision = revision
  return out
}

/** 整形 context.summaryDetail 原始响应。 */
export function normalizeSummaryDetailPayload(payload: unknown): ContextSummaryDetail {
  if (!payload || typeof payload !== 'object') throw new Error('总结详情返回为空。')
  const record = payload as Record<string, unknown>
  if (record.success === false) {
    throw new Error(extractRpcErrorMessage(record.error) || '总结详情获取失败')
  }
  const conversationId = typeof record.conversationId === 'string' ? record.conversationId : ''
  if (!conversationId) throw new Error('总结详情返回缺少对话 ID。')
  const entry = normalizeSummaryEntry(record.summary)
  if (!entry) throw new Error('总结消息已变化。')
  return { conversationId, summary: entry }
}

/** tokens.source 是否为供应商精确计数（与 computed.ts 的 provider-usage 分支对应）。 */
export function isPreciseSource(source: unknown): boolean {
  return source === 'provider-usage'
}

/** 总结压缩前后视图（与 SummaryMessage tokenBefore/tokenAfter/saved 同字段）。 */
export function toSummaryTokenView(
  stats: ContextSummaryTokenStats | undefined
): { before: number; after: number; saved: number } | null {
  if (!stats) return null
  return {
    before: Math.max(0, stats.sourceTokenCount),
    after: Math.max(0, stats.summaryTokenCount),
    saved: Math.max(0, stats.estimatedTokensSaved)
  }
}

function throwIfFailedEnvelope(raw: unknown, fallback: string): void {
  if (raw && typeof raw === 'object') {
    const record = raw as Record<string, unknown>
    if (record.success === false) {
      throw new Error(extractRpcErrorMessage(record.error) || fallback)
    }
  }
}

/** 只读获取按来源分账的上下文占用；宿主在 RPC 边界保证结构，这里只判失败。 */
export async function fetchContextBreakdown(request: ContextBreakdownRequest): Promise<ContextBreakdown> {
  const raw = await sendToExtension<ContextBreakdown>(CONTEXT_REQUESTS.breakdown, request)
  throwIfFailedEnvelope(raw, '上下文占用获取失败')
  return raw
}

/** 只读获取上下文统计（不触发总结）。 */
export async function fetchContextDescribe(
  conversationId: string,
  options?: { providerId?: string; modelOverride?: string }
): Promise<ContextDescribeResult> {
  if (!conversationId || !conversationId.trim()) throw new Error('需要提供对话 ID。')
  const data: Record<string, unknown> = { conversationId: conversationId.trim() }
  if (options?.providerId) data.providerId = options.providerId
  if (options?.modelOverride) data.modelOverride = options.modelOverride
  const raw = await sendToExtension<Record<string, unknown>>(CONTEXT_REQUESTS.describe, data)
  throwIfFailedEnvelope(raw, '上下文统计获取失败')
  return normalizeDescribePayload(raw)
}

/** 只读获取单条总结详情（不触发总结）。 */
export async function fetchSummaryDetail(
  conversationId: string,
  messageId: string
): Promise<ContextSummaryDetail> {
  if (!conversationId || !conversationId.trim()) throw new Error('需要提供对话 ID。')
  if (!messageId || !messageId.trim()) throw new Error('需要提供总结消息 ID。')
  const raw = await sendToExtension<Record<string, unknown>>(CONTEXT_REQUESTS.summaryDetail, {
    conversationId: conversationId.trim(),
    messageId: messageId.trim()
  })
  throwIfFailedEnvelope(raw, '总结详情获取失败')
  return normalizeSummaryDetailPayload(raw)
}
