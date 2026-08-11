/**
 * Chat Store 对话操作
 * 
 * 包含对话的 CRUD 操作
 */

import { MESSAGE_NAMES } from '@shared/protocol'
import type { ChatStoreState, Conversation, CheckpointSummary, BuildSession } from './types'
import { sendToExtension } from '../../utils/vscode'
import { contentToMessageEnhanced } from './parsers'
import type { Content, Message } from '../../types'
import { perfLog, perfMeasureAsync } from '../../utils/perf'
import { syncTotalMessagesFromWindow, syncFoldedHistoryHint } from './windowUtils'
import {
  applyConversationModelConfig,
  applyConversationPromptMode,
  type ConversationModelConfig,
  type ConversationPromptModeConfig
} from './configActions'
import { countVisibleChatMessages } from './visibilityUtils'
import { validateSessionIdentity } from './utils'
import { rebuildMessageIndexById } from './state'
import { resetConversationState, createTab } from './tabActions'
import { clearPendingDirtyConfirm } from './dirtyConfirmState'

// ============ 对话列表分页加载配置 ============

/** 每次分页加载的对话数量 */
export const CONVERSATIONS_PAGE_SIZE = 30

/** 当前对话消息分页大小（窗口初始加载 / 上拉加载） */
export const MESSAGES_PAGE_SIZE = 120

/** 首屏至少应保证的可见消息数 */
export const MIN_INITIAL_VISIBLE_MESSAGES = 40

function parseConversationIdTimestamp(id: string): number | null {
  // 默认创建 ID: conv_${Date.now()}_${random}
  const m = /^conv_(\d+)_/.exec(id)
  if (!m) return null
  const n = Number(m[1])
  return Number.isFinite(n) ? n : null
}

function sortConversationIds(ids: string[]): string[] {
  // 尽量把“看起来较新的”对话排在前面：
  // 1) conv_{timestamp}_xxx 按 timestamp 倒序
  // 2) 其他按字符串倒序（尽量稳定）
  return [...ids].sort((a, b) => {
    const ta = parseConversationIdTimestamp(a)
    const tb = parseConversationIdTimestamp(b)
    if (ta != null && tb != null) return tb - ta
    if (ta != null) return -1
    if (tb != null) return 1
    return b.localeCompare(a)
  })
}

/**
 * 将后端批量摘要（HIS-10）转换为前端 Conversation 列表项。
 */
function toConversationFromSummary(raw: any): Conversation | null {
  if (!raw || typeof raw.id !== 'string' || !raw.id) return null
  return {
    id: raw.id,
    title: raw.title || `Chat ${raw.id.slice(0, 8)}`,
    createdAt: raw.createdAt || Date.now(),
    // L5：unknown 用当前时间兜底；显式 0 保持 0（按最旧排序，而不是伪装成最新）
    updatedAt: raw.updatedAt ?? Date.now(),
    messageCount: raw.messageCount || 0,
    preview: raw.preview,
    isPersisted: true,
    workspaceUri: raw.workspaceUri,
    integrityStatus: raw.integrityStatus
  } as Conversation
}

/**
 * 取消流式并拒绝工具的回调类型
 */
export type CancelStreamAndRejectToolsCallback = () => Promise<void>

interface ConversationViewPayload {
  metadata?: any
  totalMessages?: number
  messages?: Content[]
  checkpoints?: CheckpointSummary[]
  modelConfig?: ConversationModelConfig
  promptMode?: ConversationPromptModeConfig
  activeBuild?: unknown
}

export function parsePersistedBuildSession(raw: any, conversationId: string): BuildSession | null {
  if (!raw || typeof raw !== 'object') return null

  const id = typeof raw.id === 'string' ? raw.id : ''
  const title = typeof raw.title === 'string' ? raw.title : ''
  const planContent = typeof raw.planContent === 'string' ? raw.planContent : ''
  const startedAt = typeof raw.startedAt === 'number' ? raw.startedAt : 0
  const anchorBackendIndex = typeof raw.anchorBackendIndex === 'number' ? raw.anchorBackendIndex : undefined
  const status: BuildSession['status'] = raw.status === 'running' ? 'running' : 'done'

  if (!id || !title || !planContent || !startedAt) return null

  return {
    id,
    conversationId,
    title,
    planContent,
    planPath: typeof raw.planPath === 'string' ? raw.planPath : undefined,
    channelId: typeof raw.channelId === 'string' ? raw.channelId : undefined,
    modelId: typeof raw.modelId === 'string' ? raw.modelId : undefined,
    startedAt,
    anchorBackendIndex,
    status
  }
}

