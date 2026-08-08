/**
 * Background Task Store - 后台任务状态与混合回流
 *
 * 修改原因：subagents/execute_command 支持后台运行后，需要有人负责任务状态展示与结果回流。
 * 修改方式：订阅 webview 转发的 taskEvent；任务完成时按混合语义回流——
 *          目标会话空闲则立即经 chatStore.sendMessage 发送回执（自动触发模型汇总），
 *          正忙则挂起，流结束或切回目标会话时合并补发；
 *          P2 增强：LLM 动作边界（非终结 toolIteration）时若无排队消息，
 *          也提前投递回执（flushReportsAfterAction），不再硬等模型回合结束。
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

  /** 把一批任务乐观标记为已回流（不可变更新，保证响应性） */
  function markReported(records: BackgroundTaskRecord[]): void {
    const next = { ...tasks.value }
    for (const t of records) {
      // 存在性检查：投递窗口（cancelStream 往返）内用户可能已 dismiss 该任务，
      // 不能把已清除的任务复活回任务表
      if (!next[t.taskId]) continue
      next[t.taskId] = { ...t, reported: true }
    }
    tasks.value = next
  }

  /** 把一批任务回滚为未回流（发送失败/放弃投递时恢复，等待下次补发） */
  function rollbackReported(records: BackgroundTaskRecord[]): void {
    const next = { ...tasks.value }
    for (const t of records) {
      const current = next[t.taskId]
      if (current) next[t.taskId] = { ...current, reported: false }
    }
    tasks.value = next
  }

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
      // 等待必须有超时兜底（后端 waitForIdle 在极端挂死场景可能不返回，回执会永久滞留）：
      // 超时后放弃本次 flush，任务保持 unreported，由下一次 flush 重试——
      // 绝不能提前写入，否则回执会被旧流结算覆盖。
      if (currentId) {
        try {
          await sendToExtension('chat.awaitConversationIdle', { conversationId: currentId }, { timeoutMs: 20000 })
        } catch (error) {
          console.warn('[backgroundTaskStore] awaitConversationIdle timed out, will retry on next flush:', error)
          return
        }
      }

      // 等待期间可能切换了会话或启动了新流；重新判定，不能把旧会话报告发进新会话。
      if (chatStore.currentConversationId !== currentId
        || chatStore.isStreaming
        || chatStore.isWaitingForResponse) {
        return
      }

      const report = buildCompletionReport(ready)
      // 先乐观标记，避免 await 期间 watcher 再次触发导致重复回执
      markReported(ready)

      try {
        const sent = await chatStore.sendMessage(report, undefined, { source: 'background_task' })
        // sendMessage 返回 false 表示发送失败（已在内部 catch 中清理状态）
        // 此时需要回滚乐观标记，等待下次 flush 重试
        if (!sent) {
          console.error('Failed to send background task report, will retry later')
          rollbackReported(ready)
        }
      } catch (error) {
        // 修改原因：乐观标记后若发送失败，旧实现会让任务永远停留在 reported=true，后台任务结果被永久丢弃。
        // 修改方式：捕获异常并回滚 reported 标记，等待下一次 flush 时机（流结束/切换会话）重试。
        // 修改目的：回执发送失败是可恢复状态，不应静默吞掉已完成任务的产出。
        console.error('Failed to send background task report, will retry later:', error)
        rollbackReported(ready)
      }
    } finally {
      flushing = false
    }
  }

  /**
   * 动作边界回执投递（P2）：LLM 执行完当前动作（非终结 toolIteration，流继续）后
   * 立即投递已完成后台任务的回执，不再等待整个回合完整结束。
   *
   * 与 flushReports（回合结束/空闲投递）的职责分工：
   * - flushReports：回合结束后（complete/cancelled/error 或流空闲）补发，等待后端空闲；
   * - flushReportsAfterAction：动作边界提前投递，与排队消息提前投递
   *   （chatStore.processQueueAfterAction）同构——cancelStream({preserveSubAgents:true})
   *   替换当前回合 + sendMessage 开启新回合，由 H1 写序保证旧流完全退出后才写入新消息。
   *
   * 安全护栏（复用 processQueueAfterAction 的既有语义）：
   * 1. 动作彻底结束：由调用方（非终结 toolIteration 边界）保证工具结果已落盘；
   * 2. 跨会话防护：只投递属于当前会话（或无会话归属）的任务；
   * 3. 投递窗口（cancelStream 往返）内会话切换或并发发送者抢先开启新流：
   *    放弃本次投递并回滚 reported（保持未回流），等待下一个动作边界或回合结束时补发；
   * 4. 发送失败回滚 reported，不静默丢弃任务产出。
   */
  async function flushReportsAfterAction(): Promise<void> {
    if (flushing) return

    const currentId = chatStore.currentConversationId
    const ready = taskList.value.filter(t =>
      !t.reported
      && t.status !== 'running'
      && (!t.conversationId || t.conversationId === currentId)
    )
    if (ready.length === 0) return

    flushing = true
    try {
      // 动作边界必然仍在响应中（流继续）；防御性判断以兼容迟到的调度
      // 与重检条件对称（isStreaming/isWaitingForResponse 任一活跃即需替换回合）
      if (chatStore.isWaitingForResponse || chatStore.isStreaming) {
        await chatStore.cancelStream({ preserveSubAgents: true })
      }

      // 投递窗口内会话已切换：放弃本次，任务保持未回流，等待切回原会话后补发
      if (chatStore.currentConversationId !== currentId) {
        return
      }

      // 投递窗口内已有其他发送者抢先开启新流：放弃本次，等待下一动作边界/回合结束
      if (chatStore.isStreaming || chatStore.isWaitingForResponse) {
        return
      }

      const report = buildCompletionReport(ready)
      markReported(ready)

      try {
        const sent = await chatStore.sendMessage(report, undefined, { source: 'background_task' })
        if (!sent) {
          console.error('Failed to send background task report after action, will retry later')
          rollbackReported(ready)
        }
      } catch (error) {
        console.error('Failed to send background task report after action, will retry later:', error)
        rollbackReported(ready)
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
    flushReportsAfterAction,
    cancelTask,
    dismissTask,
    dismissCompletedTasks
  }
})
