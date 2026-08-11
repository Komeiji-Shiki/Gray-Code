/**
 * Chat Store 配置操作
 * 
 * 包含配置的加载和切换
 */

import { MESSAGE_NAMES } from '@shared/protocol'
import type { ChatStoreState, WorkspaceFolderInfo } from './types'
import { sendToExtension, showNotification } from '../../utils/vscode'

const CONVERSATION_MODEL_CONFIG_KEY = 'inputModelConfig'
const CONVERSATION_PROMPT_MODE_KEY = 'promptModeConfig'

const DEFAULT_PROMPT_MODE_ID = 'code'

export interface ConversationModelConfig {
  configId?: string
  modelId?: string
}

export interface ConversationPromptModeConfig {
  modeId?: string
}

function normalizeModelId(modelId: string | null | undefined): string { return (modelId || '').trim() }

/**
 * 加载当前配置详情
 *
 * 竞态防护：入口固化 configId，await 后校验未变才写入。
 * switchTabWrapped 会 fire-and-forget 调用本函数，快速切换标签页时旧请求的迟到响应
 * 不得覆盖新标签页的 currentConfig / selectedModelId。
 */
export async function loadCurrentConfig(state: ChatStoreState): Promise<void> {
  const configIdAtStart = state.configId.value
  if (!configIdAtStart) {
    state.currentConfig.value = null
    state.selectedModelId.value = ''
    return
  }
  try {
    const config = await sendToExtension<any>(MESSAGE_NAMES['config.getConfig'], { configId: configIdAtStart })
    // 归属校验：await 期间 configId 可能已切换（如快速切换标签页触发新的 loadCurrentConfig），
    // 迟到的旧响应直接丢弃，避免把 A 标签页的配置写进 B 标签页
    if (configIdAtStart !== state.configId.value) return
    if (config) {
      // 模型回退：model 为空时使用 models 列表第一个模型（后端 getConfig 已解析，这里兜底）
      const resolvedModel = config.model || config.models?.[0]?.id || ''
      state.currentConfig.value = {
        id: config.id,
        name: config.name,
        model: resolvedModel,
        type: config.type,
        maxContextTokens: config.maxContextTokens
      }

      if (!normalizeModelId(state.selectedModelId.value)) {
        state.selectedModelId.value = resolvedModel
      }
    }
  } catch (err) {
    console.error('Failed to load current config:', err)
  }
}

/**
 * 持久化当前对话的渠道/模型选择
 */
export async function persistConversationModelConfig(state: ChatStoreState): Promise<void> {
  const conversationId = state.currentConversationId.value
  if (!conversationId) return

  const payload: ConversationModelConfig = {
    configId: state.configId.value,
    modelId: normalizeModelId(state.selectedModelId.value)
  }

  try {
    await sendToExtension(MESSAGE_NAMES['conversation.setCustomMetadata'], {
      conversationId,
      key: CONVERSATION_MODEL_CONFIG_KEY,
      value: payload
    })
  } catch (error) {
    console.error('Failed to persist conversation model config:', error)
  }
}

/**
 * 应用对话保存的渠道/模型选择
 */
export async function applyConversationModelConfig(
  state: ChatStoreState,
  conversationId: string,
  storedOverride?: ConversationModelConfig
): Promise<void> {
  try {
    const stored = storedOverride || await (async () => {
      const metadata = await sendToExtension<any>(MESSAGE_NAMES['conversation.getConversationMetadata'], { conversationId })
      return metadata?.custom?.[CONVERSATION_MODEL_CONFIG_KEY] as ConversationModelConfig | undefined
    })()

    const storedConfigId = typeof stored?.configId === 'string' ? stored.configId.trim() : ''
    const storedModelId = typeof stored?.modelId === 'string' ? stored.modelId.trim() : ''

    if (storedConfigId) {
      state.configId.value = storedConfigId
      await loadCurrentConfig(state)
      state.selectedModelId.value = storedModelId || state.currentConfig.value?.model || ''
      return
    }

    // 未存储对话级配置：至少确保 currentConfig 与 configId 对齐
    await loadCurrentConfig(state)
    state.selectedModelId.value = state.currentConfig.value?.model || ''
  } catch (error) {
    console.error('Failed to apply conversation model config:', error)
    // 兜底：确保 currentConfig / selectedModelId 不为空
    await loadCurrentConfig(state)
    state.selectedModelId.value = state.currentConfig.value?.model || ''
  }
}

