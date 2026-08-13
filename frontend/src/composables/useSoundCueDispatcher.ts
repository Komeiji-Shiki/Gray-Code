/**
 * useSoundCueDispatcher - 声音事件编排 Composable
 *
 * 从 App.vue 拆分（F-06）：
 * - 错误提示音去重（同一错误只响一次）
 * - toolStatus chunk → 工具完成 / 子代理完成 / 任务错误提示音映射与去重
 * - TODO 全部完成（false→true）提示音检测
 * - 流式 chunk 提示音分发与迟到 chunk 过滤
 * - 重试状态提示音去重
 *
 * App.vue 仅保留事件接线：把 extension 消息路由到这里的处理方法。
 */

import { reactive, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import type { StreamChunk } from '../types'
import type { SoundAgentRole } from '../services/soundCues'
import { handleSoundEvent } from '../services/soundEventController'
import { useChatStore } from '../stores'

type ChatStore = ReturnType<typeof useChatStore>

type ConversationCue = 'warning' | 'error' | 'taskComplete' | 'taskError'
type ConversationCueSource = 'taskEvent' | 'retryStatus' | 'streamChunk' | 'chatError'

interface RetryStatusMessage {
  type?: unknown
  attempt?: unknown
  conversationId?: unknown
  createdAt?: unknown
}

export function useSoundCueDispatcher(chatStore: ChatStore) {
  // ============ 错误提示音：同一错误去重，避免重复触发 ============

  const lastErrorKey = ref('')
  const { error: errorRef } = storeToRefs(chatStore)
  watch(errorRef, (err) => {
    // 仅在错误消息变化时触发一次声音，具体播放由统一控制器处理
    // 这里不再直接调用 playCue，避免绕过过期丢弃与隐藏态折叠逻辑
    // createdAt 使用前端接收到错误变化的当前时间即可

    if (!err) {
      lastErrorKey.value = ''
      return
    }
    const key = `${err.code}:${err.message}`
    if (key === lastErrorKey.value) return
    lastErrorKey.value = key
    void handleSoundEvent({ cue: 'error', source: 'chatError', createdAt: Date.now() })
  })

  // ============ 声音事件：去重状态 & 辅助函数 ============

  /** 已触发过 taskComplete 音效的 toolStatus id 集合（避免同一工具重复播放） */
  const soundPlayedToolIds = reactive(new Set<string>())
  /** 去重集合容量上限：超出后整体清空，防止随会话运行无限增长 */
  const SOUND_PLAYED_TOOL_IDS_LIMIT = 500

  /** 记录已播放音效的工具 id（带容量上限，防止无限增长） */
  function addSoundPlayedToolId(toolId: string): void {
    soundPlayedToolIds.add(toolId)
    if (soundPlayedToolIds.size > SOUND_PLAYED_TOOL_IDS_LIMIT) {
      soundPlayedToolIds.clear()
    }
  }

  /** 上一次各对话的 TODO 全部完成状态（false→true 时触发音效） */
  const todoAllDoneByConv = reactive(new Map<string, boolean>())

  /** 上一次重试 attempt 编号（同一 attempt 不重复播放） */
  const lastRetryAttempt = ref(-1)

  /**
   * 统一的声音事件分发入口（经由 soundEventController 做过期丢弃 / 隐藏折叠 / 焦点门控）。
   */
  function dispatchConversationCue(
    cue: ConversationCue,
    source: ConversationCueSource,
    conversationId?: string,
    createdAt?: number,
    role?: SoundAgentRole
  ): void {
    void handleSoundEvent({
      cue,
      source,
      conversationId,
      createdAt,
      role
    })
  }

  /**
   * 从 toolStatus chunk 中检测特定工具完成并播放音效：
   * - create_plan 成功 → taskComplete
   * - todo_write / todo_update 导致 TODO 全部完成 → taskComplete
   * - subagents 工具成功/失败 → 子代理独立 taskComplete/taskError（role: subagent）
   */
  function handleSoundForToolStatus(chunk: StreamChunk): void {
    if (!chunk.toolStatus || !chunk.tool) return
    const tool = chunk.tool

    // 去重：同一个 tool id 只播放一次
    if (soundPlayedToolIds.has(tool.id)) return

    // 子代理工具：成功 → 子代理任务完成音；失败 → 子代理任务失败音。
    // 与主聊天工具的提示音开关分开控制（cues.subagent.*）。
    if (tool.name === 'subagents') {
      // 后台模式：工具在启动瞬间即返回 { success: true, data: { background: true } } stub，
      // 真实完成/失败由 taskEvent（background_subagent）送达——若在这里播会「开始就响一次、
      // 完成再响一次」。跳过 stub，交给 taskEvent 路径统一播报。
      const resultData = tool.result?.data as Record<string, unknown> | undefined
      if (tool.status === 'success' && resultData?.background === true) return
      if (tool.status === 'success' || tool.status === 'error') {
        addSoundPlayedToolId(tool.id)
        dispatchConversationCue(
          tool.status === 'error' ? 'taskError' : 'taskComplete',
          'streamChunk',
          chunk.conversationId,
          chunk.createdAt,
          'subagent'
        )
      }
      return
    }

    if (tool.status !== 'success') return

    // create_plan 成功
    if (tool.name === 'create_plan') {
      addSoundPlayedToolId(tool.id)
      dispatchConversationCue('taskComplete', 'streamChunk', chunk.conversationId, chunk.createdAt)
      return
    }

    // todo_write / todo_update 全部完成检测
    if (tool.name === 'todo_write' || tool.name === 'todo_update') {
      const result = tool.result as Record<string, unknown> | undefined
      if (!result) return
      const data = (result.data ?? result) as Record<string, unknown>
      const total = typeof data.total === 'number' ? data.total : -1
      const counts = data.counts as Record<string, number> | undefined
      if (!counts || total <= 0) return

      const pending = typeof counts.pending === 'number' ? counts.pending : -1
      const inProgress = typeof counts.in_progress === 'number' ? counts.in_progress : -1
      const isAllDone = pending === 0 && inProgress === 0

      // 获取对话 id（从 chunk 或当前对话）
      const convId = chunk.conversationId || chatStore.currentConversationId || '__default'
      const wasAllDone = todoAllDoneByConv.get(convId) ?? false

      todoAllDoneByConv.set(convId, isAllDone)

      // 容量上限：防止 Map 随会话运行无限增长；清空时保留当前会话条目，避免当前会话重复播放
      if (todoAllDoneByConv.size > SOUND_PLAYED_TOOL_IDS_LIMIT) {
        const currentValue = todoAllDoneByConv.get(convId)
        todoAllDoneByConv.clear()
        if (currentValue !== undefined) {
          todoAllDoneByConv.set(convId, currentValue)
        }
      }

      // 仅在 false→true 时播放
      if (isAllDone && !wasAllDone) {
        soundPlayedToolIds.add(tool.id)
        dispatchConversationCue('taskComplete', 'streamChunk', convId, chunk.createdAt)
      }
    }
  }

  /**
   * 处理流式 chunk 中的声音事件
   */
  function handleSoundForStreamChunk(chunk: StreamChunk): void {
    if (chunk.type === 'complete') {
      dispatchConversationCue('taskComplete', 'streamChunk', chunk.conversationId, chunk.createdAt)
    } else if (chunk.type === 'toolStatus') {
      handleSoundForToolStatus(chunk)
    }
  }

  /**
   * 仅处理“当前已打开标签页”的有效 chunk，支持多标签页并发提示音。
   *
   * 规则：
   * - 对于当前激活会话：使用 chatStore.activeStreamId 过滤迟到 chunk
   * - 对于后台标签页会话：使用会话快照中的 activeStreamId 过滤迟到 chunk
   */
  function shouldHandleSoundForStreamChunk(chunk: StreamChunk): boolean {
    const convId = chunk.conversationId
    if (!convId) return false

    const currentConversationId = chatStore.currentConversationId || null
    const tab = chatStore.openTabs.find(t => t.conversationId === convId)

    // 仅处理“当前会话”或“已打开标签页中的会话”
    if (!tab && convId !== currentConversationId) return false

    const isCurrentConversation = convId === currentConversationId
    const snapshotStreamId = tab ? (chatStore.sessionSnapshots.get(tab.id)?.activeStreamId || null) : null
    // 后台标签页：快照可能因标签页刚打开/流刚启动尚未绑定 streamId 而过期缺失。
    // 快照缺失时回退到与 store 最新 activeStreamId 宽松匹配，避免漏掉后台标签页的声音提示。
    const expectedStreamId = isCurrentConversation
      ? (chatStore.activeStreamId || null)
      : (snapshotStreamId || chatStore.activeStreamId || null)

    // 没有预期 streamId 时，不接收带 streamId 的 chunk（通常是迟到包）
    if (chunk.streamId && !expectedStreamId) return false

    // 预期 streamId 不匹配，丢弃
    if (expectedStreamId && chunk.streamId && chunk.streamId !== expectedStreamId) return false

    return true
  }

  /**
   * 重试警告声音提醒（去重：同一 attempt 不重复播放；终结事件复位计数）。
   */
  function handleRetryStatus(status: unknown): void {
    const data = status as RetryStatusMessage | null | undefined
    if (data?.type === 'retrying') {
      const attempt = typeof data.attempt === 'number' ? data.attempt : -1
      if (attempt !== lastRetryAttempt.value) {
        lastRetryAttempt.value = attempt
        const convId = typeof data.conversationId === 'string' ? data.conversationId : undefined
        const createdAt = typeof data.createdAt === 'number' ? data.createdAt : undefined
        dispatchConversationCue('warning', 'retryStatus', convId, createdAt)
      }
    } else {
      // retrySuccess / retryFailed -> 重置 attempt 去重计数
      lastRetryAttempt.value = -1
    }
  }

  return {
    dispatchConversationCue,
    handleSoundForStreamChunk,
    shouldHandleSoundForStreamChunk,
    handleRetryStatus
  }
}