interface InitialVisibleMessageWindowResult {
  messages: Message[]
  totalMessages: number
  windowStartIndex: number
}

/**
 * 立即渲染最后一页消息窗口（HIS-13：首屏先展示）。
 */
function renderMessageWindow(
  state: ChatStoreState,
  page: Content[],
  totalMessages: number
): void {
  const messages = page.map(content => contentToMessageEnhanced(content))
  state.totalMessages.value = totalMessages
  state.allMessages.value = messages
  rebuildMessageIndexById(state)
  state.windowStartIndex.value = page[0]?.index ?? Math.max(0, totalMessages - page.length)
  syncTotalMessagesFromWindow(state)
}

/** 补拉更早历史页（HIS-13 异步补拉复用同一分页 IPC） */
function fetchOlderPageFor(
  conversationId: string,
  beforeIndex: number
): Promise<{ total: number; messages: Content[] } | null | undefined> {
  return perfMeasureAsync('conversation.loadHistoryPaged.backfill', () =>
    sendToExtension<{ total: number; messages: Content[] }>(MESSAGE_NAMES['conversation.getMessagesPaged'], {
      conversationId,
      beforeIndex,
      limit: MESSAGES_PAGE_SIZE
    })
  )
}

/**
 * 异步补拉更早历史并合并进窗口（HIS-13）。
 *
 * 首屏已先渲染最后一页；本函数在后台补拉更早页直到可见消息数达标。
 * 合并前校验：会话未切换、窗口未被新消息改动（发送/流式/上拉），
 * 否则放弃合并（保留分页语义，用户仍可手动上拉加载）。
 */
async function backfillInitialVisibleWindow(
  state: ChatStoreState,
  conversationId: string,
  page: Content[],
  total: number
): Promise<void> {
  const originWindowStart = state.windowStartIndex.value
  const originCount = state.allMessages.value.length
  try {
    const initialWindow = await buildInitialVisibleMessageWindow(
      page,
      total,
      (beforeIndex) => fetchOlderPageFor(conversationId, beforeIndex)
    )

    // 校验归属：await 后当前会话可能已切换
    if (!validateSessionIdentity(state, conversationId)) return
    // 补拉期间窗口已有新数据（用户发送/流式/手动上拉）：跳过合并避免覆盖
    if (state.windowStartIndex.value !== originWindowStart || state.allMessages.value.length !== originCount) return

    state.totalMessages.value = initialWindow.totalMessages
    state.allMessages.value = initialWindow.messages
    rebuildMessageIndexById(state)
    state.windowStartIndex.value = initialWindow.windowStartIndex
    syncTotalMessagesFromWindow(state)

    perfLog('conversation.window.backfilled', {
      start: state.windowStartIndex.value,
      count: state.allMessages.value.length,
      total: state.totalMessages.value
    })
  } catch (err) {
    // 补拉失败不影响首屏：静默降级（保留分页语义，用户可手动上拉）
    console.warn('[conversationActions] Failed to backfill older history:', err)
  }
}

export async function buildInitialVisibleMessageWindow(
  initialPage: Content[],
  initialTotalMessages: number,
  fetchOlderPage: (beforeIndex: number) => Promise<{ total: number; messages: Content[] } | null | undefined>
): Promise<InitialVisibleMessageWindowResult> {
  let totalMessages = initialTotalMessages ?? initialPage.length
  let messages = initialPage.map(content => contentToMessageEnhanced(content))
  let windowStartIndex = initialPage[0]?.index ?? Math.max(0, totalMessages - initialPage.length)
  let visibleCount = countVisibleChatMessages(messages)

  perfLog('conversation_initial_visible_backfill', {
    phase: 'initial',
    rawCount: initialPage.length,
    visibleCount,
    totalMessages,
    windowStartIndex,
    satisfied: visibleCount >= MIN_INITIAL_VISIBLE_MESSAGES
  })

  while (visibleCount < MIN_INITIAL_VISIBLE_MESSAGES && windowStartIndex > 0) {
    const previousStartIndex = windowStartIndex
    const result = await fetchOlderPage(previousStartIndex)
    // L2：null/undefined 表示拉取失败（IPC 错误/超时），不是“已到历史开头”——
    // 抛出让调用方 catch 兜底，放弃合并并保留原窗口（空页才会置 windowStartIndex=0）。
    if (!result) {
      throw new Error('Failed to fetch older page during backfill')
    }
    const olderPage = result.messages || []
    totalMessages = result.total ?? totalMessages

    if (olderPage.length === 0) {
      windowStartIndex = 0
      break
    }

    const olderMessages = olderPage.map(content => contentToMessageEnhanced(content))
    messages = [...olderMessages, ...messages]

    const nextStartIndex = olderPage[0]?.index
    windowStartIndex = typeof nextStartIndex === 'number'
      ? nextStartIndex
      : Math.max(0, previousStartIndex - olderPage.length)
    visibleCount = countVisibleChatMessages(messages)

    perfLog('conversation_initial_visible_backfill', {
      phase: 'backfill',
      beforeIndex: previousStartIndex,
      rawCount: messages.length,
      olderRawCount: olderPage.length,
      visibleCount,
      totalMessages,
      windowStartIndex,
      satisfied: visibleCount >= MIN_INITIAL_VISIBLE_MESSAGES
    })

    if (windowStartIndex >= previousStartIndex) {
      break
    }
  }

  return {
    messages,
    totalMessages,
    windowStartIndex
  }
}