/**
 * 设置当前对话的 Prompt 模式 ID（对话级隔离）
 *
 * 仅更新当前会话状态并持久化到对话元数据。
 */
export async function setCurrentPromptModeId(state: ChatStoreState, modeId: string): Promise<void> {
  state.currentPromptModeId.value = modeId
  await persistConversationPromptMode(state)
}

/**
 * 持久化当前对话的 Prompt 模式 ID 到对话元数据
 */
export async function persistConversationPromptMode(state: ChatStoreState): Promise<void> {
  const conversationId = state.currentConversationId.value
  if (!conversationId) return

  try {
    await sendToExtension(MESSAGE_NAMES['conversation.setCustomMetadata'], {
      conversationId,
      key: CONVERSATION_PROMPT_MODE_KEY,
      value: { modeId: state.currentPromptModeId.value }
    })
  } catch (error) {
    console.error('Failed to persist conversation prompt mode:', error)
  }
}

/**
 * 从对话元数据恢复 Prompt 模式 ID
 *
 * 在切换对话时调用，从后端读取该对话保存的模式；
 * 如果没有保存过，使用默认 'code' 模式
 */
export async function applyConversationPromptMode(
  state: ChatStoreState,
  conversationId: string,
  storedOverride?: ConversationPromptModeConfig
): Promise<void> {
  try {
    const stored = storedOverride || await (async () => {
      const metadata = await sendToExtension<any>(MESSAGE_NAMES['conversation.getConversationMetadata'], { conversationId })
      return metadata?.custom?.[CONVERSATION_PROMPT_MODE_KEY] as ConversationPromptModeConfig | undefined
    })()
    const modeId = typeof stored?.modeId === 'string' ? stored.modeId.trim() : ''

    state.currentPromptModeId.value = modeId || DEFAULT_PROMPT_MODE_ID
  } catch (error) {
    console.error('Failed to apply conversation prompt mode:', error)
    state.currentPromptModeId.value = DEFAULT_PROMPT_MODE_ID
  }
}


/**
 * 设置当前会话模型
 */
export async function setSelectedModelId(state: ChatStoreState, modelId: string): Promise<void> {
  state.selectedModelId.value = normalizeModelId(modelId)
  await persistConversationModelConfig(state)
}

/**
 * 切换配置
 *
 * 同时保存到后端持久化存储
 */
export async function setConfigId(state: ChatStoreState, newConfigId: string): Promise<void> {
  state.configId.value = newConfigId
  await loadCurrentConfig(state)
  state.selectedModelId.value = state.currentConfig.value?.model || ''
  
  // 保存到后端
  try {
    await sendToExtension(MESSAGE_NAMES['settings.setActiveChannelId'], { channelId: newConfigId })
  } catch (error) {
    console.error('Failed to save active channel ID:', error)
  }

  await persistConversationModelConfig(state)
}

/**
 * 从后端加载保存的配置ID
 */
export async function loadSavedConfigId(state: ChatStoreState): Promise<void> {
  try {
    const response = await sendToExtension<{ channelId?: string }>(MESSAGE_NAMES['settings.getActiveChannelId'], {})
    if (response?.channelId) {
      state.configId.value = response.channelId
    }

    await loadCurrentConfig(state)
    state.selectedModelId.value = state.currentConfig.value?.model || ''
  } catch (error) {
    console.error('Failed to load saved config ID:', error)
  }
}

