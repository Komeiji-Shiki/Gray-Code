/**
 * Background Task Store - 后台任务状态与混合回流
 *
 * 修改原因：subagents/execute_command 支持后台运行后，需要有人负责任务状态展示与结果回流。
 * 修改方式：订阅 webview 转发的 taskEvent；任务完成时按混合语义回流——
 *          目标会话空闲则立即经 chatStore.sendMessage 发送回执（自动触发模型汇总），
 *          正忙则挂起，流结束或切回目标会话时合并补发。
 * 修改目的：等待期间用户可继续互动；任务结果以透明的用户消息进入对话历史。
 */

import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'
import { sendToExtension, onMessageFromExtension } from '../utils/vscode'
import { useChatStore } from './chatStore'
import {
  isBackgroundStartEvent,
  taskRecordFromStartEvent,
  applyCompletionEvent,
  buildCompletionReport,
  type BackgroundTaskRecord,
  type TaskEventLike
} from './backgroundTasks/reportBuilder'

export const useBackgroundTaskStore = defineStore('backgroundTasks', () => {
  const chatStore = useChatStore()

  // ============ 状态 ============

  /** 任务表（不可变更新以保证响应性） */
  const tasks = ref<Record<string, BackgroundTaskRecord>>({})

  const initialized = ref(false)

  // ============ 计算属性 ============

  const taskList = computed(() =>
    Object.values(tasks.value).sort((a, b) => b.startedAt - a.startedAt)
  )

  const runningCount = computed(() =>
    taskList.value.filter(t => t.status === 'running').length
  )

  const hasTasks = computed(() => taskList.value.length > 0)

  /** 已完成但尚未回流给模型的任务数（含非当前会话的） */
  const pendingReportCount = computed(() =>
    taskList.value.filter(t => !t.reported && t.status !== 'running').length
  )

  // ============ 事件处理 ============

  function handleTaskEvent(event: TaskEventLike): void {
    if (!event?.taskId) return

    if (event.type === 'start') {
      if (!isBackgroundStartEvent(event)) return
      tasks.value = { ...tasks.value, [event.taskId]: taskRecordFromStartEvent(event) }
      return
    }

    if (event.type === 'complete' || event.type === 'cancelled' || event.type === 'error') {
      const record = tasks.value[event.taskId]
      // 只处理已登记的后台任务；前台任务的事件不入表
      if (!record || record.status !== 'running') return
      tasks.value = { ...tasks.value, [event.taskId]: applyCompletionEvent(record, event) }
      void flushReports()
    }
  }

  // ============ 混合回流 ============

  let flushing = false

  /**
   * 尝试发送已完成任务的回执。
   *
   * - 会话正忙：直接返回，等待 isStreaming 变化的 watcher 再触发；
   * - 仅发送属于当前会话（或无会话归属）的任务；其他会话的任务等切回后补发；
   * - 多个已完成任务合并为一条回执消息。
   */
  async function flushReports(): Promise<void> {
    if (flushing) return
    if (chatStore.isStreaming || chatStore.isWaitingForResponse) return

    const currentId = chatStore.currentConversationId
    const ready = taskList.value.filter(t =>
      !t.reported
      && t.status !== 'running'
      && (!t.conversationId || t.conversationId === currentId)
    )
    if (ready.length === 0) return

    flushing = true
    try {
      // 前端 complete chunk 会先清理 isStreaming，但后端流此时可能还没走到 finally。
      // 必须等待后端运行控制器确认空闲，避免新回执流中止仍在收尾的旧流。
      if (currentId) {
        await sendToExtension('chat.awaitConversationIdle', { conversationId: currentId })
      }

      // 等待期间可能切换了会话或启动了新流；重新判定，不能把旧会话报告发进新会话。
      if (chatStore.currentConversationId !== currentId
        || chatStore.isStreaming
        || chatStore.isWaitingForResponse) {
        return
      }

      const report = buildCompletionReport(ready)
      // 先乐观标记，避免 await 期间 watcher 再次触发导致重复回执
      const next = { ...tasks.value }
      for (const t of ready) {
        next[t.taskId] = { ...t, reported: true }
      }
      tasks.value = next

      try {
        const sent = await chatStore.sendMessage(report, undefined, { source: 'background_task' })
        // sendMessage 返回 false 表示发送失败（已在内部 catch 中清理状态）
        // 此时需要回滚乐观标记，等待下次 flush 重试
        if (!sent) {
          console.error('Failed to send background task report, will retry later')
          const rollback = { ...tasks.value }
          for (const t of ready) {
            const current = rollback[t.taskId]
            if (current) rollback[t.taskId] = { ...current, reported: false }
          }
          tasks.value = rollback
        }
      } catch (error) {
        // 修改原因：乐观标记后若发送失败，旧实现会让任务永远停留在 reported=true，后台任务结果被永久丢弃。
        // 修改方式：捕获异常并回滚 reported 标记，等待下一次 flush 时机（流结束/切换会话）重试。
        // 修改目的：回执发送失败是可恢复状态，不应静默吞掉已完成任务的产出。
        console.error('Failed to send background task report, will retry later:', error)
        const rollback = { ...tasks.value }
        for (const t of ready) {
          const current = rollback[t.taskId]
          if (current) rollback[t.taskId] = { ...current, reported: false }
        }
        tasks.value = rollback
      }
    } finally {
      flushing = false
    }
  }

  // ============ 操作 ============

  /** 取消运行中的后台任务 */
  async function cancelTask(taskId: string): Promise<void> {
    try {
      await sendToExtension('task.cancel', { taskId })
    } catch (error) {
      console.error('Failed to cancel background task:', error)
    }
  }

  /** 清除已结束的任务 chip（运行中的不可清除） */
  function dismissTask(taskId: string): void {
    const record = tasks.value[taskId]
    if (!record || record.status === 'running') return
    const next = { ...tasks.value }
    delete next[taskId]
    tasks.value = next
  }

  /**
   * 一键清除全部已结束（非 running）的任务 chip。
   * 未回流任务（回执尚未进入对话历史）也一并清除——调用方需自行确认（UI 层弹确认框提示）。
   */
  function dismissCompletedTasks(): void {
    const next = { ...tasks.value }
    let changed = false
    for (const record of taskList.value) {
      if (record.status === 'running') continue
      delete next[record.taskId]
      changed = true
    }
    if (changed) {
      tasks.value = next
    }
  }

  /** 前端重载后恢复仍在运行的后台任务 */
  async function restoreActiveTasks(): Promise<void> {
    try {
      const response = await sendToExtension<{
        tasks: Array<{ id: string; type: string; startTime: number; metadata?: Record<string, unknown> }>
      }>('task.getAll', {})

      for (const task of response?.tasks || []) {
        if (tasks.value[task.id]) continue
        const pseudoStart: TaskEventLike = {
          taskId: task.id,
          taskType: task.type,
          type: 'start',
          data: task.metadata,
          createdAt: task.startTime
        }
        if (isBackgroundStartEvent(pseudoStart)) {
          tasks.value = { ...tasks.value, [task.id]: taskRecordFromStartEvent(pseudoStart) }
        }
      }
    } catch (error) {
      console.error('Failed to restore background tasks:', error)
    }
  }

  // ============ 初始化 ============

  function initialize(): void {
    if (initialized.value) return
    initialized.value = true

    onMessageFromExtension(message => {
      if (message.type === 'taskEvent') {
        handleTaskEvent(message.data as TaskEventLike)
      }
    })

    // 流结束 → 补发挂起回执（混合语义的"忙时暂存，闲时补发"）
    // 修改原因：flushReports 的忙闲判断同时看 isStreaming 和 isWaitingForResponse，但过去只监听前者；
    //          请求在进入流式前就失败时（isWaitingForResponse true→false 而 isStreaming 始终为 false），
    //          挂起的回执不会被补发，要一直等到下一次流结束或切换会话。
    // 修改方式：两个忙闲信号都监听，任一转为空闲即尝试补发（flushReports 自身幂等且有 flushing 保护）。
    // 修改目的：忙闲判断条件与补发触发条件保持一致。
    watch(() => chatStore.isStreaming, streaming => {
      if (!streaming) void flushReports()
    })
    watch(() => chatStore.isWaitingForResponse, waiting => {
      if (!waiting) void flushReports()
    })

    // 切换会话 → 补发属于新会话的挂起回执
    watch(() => chatStore.currentConversationId, () => {
      void flushReports()
    })

    void restoreActiveTasks()
  }

  return {
    tasks,
    taskList,
    runningCount,
    hasTasks,
    pendingReportCount,
    initialize,
    handleTaskEvent,
    flushReports,
    cancelTask,
    dismissTask,
    dismissCompletedTasks
  }
})