export async function loadConversationBuildSession(conversationId: string): Promise<BuildSession | null> {
  try {
    const metadata = await sendToExtension<any>(MESSAGE_NAMES['conversation.getConversationMetadata'], {
      conversationId
    })
    return parsePersistedBuildSession(metadata?.custom?.activeBuild, conversationId)
  } catch (error) {
    console.error('[conversationActions] Failed to load activeBuild from metadata:', error)
    return null
  }
}

/**
 * 刷新当前对话的 Build 会话（从元数据重载）
 */
export async function refreshCurrentConversationBuildSession(state: ChatStoreState): Promise<void> {
  const conversationId = state.currentConversationId.value
  if (!conversationId) return

  state.activeBuild.value = await loadConversationBuildSession(conversationId)
}

export async function syncConversationWorkspaceUri(
  state: ChatStoreState,
  conversationId: string
): Promise<void> {
  let workspaceUri = state.currentWorkspaceUri.value
  try {
    const latestWorkspaceUri = await sendToExtension<string | null>(MESSAGE_NAMES.getWorkspaceUri, {})
    if (latestWorkspaceUri) {
      workspaceUri = latestWorkspaceUri
      state.currentWorkspaceUri.value = latestWorkspaceUri
    }
  } catch {
    // ignore and fallback to store value
  }
  if (!workspaceUri) return

  const conv = state.conversations.value.find(c => c.id === conversationId)
  if (!conv || !conv.isPersisted) return
  // 记忆隔离（PR #20 审查 M5 + LOW-17 修正）：
  // - 未绑定/为空：用当前活动工作区补齐——保留“新会话自动绑定”，
  //   也不破坏后端 createBranchConversation 的工作区继承；
  // - 已绑定且绑定仍有效（绑定 URI 就是当前活动工作区）：保持“首次绑定即终身”语义，不重绑；
  // - 已绑定但绑定失效（当前活动工作区已不是绑定 URI——原工作区已关闭或切换了项目）：
  //   重新绑定到当前活动工作区，让存量误绑自愈（LOW-17），
  //   记忆工具不再被错误路由到已关闭/已离开的旧工作区。
  // 注：前端可获取的是“当前活动工作区”URI（getWorkspaceUri 返回第一个打开的文件夹），
  // 多根工作区下对话跟随活动文件夹；未打开任何工作区时上面已提前 return，保持不重绑。
  if (conv.workspaceUri) {
    if (conv.workspaceUri === workspaceUri) return
  }

  try {
    await sendToExtension(MESSAGE_NAMES['conversation.setWorkspaceUri'], {
      conversationId,
      workspaceUri
    })
    conv.workspaceUri = workspaceUri
  } catch (error) {
    console.warn('[conversationActions] Failed to sync conversation workspace URI:', error)
  }
}

/**
 * 创建新对话（仅清空消息，不创建对话记录）
 *
 * 如果当前有正在进行的请求，会先取消并将工具标记为拒绝
 */
export async function createNewConversation(
  state: ChatStoreState,
  cancelStreamAndRejectTools: CancelStreamAndRejectToolsCallback
): Promise<void> {
  // 如果有正在进行的请求，先取消并拒绝工具
  if (state.isWaitingForResponse.value || state.isStreaming.value) {
    await cancelStreamAndRejectTools()
  }
  
  // 复用 resetConversationState 清理全部会话状态：手工清理此前遗漏了
  // attachments/editorNodes/messageQueue/currentPromptModeId 以及平滑流/重试/自动总结残留
  resetConversationState(state)
}