/**
 * 加载存档点配置（合并设置）
 */
export async function loadCheckpointConfig(state: ChatStoreState): Promise<void> {
  try {
    const response = await sendToExtension<{ config: any }>(MESSAGE_NAMES['checkpoint.getConfig'], {})
    if (response?.config?.messageCheckpoint) {
      state.mergeUnchangedCheckpoints.value = response.config.messageCheckpoint.mergeUnchangedCheckpoints ?? true
    }
  } catch (error) {
    console.error('Failed to load checkpoint config:', error)
  }
}

/**
 * 更新存档点合并设置
 */
export function setMergeUnchangedCheckpoints(state: ChatStoreState, value: boolean): void {
  state.mergeUnchangedCheckpoints.value = value
}

/**
 * 设置当前工作区 URI
 */
export function setCurrentWorkspaceUri(state: ChatStoreState, uri: string | null): void {
  state.currentWorkspaceUri.value = uri
}

/**
 * 设置打开的工作区文件夹列表
 */
export function setWorkspaceList(state: ChatStoreState, list: WorkspaceFolderInfo[]): void {
  state.workspaceList.value = list
}

/**
 * 设置活动工作区（null = 取消固定，跟随活动编辑器）
 *
 * 1.7.3 修复：对话内禁止切换/重绑定工作区——本函数只固定扩展端激活工作区并
 * 返回规范 URI，**不再改写当前对话绑定**（此前下拉切换会把当前对话重绑定到
 * 新工作区，导致「对话内强行切换后绑定失效/标题与绑定错位」）。
 * 切换工作区 = 打开绑定新工作区的新对话，由 chatStore 层
 * `openWorkspaceInNewConversation`（tabActions）统一处理标签页与工作区上下文。
 *
 * 注意：本函数不修改 state.currentWorkspaceUri——切换后的工作区上下文由
 * 标签页流程在快照/恢复之后设置，避免把旧对话标签页的快照写成新工作区。
 */
export async function setActiveWorkspace(workspaceUri: string | null): Promise<any> {
  try {
    return await sendToExtension<any>('workspace.setActive', { workspaceUri })
  } catch (error) {
    console.warn('[configActions] Failed to set active workspace:', error)
    return null
  }
}

/**
 * 设置工作区筛选模式
 */
export function setWorkspaceFilter(state: ChatStoreState, filter: 'current' | 'all'): void {
  state.workspaceFilter.value = filter
}

/**
 * 设置收藏工作区列表（持久化在宿主侧，前端只做展示缓存）
 */
export function setSavedWorkspaces(state: ChatStoreState, list: WorkspaceFolderInfo[]): void {
  state.savedWorkspaces.value = list
}

/**
 * 加载收藏工作区列表（初始化时调用）
 */
export async function loadSavedWorkspaces(state: ChatStoreState): Promise<void> {
  try {
    const resp = await sendToExtension<any>('workspace.getSaved', {})
    if (Array.isArray(resp?.saved)) {
      setSavedWorkspaces(state, resp.saved)
    }
  } catch (error) {
    console.warn('[configActions] Failed to load saved workspaces:', error)
  }
}

/**
 * 从收藏列表移除工作区（仅移除收藏，不影响已打开的工作区）
 */
export async function removeSavedWorkspace(state: ChatStoreState, fsPath: string): Promise<void> {
  try {
    const resp = await sendToExtension<any>('workspace.removeSaved', { fsPath })
    if (Array.isArray(resp?.saved)) {
      setSavedWorkspaces(state, resp.saved)
    }
  } catch (error) {
    console.warn('[configActions] Failed to remove saved workspace:', error)
  }
}

/**
 * 打开工作区文件夹（不传 fsPath 时由宿主弹出文件夹选择对话框），
 * 打开后自动加入收藏并同步工作区状态
 */
