/**
 * Chat Store 对话尾部版本操作（重roll树状分叉）
 *
 * 用户对 AI 回答点击「重新生成」时，旧回答及其后续内容不会直接删除，
 * 而是保存为版本；重roll 出来的新回答成为新的活跃尾部。版本之间可随时
 * 来回切换（DeepSeek 网页版式 v1/v2/v3 分叉体验）。
 */

import type { ChatStoreState, TailVersionInfo } from './types'
import { sendToExtension } from '../../utils/vscode'
import { validateSessionIdentity } from './utils'

/** 写入当前对话的版本列表（按会话隔离） */
export function setTailVersionsForConversation(
  state: ChatStoreState,
  conversationId: string,
  versions: TailVersionInfo[]
): void {
  state.tailVersionsByConversation.value = {
    ...state.tailVersionsByConversation.value,
    [conversationId]: Array.isArray(versions) ? versions : []
  }
}

/** 读取某会话的版本列表（未加载时返回空数组） */
export function getTailVersionsForConversation(
  state: ChatStoreState,
  conversationId: string | null | undefined
): TailVersionInfo[] {
  if (!conversationId) return []
  return state.tailVersionsByConversation.value[conversationId] || []
}

/** 记录某个分支点当前恢复的版本（null = 最新生成的当前答案） */
export function setActiveTailVersion(
  state: ChatStoreState,
  conversationId: string,
  branchIndex: number,
  versionId: string | null
): void {
  state.activeTailVersionByBranch.value = {
    ...state.activeTailVersionByBranch.value,
    [`${conversationId}:${branchIndex}`]: versionId
  }
}

/**
 * 消息尾部发生变化（发送/编辑/删除等）后重置整个会话的活跃版本标记：
 * 之后的尾部都是「最新当前答案」，版本切换器回到最新位置。
 */
export function resetActiveTailVersionsForConversation(state: ChatStoreState, conversationId: string): void {
  const prefix = `${conversationId}:`
  const current = state.activeTailVersionByBranch.value
  let changed = false
  const next: Record<string, string | null> = {}
  for (const [key, value] of Object.entries(current)) {
    if (key.startsWith(prefix)) {
      changed = true
      continue
    }
    next[key] = value
  }
  if (changed) {
    state.activeTailVersionByBranch.value = next
  }
}

/**
 * 拉取某对话的全部尾部版本摘要（不阻塞主链路，失败静默）。
 */
export async function refreshTailVersions(state: ChatStoreState, conversationId: string): Promise<void> {
  if (!conversationId) return
  if (state.tailVersionsLoading.value[conversationId]) return

  state.tailVersionsLoading.value = {
    ...state.tailVersionsLoading.value,
    [conversationId]: true
  }
  try {
    const result = await sendToExtension<{ versions: TailVersionInfo[] }>('conversation.getTailVersions', {
      conversationId
    })
    if (result?.versions) {
      setTailVersionsForConversation(state, conversationId, result.versions)
    }
  } catch (error) {
    console.warn('[tailVersionActions] Failed to refresh tail versions:', error)
  } finally {
    state.tailVersionsLoading.value = {
      ...state.tailVersionsLoading.value,
      [conversationId]: false
    }
  }
}

/**
 * 重roll 前保存当前尾部版本（由 retryFromMessage 调用）。
 *
 * @returns 保存后的版本列表（含新版本）；失败返回 null（不阻塞重roll 本身）
 */
export async function saveTailVersionForRetry(
  state: ChatStoreState,
  conversationId: string,
  branchIndex: number
): Promise<TailVersionInfo[] | null> {
  if (!conversationId || !Number.isFinite(branchIndex) || branchIndex < 0) return null
  try {
    const result = await sendToExtension<{ versions: TailVersionInfo[] }>('conversation.saveTailVersion', {
      conversationId,
      branchIndex
    })
    if (result?.versions) {
      setTailVersionsForConversation(state, conversationId, result.versions)
      return result.versions
    }
    return null
  } catch (error) {
    console.warn('[tailVersionActions] Failed to save tail version before retry:', error)
    return null
  }
}

/**
 * 切换到指定版本的尾部。
 *
 * 后端会先保存当前活跃尾部（内容重复时跳过），再把 transcript 截断到分支点
 * 并恢复目标版本；前端随后重新加载消息窗口以反映切换结果。
 */
export async function switchTailVersion(
  state: ChatStoreState,
  conversationId: string,
  branchIndex: number,
  versionId: string,
  reloadHistory: () => Promise<void>
): Promise<boolean> {
  if (!conversationId || !versionId) return false
  if (state.isStreaming.value || state.isWaitingForResponse.value) return false

  const key = `${conversationId}:${branchIndex}:${versionId}`
  if (state.tailVersionSwitching.value.has(key)) return false

  const nextSet = new Set(state.tailVersionSwitching.value)
  nextSet.add(key)
  state.tailVersionSwitching.value = nextSet

  const originConvId = state.currentConversationId.value
  try {
    const result = await sendToExtension<{ versions: TailVersionInfo[] }>('conversation.restoreTailVersion', {
      conversationId,
      branchIndex,
      versionId
    })
    if (!validateSessionIdentity(state, originConvId)) return false

    if (result?.versions) {
      setTailVersionsForConversation(state, conversationId, result.versions)
    }
    // 切换成功后标记活跃版本（用于版本切换器位置/高亮）
    setActiveTailVersion(state, conversationId, branchIndex, versionId)
    // 切换后消息窗口已改变：整体重载最后一页
    await reloadHistory()
    return true
  } catch (error: any) {
    console.error('[tailVersionActions] Failed to switch tail version:', error)
    state.error.value = {
      code: error?.code || 'SWITCH_TAIL_VERSION_ERROR',
      message: error?.message || 'Failed to switch tail version'
    }
    return false
  } finally {
    const finalSet = new Set(state.tailVersionSwitching.value)
    finalSet.delete(key)
    state.tailVersionSwitching.value = finalSet
  }
}