/**
 * 创建并持久化新对话到后端
 */
export async function createAndPersistConversation(
  state: ChatStoreState,
  firstMessage: string
): Promise<string | null> {
  const id = `conv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  
  // 使用第一句话的前30个字符作为标题
  const title = firstMessage.slice(0, 30) + (firstMessage.length > 30 ? '...' : '')
  
  try {
    // 创建对话时传递工作区 URI
    await sendToExtension(MESSAGE_NAMES['conversation.createConversation'], {
      conversationId: id,
      title: title,
      workspaceUri: state.currentWorkspaceUri.value || undefined
    })
    
    // 添加到对话列表
    const newConversation: Conversation = {
      id,
      title,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messageCount: 0,
      isPersisted: true,
      workspaceUri: state.currentWorkspaceUri.value || undefined
    }
    
    state.conversations.value.unshift(newConversation)
    // P1-竞态：创建 await 期间用户可能已切换标签页/会话，currentConversationId 可能已被
    // 其他会话接管——仅当仍为 null（未被接管）时才写回，避免覆盖切换后的会话导致
    // 消息发往错误会话、窗口混入他人会话内容（sendMessageFlow 创建分支以固化的
    // newId 为准，不依赖本赋值；正常路径下 currentConversationId 仍为 null，行为不变）
    if (state.currentConversationId.value === null) {
      state.currentConversationId.value = id
    }

    // 同步分页列表（避免后续滚动加载重复 / 丢失）
    if (!state.persistedConversationIds.value.includes(id)) {
      state.persistedConversationIds.value.unshift(id)
      state.persistedConversationsLoaded.value += 1
    }
    
    return id
  } catch (err) {
    console.error('Failed to create conversation:', err)
    return null
  }
}

/**
 * 加载对话列表
 *
 * 优化：只获取元信息，不加载具体消息内容
 * 消息内容在用户点击对话时才延迟加载
 */
export interface BranchConversationResult {
  success: boolean
  conversationId: string
  title: string
  createdAt: number
  updatedAt: number
  messageCount: number
  preview?: string
  workspaceUri?: string
}

/**
 * 基于某条后端历史消息创建分支对话。
 */
export async function createBranchConversation(
  state: ChatStoreState,
  sourceConversationId: string,
  branchAtIndex: number,
  options: { title?: string } = {}
): Promise<Conversation | null> {
  try {
    const result = await sendToExtension<BranchConversationResult>(MESSAGE_NAMES['conversation.createBranchConversation'], {
      sourceConversationId,
      branchAtIndex,
      title: options.title,
      workspaceUri: state.currentWorkspaceUri.value || undefined
    })

    if (!result?.success || !result.conversationId) {
      return null
    }

    const now = Date.now()
    const conversation: Conversation = {
      id: result.conversationId,
      title: result.title || `Chat ${result.conversationId.slice(0, 8)}`,
      createdAt: result.createdAt || now,
      updatedAt: result.updatedAt || result.createdAt || now,
      messageCount: result.messageCount || branchAtIndex + 1,
      preview: result.preview,
      isPersisted: true,
      workspaceUri: result.workspaceUri || state.currentWorkspaceUri.value || undefined
    }

    const existingIndex = state.conversations.value.findIndex(c => c.id === conversation.id)
    if (existingIndex >= 0) {
      state.conversations.value.splice(existingIndex, 1, conversation)
    } else {
      state.conversations.value.unshift(conversation)
    }

    const persistedIndex = state.persistedConversationIds.value.indexOf(conversation.id)
    if (persistedIndex >= 0) {
      state.persistedConversationIds.value.splice(persistedIndex, 1)
      state.persistedConversationIds.value.unshift(conversation.id)
    } else {
      state.persistedConversationIds.value.unshift(conversation.id)
      state.persistedConversationsLoaded.value += 1
    }

    return conversation
  } catch (err: any) {
    console.error('[conversationActions] Failed to create branch conversation:', err)
    state.error.value = {
      code: err?.code || 'CREATE_BRANCH_CONVERSATION_ERROR',
      message: err?.message || 'Failed to create branch conversation'
    }
    return null
  }
}


export async function loadConversations(state: ChatStoreState): Promise<void> {
  state.isLoadingConversations.value = true

  try {
    // 仅获取全部 ID（一次请求），实际元数据采用分页加载
    const ids = await sendToExtension<string[]>(MESSAGE_NAMES['conversation.listConversations'], {})

    // 重置分页游标
    state.persistedConversationIds.value = sortConversationIds(Array.isArray(ids) ? ids : [])
    state.persistedConversationsLoaded.value = 0

    // 保留未持久化的对话
    const unpersistedConvs = state.conversations.value.filter(c => !c.isPersisted)
    state.conversations.value = [...unpersistedConvs]

    // 加载第一页
    await loadMoreConversations(state, { initial: true })
  } catch (err: any) {
    state.error.value = {
      code: err.code || 'LOAD_ERROR',
      message: err.message || 'Failed to load conversations'
    }
  } finally {
    state.isLoadingConversations.value = false
  }
}

/**
 * 分页加载更多对话（只加载元数据）
 *
 * - 初始加载：由 loadConversations 调用（initial=true），不占用底部加载状态
 * - 滚动加载：initial=false，会设置 isLoadingMoreConversations
 */
export async function loadMoreConversations(
  state: ChatStoreState,
  options: { pageSize?: number; initial?: boolean } = {}
): Promise<void> {
  const pageSize = options.pageSize ?? CONVERSATIONS_PAGE_SIZE
  const initial = options.initial ?? false

  if (!initial && state.isLoadingMoreConversations.value) return

  const allIds = state.persistedConversationIds.value
  const cursor = state.persistedConversationsLoaded.value
  if (cursor >= allIds.length) return

  const idsToLoad = allIds.slice(cursor, cursor + pageSize)
  if (idsToLoad.length === 0) return

  if (!initial) state.isLoadingMoreConversations.value = true

  try {
    // HIS-10：一次 IPC 批量拉取一页摘要，避免每个对话一次 getConversationMetadata
    const rawSummaries = await sendToExtension<Array<Record<string, unknown>>>(MESSAGE_NAMES['conversation.getConversationMetadataBatch'], {
      conversationIds: idsToLoad
    })
    const summaries = (Array.isArray(rawSummaries) ? rawSummaries : [])
      .map(toConversationFromSummary)
      .filter((c): c is Conversation => c !== null)

    // L3：游标按“实际返回数量”前进，而不是按请求数量。后端 getConversationMetadataBatch
    // 会截断到 200 条、IPC 失败时返回空数组——按请求数前进会跳过未加载的对话。
    state.persistedConversationsLoaded.value = cursor + (Array.isArray(rawSummaries) ? rawSummaries.length : 0)

    // 合并到现有列表（避免重复）
    const unpersisted = state.conversations.value.filter(c => !c.isPersisted)
    const persistedExisting = state.conversations.value.filter(c => c.isPersisted)
    const map = new Map<string, Conversation>()
    for (const c of persistedExisting) map.set(c.id, c)
    for (const c of summaries) map.set(c.id, c)

    state.conversations.value = [...unpersisted, ...Array.from(map.values())]
  } finally {
    if (!initial) state.isLoadingMoreConversations.value = false
  }
}

/**
 * 加载历史消息
 *
 * 存储所有消息，包括 functionResponse 消息
 * 前端索引与后端索引一一对应
 */
export async function loadHistory(state: ChatStoreState): Promise<void> {
  if (!state.currentConversationId.value) return

  // 固化会话标识：catch 中校验归属需要（await 失败期间当前会话可能已切换）
  const conversationId = state.currentConversationId.value

  try {
    // 重置折叠提示（重新加载最后一页）
    state.historyFolded.value = false
    state.foldedMessageCount.value = 0

    const result = await perfMeasureAsync('conversation.loadHistoryPaged', () =>
      sendToExtension<{ total: number; messages: Content[] }>(MESSAGE_NAMES['conversation.getMessagesPaged'], {
        conversationId,
        limit: MESSAGES_PAGE_SIZE
      })
    )

    const page = result?.messages || []
    const total = result?.total ?? page.length

    // 校验归属：await 后当前会话可能已切换，迟到的旧会话响应不能覆盖新会话窗口
    if (!validateSessionIdentity(state, conversationId)) return

    // HIS-13：先渲染最后一页（首屏即时显示），再异步补拉更早历史
    renderMessageWindow(state, page, total)

    perfLog('conversation.window.firstPaint', {
      start: state.windowStartIndex.value,
      count: state.allMessages.value.length,
      total: state.totalMessages.value
    })

    void backfillInitialVisibleWindow(state, conversationId, page, total)
  } catch (err: any) {
    // 校验归属：加载失败期间当前会话可能已切换——迟到的旧会话失败不能覆盖新会话的全局错误
    if (validateSessionIdentity(state, conversationId)) {
      state.error.value = {
        code: err.code || 'LOAD_ERROR',
        message: err.message || 'Failed to load history'
      }
    }
  }
}

/**
 * 上拉加载更早消息（在当前窗口前追加一页）
 */
export async function loadOlderMessagesPage(
  state: ChatStoreState,
  options: { pageSize?: number } = {}
): Promise<boolean> {
  if (!state.currentConversationId.value) return false
  if (state.isLoadingMoreMessages.value) return false

  // 已经到头
  if (state.windowStartIndex.value <= 0) return false

  const pageSize = options.pageSize ?? MESSAGES_PAGE_SIZE

  // 一次性锁定请求发起时的对话身份与窗口起点
  const originConversationId = state.currentConversationId.value
  const originWindowStart = state.windowStartIndex.value

  state.isLoadingMoreMessages.value = true

  try {
    const result = await perfMeasureAsync('conversation.loadOlderMessagesPage', () =>
      sendToExtension<{ total: number; messages: Content[] }>(MESSAGE_NAMES['conversation.getMessagesPaged'], {
        conversationId: originConversationId,
        beforeIndex: originWindowStart,
        limit: pageSize
      })
    )

    // 校验归属：await 后当前会话可能已切换
    if (!validateSessionIdentity(state, originConversationId)) return false

    const older = result?.messages || []
    if (older.length === 0) {
      state.windowStartIndex.value = 0
      state.totalMessages.value = result?.total ?? state.totalMessages.value
      syncFoldedHistoryHint(state)
      return false
    }

    const olderMsgs = older.map(c => contentToMessageEnhanced(c))
    // 追加到窗口顶部
    state.allMessages.value = [...olderMsgs, ...state.allMessages.value]
    rebuildMessageIndexById(state)

    state.totalMessages.value = result?.total ?? state.totalMessages.value
    state.windowStartIndex.value = older[0]?.index ?? state.windowStartIndex.value

    // 这是用户主动上拉恢复更早历史，不能立刻从顶部裁剪；
    // 否则刚拉回来的旧消息会被马上丢掉，表现为”继续上拉无法加载”。
    // 后续发送/重试等向底部追加新消息时仍会通过 trimWindowFromTop 控制窗口大小。
    syncFoldedHistoryHint(state)

    perfLog('conversation.window', {
      start: state.windowStartIndex.value,
      count: state.allMessages.value.length,
      total: state.totalMessages.value
    })

    return true
  } catch (err) {
    console.error('[conversationActions] loadOlderMessagesPage failed:', err)
    return false
  } finally {
    // 仅当会话未切换时才复位加载标志
    if (validateSessionIdentity(state, originConversationId)) {
      state.isLoadingMoreMessages.value = false
    }
  }
}

/**
 * 加载当前对话的检查点
 */
export async function loadCheckpoints(state: ChatStoreState): Promise<void> {
  // 固化会话标识：await 后当前会话可能已切换，迟到的旧会话响应不能覆盖新会话列表
  const conversationId = state.currentConversationId.value
  if (!conversationId) {
    state.checkpoints.value = []
    return
  }
  
  try {
    const result = await sendToExtension<{ checkpoints: CheckpointSummary[] }>(MESSAGE_NAMES['checkpoint.getCheckpoints'], {
      conversationId
    })
    
    // 校验归属：await 期间会话已切换时丢弃迟到响应，避免旧会话检查点覆盖当前会话
    if (!validateSessionIdentity(state, conversationId)) return

    if (result?.checkpoints) {
      state.checkpoints.value = result.checkpoints
    } else {
      state.checkpoints.value = []
    }
  } catch (err) {
    // L-8：加载失败时保留旧值（不静默置空），避免后端瞬时错误导致检查点条全部消失
    console.warn('[conversationActions] Failed to load checkpoints, keeping previous list:', err)
  }
}

/**
 * 切换到指定对话
 *
 * 每次切换都会重新加载对话内容，确保数据最新
 * 如果当前有正在进行的请求，会先取消并将工具标记为拒绝
 */
export async function switchConversation(
  state: ChatStoreState,
  id: string,
  cancelStreamAndRejectTools: CancelStreamAndRejectToolsCallback
): Promise<void> {
  // 注意：即使是相同对话也允许重新加载（从历史记录进入时需要刷新）
  const conv = state.conversations.value.find(c => c.id === id)
  if (!conv) return
  
  // 如果有正在进行的请求，先取消并拒绝工具
  if (state.isWaitingForResponse.value || state.isStreaming.value) {
    await cancelStreamAndRejectTools()
  }
  
  // 清除状态
  state.activeBuild.value = null
  const previousConversationId = state.currentConversationId.value
  state.currentConversationId.value = id
  state.allMessages.value = []
  state.windowStartIndex.value = 0
  state.totalMessages.value = 0
  state.isLoadingMoreMessages.value = false
  state.historyFolded.value = false
  state.foldedMessageCount.value = 0
  state.checkpoints.value = []
  state.toolResponseCache.value = new Map()
  state.error.value = null
  state.isLoading.value = false
  state.isStreaming.value = false
  state.streamingMessageId.value = null
  state.activeStreamId.value = null
  state._lastCancelledStreamId.value = null
  state._pendingBranchRefreshAfterStream.value = null
  state._pendingBranchReplayContext.value = null
  state.isWaitingForResponse.value = false
  state.attachments.value = []
  state.editorNodes.value = []
  // TREE-12：切换会话清空分支图与分支锁（与 resetConversationState 对齐），
  // 避免旧会话分支图/切换锁残留到新会话（loadBranchGraph 会重新拉取）
  state.branchGraph.value = null
  state.isSwitchingBranch.value = false
  state.branchGraphLoading.value = false

  const requestedId = id

  // BCP-05：切换到不同会话时按归属清空 dirty 确认（归属校验见 dirtyConfirmState），
  // 避免确认框在新会话弹出并把续作动作发到错误会话；同会话重新加载保留待确认动作
  if (previousConversationId !== id) {
    clearPendingDirtyConfirm(previousConversationId)
  }

  // 如果是已持久化的对话，从后端加载历史和检查点
  try {
    if (conv.isPersisted) {
      state.isLoading.value = true
      const view = await perfMeasureAsync('conversation.loadConversationForView', () =>
        sendToExtension<ConversationViewPayload>(MESSAGE_NAMES['conversation.loadConversationForView'], {
          conversationId: requestedId,
          limit: MESSAGES_PAGE_SIZE
        })
      )

      // 校验归属：await 后当前会话可能已切换
      if (!validateSessionIdentity(state, requestedId)) return

      await Promise.all([
        applyConversationModelConfig(state, requestedId, view?.modelConfig ?? {}),
        // 恢复该对话保存的 Prompt 模式（若无则回落到默认 'code'）
        applyConversationPromptMode(state, requestedId, view?.promptMode ?? {})
      ])

      // 校验归属：配置应用完成后可能已切换
      if (!validateSessionIdentity(state, requestedId)) return

      const page = view?.messages || []
      const total = view?.totalMessages ?? page.length

      // HIS-13：先渲染最后一页（首屏即时显示），再异步补拉更早历史
      renderMessageWindow(state, page, total)
      void backfillInitialVisibleWindow(state, requestedId, page, total)

      state.checkpoints.value = Array.isArray(view?.checkpoints) ? view.checkpoints : []
      state.activeBuild.value = parsePersistedBuildSession(view?.activeBuild, requestedId)

      if (view?.metadata?.workspaceUri) {
        conv.workspaceUri = view.metadata.workspaceUri
      }

      // 更新对话的消息数量（在加载后才有准确数据）
      conv.messageCount = state.totalMessages.value || state.allMessages.value.length

      // 工作区同步不阻塞切换主链路
      void syncConversationWorkspaceUri(state, requestedId)
    } else {
      state.activeBuild.value = null
    }
  } catch (err: any) {
    console.error('[conversationActions] Failed to switch conversation:', err)
    // 仅当会话未切换时才写入错误
    if (validateSessionIdentity(state, requestedId)) {
      state.error.value = {
        code: err?.code || 'SWITCH_CONVERSATION_ERROR',
        message: err?.message || 'Failed to switch conversation'
      }
    }
  } finally {
    // 仅当会话未切换时才复位加载状态
    if (validateSessionIdentity(state, requestedId)) {
      state.isLoading.value = false
    }
  }
}

/**
 * 检查对话是否正在删除
 */
export function isDeletingConversation(state: ChatStoreState, id: string): boolean {
  return state.deletingConversationIds.value.has(id)
}

/**
 * 删除对话
 *
 * 使用锁机制防止快速连续删除时的竞态条件
 */
export async function deleteConversation(
  state: ChatStoreState,
  id: string,
  switchConversationFn: (id: string) => Promise<void>,
  createNewConversationFn: () => Promise<void>
): Promise<boolean> {
  const conv = state.conversations.value.find(c => c.id === id)
  if (!conv) return false
  
  // 如果正在删除，跳过
  if (state.deletingConversationIds.value.has(id)) {
    console.warn(`[chatStore] 对话 ${id} 正在删除中，跳过重复请求`)
    return false
  }
  
  // 标记为正在删除
  state.deletingConversationIds.value.add(id)
  
  try {
    // 如果是已持久化的，需要从后端删除
    if (conv.isPersisted) {
      await sendToExtension(MESSAGE_NAMES['conversation.deleteConversation'], { conversationId: id })
    }
    
    // 后端删除成功后，再从前端移除
    state.conversations.value = state.conversations.value.filter(c => c.id !== id)

    // 同步分页列表游标
    if (conv.isPersisted) {
      const idx = state.persistedConversationIds.value.indexOf(id)
      if (idx >= 0) {
        state.persistedConversationIds.value.splice(idx, 1)
        if (idx < state.persistedConversationsLoaded.value) {
          state.persistedConversationsLoaded.value = Math.max(0, state.persistedConversationsLoaded.value - 1)
        }
      }
    }

    // 清理 openTabs 中引用已删会话的标签页（快照与后台流缓冲一并清理），
    // 避免孤儿标签页残留（删除后仍可点击切换/恢复已删会话）
    const deletedConvTabs = state.openTabs.value.filter(t => t.conversationId === id)
    for (const tab of deletedConvTabs) {
      state.sessionSnapshots.value.delete(tab.id)
    }
    state.backgroundStreamBuffers.value.delete(id)
    state.openTabs.value = state.openTabs.value.filter(t => t.conversationId !== id)

    // 已删会话占用当前激活标签页（常规即「删除的是当前对话」）：激活标签页已随上方移除，
    // 先复位会话状态并补建空白标签页，交给下方「删除的是当前对话」分支复用
    // （switchConversation/createNewConversation 会把新会话绑定到该空白标签页）
    const wasCurrentConversationDeleted = state.currentConversationId.value === id
    if (deletedConvTabs.some(t => t.id === state.activeTabId.value)) {
      state.activeTabId.value = null
      resetConversationState(state)
      const replacementTabId = createTab(state, { title: 'New Chat', switchTo: false })
      if (replacementTabId) {
        state.activeTabId.value = replacementTabId
      }
    }

    // 如果删除的是当前对话，切换或创建新对话
    if (wasCurrentConversationDeleted) {
      if (state.conversations.value.length > 0) {
        await switchConversationFn(state.conversations.value[0].id)
      } else {
        await createNewConversationFn()
      }
    }
    
    return true
  } catch (err: any) {
    state.error.value = {
      code: err.code || 'DELETE_ERROR',
      message: err.message || 'Failed to delete conversation'
    }
    return false
  } finally {
    // 无论成功失败，都移除删除锁
    state.deletingConversationIds.value.delete(id)
  }
}

/**
 * 流式完成后更新对话元数据
 */
export async function updateConversationAfterMessage(state: ChatStoreState): Promise<void> {
  if (!state.currentConversationId.value) return
  
  const conv = state.conversations.value.find(c => c.id === state.currentConversationId.value)
  if (!conv) return
  
  const now = Date.now()
  // windowStartIndex 是绝对索引，windowStartIndex + window.length 近似代表“当前已知的总消息数”
  const messageCount = Math.max(
    state.totalMessages.value,
    state.windowStartIndex.value + state.allMessages.value.length
  )

  // 最近一条非 functionResponse 用户消息作为预览
  let preview: string | undefined
  if (state.allMessages.value.length > 0) {
    const lastUserMsg = state.allMessages.value.filter(m => m.role === 'user' && !m.isFunctionResponse).pop()
    if (lastUserMsg) {
      preview = lastUserMsg.content.slice(0, 50)
    }
  }

  try {
    // HIS-09：updatedAt / messageCount / preview 合并为一次 IPC 写入
    // （updatedAt 由后端历史提交统一维护，不再前端分别 setCustomMetadata 三次）
    await sendToExtension(MESSAGE_NAMES['conversation.updateSummary'], {
      conversationId: state.currentConversationId.value,
      messageCount,
      preview
    })

    // M3：IPC 成功后才更新本地计数（totalMessages/messageCount/updatedAt/preview）——
    // appendHistory 失败时后端会钳制 messageCount，前端保持与后端一致，避免永久超前。
    state.totalMessages.value = messageCount
    if (preview !== undefined) {
      conv.preview = preview
    }
    conv.updatedAt = now
    conv.messageCount = messageCount
  } catch (err) {
    console.error('Failed to update conversation metadata:', err)
  }
}