export async function openWorkspaceFolderAction(state: ChatStoreState, fsPath?: string): Promise<any> {
  try {
    const resp = await sendToExtension<any>('workspace.openFolder', { fsPath: fsPath ?? null })
    if (resp?.success === false && resp?.canceled) {
      // 用户在对话框里取消：不是错误，不打扰
      return resp
    }
    if (Array.isArray(resp?.workspaces)) {
      setWorkspaceList(state, resp.workspaces)
    }
    if (Array.isArray(resp?.saved)) {
      setSavedWorkspaces(state, resp.saved)
    }
    // 1.7.3 修复：打开工作区后**不**改写当前对话绑定——对话内禁止切换工作区，
    // 打开新工作区 = 打开绑定该工作区的新对话，由 chatStore 层
    // openWorkspaceInNewConversation（tabActions）负责标签页与工作区上下文切换。
    return resp
  } catch (error: any) {
    // 打开失败（收藏目录已被删除/移动、超时等）不能静默吞掉：
    // 此前仅 console.warn，用户看到「点了没反应」。
    const message = error?.message || String(error)
    console.warn('[configActions] Failed to open workspace folder:', error)
    void showNotification(message, 'error')
    return null
  }
}

/**
 * 打开收藏的工作区（未打开时走目录打开流程）
 *
 * 1.7.3 修复：已在当前窗口打开的收藏工作区由 chatStore 层按「切换工作区」语义处理
 * （打开绑定该工作区的新对话，见 tabActions.openWorkspaceInNewConversation）；
 * 本函数只负责未打开收藏的目录打开流程。
 */
export async function openSavedWorkspace(state: ChatStoreState, entry: WorkspaceFolderInfo): Promise<any> {
  return openWorkspaceFolderAction(state, entry.fsPath)
}

/**
 * 设置输入框内容
 */
export function setInputValue(state: ChatStoreState, value: string): void {
  state.inputValue.value = value
}

/**
 * 清空输入框
 */
export function clearInputValue(state: ChatStoreState): void {
  state.inputValue.value = ''
}

/**
 * 处理重试状态事件
 *
 * 如果 status 携带 conversationId 且不是当前活跃对话，
 * 则将重试状态写入该对话对应的标签页快照，避免跨对话状态泄漏。
 */
export function handleRetryStatus(
  state: ChatStoreState,
  status: {
    type: 'retrying' | 'retrySuccess' | 'retryFailed'
    attempt: number
    maxAttempts: number
    error?: string
    errorDetails?: any
    nextRetryIn?: number
    conversationId?: string
  }
): void {
  const targetConvId = status.conversationId
  const isCurrent = !targetConvId || targetConvId === state.currentConversationId.value

  if (status.type === 'retrying') {
    const retryValue = {
      isRetrying: true,
      attempt: status.attempt,
      maxAttempts: status.maxAttempts,
      error: status.error,
      errorDetails: status.errorDetails,
      nextRetryIn: status.nextRetryIn
    }

    if (isCurrent) {
      state.retryStatus.value = retryValue
    } else {
      // 非当前对话 -> 写入对应标签页的快照
      const tab = state.openTabs.value.find(t => t.conversationId === targetConvId)
      if (tab) {
        const snapshot = state.sessionSnapshots.value.get(tab.id)
        if (snapshot) {
          snapshot.retryStatus = retryValue
        }
      }
    }
  } else if (status.type === 'retrySuccess' || status.type === 'retryFailed') {
    if (isCurrent) {
      state.retryStatus.value = null
    } else {
      // 非当前对话 -> 清除对应快照中的重试状态
      const tab = state.openTabs.value.find(t => t.conversationId === targetConvId)
      if (tab) {
        const snapshot = state.sessionSnapshots.value.get(tab.id)
        if (snapshot) {
          snapshot.retryStatus = null
        }
      }
    }
  }
}
