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

import { MESSAGE_NAMES } from '@shared/protocol'
import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'
import { sendToExtension, onExtensionCommand } from '../utils/vscode'
import {
  isBackgroundStartEvent,
  taskRecordFromStartEvent,
  applyCompletionEvent,
  buildCompletionReport,
  type BackgroundTaskRecord,
  type TaskEventLike
} from './backgroundTasks/reportBuilder'
// 单向桥接：本 store 不再 import chatStore（曾与 chatStore 构成模块级 import 环），
// 会话状态/操作面经 backgroundTasks/bridge 注册表消费（chatStore 实例创建时注册）。
import { getChatBridge, resolveChatBridge } from './backgroundTasks/bridge'
// A-COMM 接管窗口标记：claim 领取后到内部回流流启动前，用户消息不走忙时插话投递
import {
    markAgentMessageRoundPending,
    clearAgentMessageRoundPending
} from './chat/agentMessageClaimGate'

interface AgentMessageClaimPayload {
  claimId: string | null
  conversationId: string
  message: string | null
  messageCount: number
}

export const useBackgroundTaskStore = defineStore('backgroundTasks', () => {
  /**
   * 同步读取会话状态（桥未注册时按空闲/无会话兜底）：
   * 生产环境 chatStore 实例在 App.vue setup 中先于本 store 创建，桥必然已注册；
   * 兜底值仅用于极端时序。watch getter 读 getChatBridge()（内部为 Vue ref）——
   * 即使 watch 创建时桥尚未注册，getter 也已对桥注册本身建立响应式依赖：
   * 桥注册/替换（含 HMR 重建）时会重新求值并顺带追踪底层 chat ref，不会永久失效。
   */
  function chatStateSync(): { isStreaming: boolean; isWaitingForResponse: boolean; currentConversationId: string | null } {
    const bridge = getChatBridge()
    return bridge
      ? bridge.getState()
      : { isStreaming: false, isWaitingForResponse: false, currentConversationId: null }
  }

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

    if (event.taskType === 'agent_message') {
      // 正文留在后端 mailbox；事件只负责唤醒调度。忙时等动作边界/流结束，空闲立即领取。
      if (flushing) {
        flushDroppedEvent = true
      } else {
        void flushReports()
      }
      return
    }

    if (event.type === 'start') {
      if (!isBackgroundStartEvent(event)) return
      // 已存在则忽略：重复 start 事件不能把已 completed/cancelled 的任务复活成 running
      if (tasks.value[event.taskId]) return
      tasks.value = { ...tasks.value, [event.taskId]: taskRecordFromStartEvent(event) }
      return
    }

    if (event.type === 'complete' || event.type === 'cancelled' || event.type === 'error') {
      let record = tasks.value[event.taskId]
      if (!record) {
        // Webview 重载/初始化竞态：start 可能在订阅前丢失，或 complete 在
        // restoreActiveTasks 的 task.getAll 响应返回前抢先到达。旧实现直接丢弃
        // 这条终态；后端此时已注销任务，task.getAll 也无法再恢复，
        // 于是后台 SubAgent 结果永久不回流。终态 taskEvent 现在携带完整
        // SubAgent 元数据，可先合成 start 记录再应用终态。
        const syntheticStart: TaskEventLike = { ...event, type: 'start' }
        if (!isBackgroundStartEvent(syntheticStart)) return
        record = taskRecordFromStartEvent(syntheticStart)
      }
      // 重复/乱序终态不能覆盖已经结算的任务。
      if (record.status !== 'running') return
      tasks.value = { ...tasks.value, [event.taskId]: applyCompletionEvent(record, event) }
      if (flushing) {
        // flush 进行中：本次直接调度会被 flushing 保护丢弃（任务已落表），
        // 标记为“被丢弃的补发事件”，由 flush 结束后的重查补一轮
        flushDroppedEvent = true
        return
      }
      void flushReports()
    }
  }

  // ============ 混合回流 ============

  let flushing = false
  /** 当前持有 flushing 锁的生命周期；Webview 重挂载后允许新生命周期接管，不被旧 await 卡住。 */
  let flushingGeneration: number | undefined
  /** flush 进行中到达的 complete/cancelled/error 事件标记：结束后补一轮 flush（见 handleTaskEvent） */
  let flushDroppedEvent = false
  /**
   * 每次 initialize/cleanup 都推进代次。跨越 await 的旧 flush 只能收尾，
   * 不得在已经卸载或重新挂载后继续发消息、重置新 timer 或复活重试。
   */
  let lifecycleGeneration = 0
  /** 空闲回执发送的有界退避重试；避免一次 IPC/流启动竞态让结果永久挂起。 */
  let reportRetryTimer: ReturnType<typeof setTimeout> | undefined
  let reportRetryAttempt = 0
  const REPORT_RETRY_BASE_DELAY_MS = 500
  const REPORT_RETRY_MAX_DELAY_MS = 30_000

  function resetReportRetry(): void {
    reportRetryAttempt = 0
    if (reportRetryTimer !== undefined) {
      clearTimeout(reportRetryTimer)
      reportRetryTimer = undefined
    }
  }

  function scheduleReportRetry(
    expectedGeneration = lifecycleGeneration,
    resumeAtActionBoundary = false
  ): void {
    if (expectedGeneration !== lifecycleGeneration || reportRetryTimer !== undefined) return
    const delay = Math.min(
      REPORT_RETRY_BASE_DELAY_MS * (2 ** Math.min(reportRetryAttempt, 6)),
      REPORT_RETRY_MAX_DELAY_MS
    )
    reportRetryAttempt += 1
    reportRetryTimer = setTimeout(() => {
      reportRetryTimer = undefined
      if (expectedGeneration !== lifecycleGeneration) return
      if (resumeAtActionBoundary) {
        void flushReportsAfterAction()
      } else {
        void flushReports()
      }
    }, delay)
  }

  /** 领取当前会话的 agent→main 消息；没有消息时返回 null。 */
  async function claimAgentMessages(conversationId: string): Promise<AgentMessageClaimPayload | null> {
    const claim = await sendToExtension<AgentMessageClaimPayload>(MESSAGE_NAMES['chat.claimAgentMessages'], { conversationId })
    return claim?.claimId && claim.message ? claim : null
  }

  /**
   * 尝试把一批 agent→main 消息作为内部回合发送。
   * 返回 true 表示本次确实领取到消息（无论发送是否成功），调用方不再同时投递后台任务报告。
   */
  async function sendClaimedAgentMessages(
    chat: Awaited<ReturnType<typeof resolveChatBridge>>,
    conversationId: string,
    flushGeneration: number
  ): Promise<boolean> {
    let claim: AgentMessageClaimPayload | null
    try {
      claim = await claimAgentMessages(conversationId)
    } catch (error) {
      // 完成事件只会推送一次；领取 IPC 的一次性失败不能让 mailbox 永久挂起。
      console.warn('[backgroundTaskStore] Failed to claim agent messages, will retry:', error)
      scheduleReportRetry(flushGeneration)
      return true
    }
    if (flushGeneration !== lifecycleGeneration) return true
    if (!claim) return false

    // A-COMM 接管窗口：claim 领取后到内部流启动前，用户消息不应走忙时插话投递——
    // 插话会被内部回流流在工具边界 drain 消费，既不落历史又被处理一次（重发后重复处理）。
    // 标记置位后，sendMessageFlow / InputArea 会让窗口内的用户消息走排队（正常回合）。
    markAgentMessageRoundPending(conversationId)
    try {
      // 领取 IPC 期间会话可能切换。不要在这里退回：旧会话的后端请求可能已经通过
      // “准备写入”校验，退回会让同一结果被下一次领取后重复写入。保留领取状态，
      // 切回该会话时会继续使用同一批消息。
      if (chat.getState().currentConversationId !== conversationId) {
        return true
      }

      try {
        const sent = await chat.sendMessage(claim.message!, undefined, {
          source: 'agent_message',
          agentMessageClaimId: claim.claimId!
        })
        if (!sent) {
          // 不主动 release：sendMessage=false 也可能表示“请求已在原会话启动，但前端随后切换会话”。
          // 后端会在消息成功落库后确认 claim；未落库的 claim 会在下次空闲时原样重试。
          console.warn('[backgroundTaskStore] Agent message round did not start; claim remains pending for retry')
          scheduleReportRetry(flushGeneration)
        } else if (flushGeneration === lifecycleGeneration) {
          resetReportRetry()
        }
      } catch (error) {
        // 与上面相同，保留 claim 等下一次 watcher/动作边界重试。
        console.warn('[backgroundTaskStore] Failed to start agent message round; claim remains pending:', error)
        scheduleReportRetry(flushGeneration)
      }
      return true
    } finally {
      clearAgentMessageRoundPending(conversationId)
    }
  }

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
    // 重入防护必须与持锁保持同步（其间不能插入 await）：
    // 桥接解析（resolveChatBridge）是异步的，若先 await 再持锁，并发调用会双双越过守卫
    // 导致重复回执（同一边界只发一条的测试语义依赖守卫-持锁同步）。
    const flushGeneration = lifecycleGeneration
    if (flushing && flushingGeneration === flushGeneration) return
    flushing = true
    flushingGeneration = flushGeneration
    try {
      let chat: Awaited<ReturnType<typeof resolveChatBridge>>
      try {
        chat = await resolveChatBridge()
      } catch (error) {
        console.warn('[backgroundTaskStore] Failed to resolve chat bridge, will retry:', error)
        scheduleReportRetry(flushGeneration)
        return
      }
      if (flushGeneration !== lifecycleGeneration) return
      if (chat.getState().isStreaming || chat.getState().isWaitingForResponse) return

      const currentId = chat.getState().currentConversationId
      if (!currentId) return

      // agent 消息优先：它通常是其他 agent 针对当前工作的即时补充，先于普通后台完成报告。
      if (await sendClaimedAgentMessages(chat, currentId, flushGeneration)) return
      if (flushGeneration !== lifecycleGeneration) return

      const ready = taskList.value.filter(t =>
        !t.reported
        && t.status !== 'running'
        // 子代理内部的后台命令不回流主会话（任务条仍展示，可单独取消）
        && !t.subagentRunId
        && (!t.conversationId || t.conversationId === currentId)
      )
      if (ready.length === 0) return

      // 前端 complete chunk 会先清理 isStreaming，但后端流此时可能还没走到 finally。
      // 必须等待后端运行控制器确认空闲，避免新回执流中止仍在收尾的旧流。
      if (currentId) {
        let idleTimeoutId: ReturnType<typeof setTimeout> | undefined
        try {
          // 等待后端空闲带超时（5s）：后端忙/挂起时不能让回执无限期卡住 flush 流程
          await Promise.race([
            sendToExtension(MESSAGE_NAMES['chat.awaitConversationIdle'], { conversationId: currentId }),
            new Promise<never>((_, reject) => {
              idleTimeoutId = setTimeout(() => reject(new Error('awaitConversationIdle timed out after 5s')), 5000)
            })
          ])
        } catch (error) {
          // idle 探测失败/超时不中断回执流程：sendMessage 失败时会回滚 reported 等待下次补发
          console.warn('[backgroundTaskStore] awaitConversationIdle failed:', error)
        } finally {
          // 竞速提前结算时清理悬空定时器（对已 settled 的 promise reject 是无害 no-op，但避免定时器残留）
          if (idleTimeoutId !== undefined) clearTimeout(idleTimeoutId)
        }
      }

      if (flushGeneration !== lifecycleGeneration) return

      // 等待期间可能切换了会话或启动了新流；重新判定，不能把旧会话报告发进新会话。
      if (chat.getState().currentConversationId !== currentId
        || chat.getState().isStreaming
        || chat.getState().isWaitingForResponse) {
        return
      }

      const report = buildCompletionReport(ready)
      // 先乐观标记，避免 await 期间 watcher 再次触发导致重复回执
      markReported(ready)

      try {
        const sent = await chat.sendMessage(report, undefined, { source: 'background_task' })
        // sendMessage 返回 false 表示发送失败（已在内部 catch 中清理状态）
        // 此时需要回滚乐观标记，等待下次 flush 重试
        if (!sent) {
          console.error('Failed to send background task report, will retry later')
          rollbackReported(ready)
          scheduleReportRetry(flushGeneration)
        } else if (flushGeneration === lifecycleGeneration) {
          resetReportRetry()
        }
      } catch (error) {
        // 修改原因：乐观标记后若发送失败，旧实现会让任务永远停留在 reported=true，后台任务结果被永久丢弃。
        // 修改方式：捕获异常并回滚 reported 标记，等待下一次 flush 时机（流结束/切换会话）重试。
        // 修改目的：回执发送失败是可恢复状态，不应静默吞掉已完成任务的产出。
        console.error('Failed to send background task report, will retry later:', error)
        rollbackReported(ready)
        scheduleReportRetry(flushGeneration)
      }
    } finally {
      // 新生命周期可能已接管 flushing 锁；旧链不得清掉新锁或消费新事件标记。
      if (flushingGeneration === flushGeneration) {
        flushing = false
        flushingGeneration = undefined
        // flush 期间到达的 complete 事件被 flushing 保护丢弃（handleTaskEvent 只落表不调度）：
        // 结束后重查挂起数，非零（且确实有被丢弃事件）则再调度一次 flushReports，避免回执永久滞留。
        // 注意：不能只看 pendingReportCount——发送失败回滚也会使其非零，无条件重调度会形成
        // 发送失败→回滚→重试 的热循环；因此必须叠加 flushDroppedEvent 标记（真实新完成事件）。
        if (flushDroppedEvent) {
          flushDroppedEvent = false
          void flushReports()
        }
      }
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
    // 重入防护与持锁保持同步（不插入 await），理由同 flushReports：
    // 桥接解析异步化后若先 await 再持锁，同一边界的并发调度会双双越过守卫导致重复回执。
    const flushGeneration = lifecycleGeneration
    if (flushing && flushingGeneration === flushGeneration) return
    flushing = true
    flushingGeneration = flushGeneration
    try {
      let chat: Awaited<ReturnType<typeof resolveChatBridge>>
      try {
        chat = await resolveChatBridge()
      } catch (error) {
        console.warn('[backgroundTaskStore] Failed to resolve chat bridge after action, will retry:', error)
        scheduleReportRetry(flushGeneration, true)
        return
      }
      if (flushGeneration !== lifecycleGeneration) return

      const currentId = chat.getState().currentConversationId
      if (!currentId) return

      // 先领取 agent 消息。若当前工具结果已通过 ToolExecutionService 消费了它，领取为空，
      // 再继续处理普通后台任务报告。
      let agentClaim: AgentMessageClaimPayload | null
      try {
        agentClaim = await claimAgentMessages(currentId)
      } catch (error) {
        console.warn('[backgroundTaskStore] Failed to claim agent messages after action, will retry:', error)
        scheduleReportRetry(flushGeneration, true)
        return
      }
      if (flushGeneration !== lifecycleGeneration) return
      if (agentClaim) {
        // 领取请求返回前用户可能已经切到另一会话；此时不能取消新会话正在运行的流。
        // 领取状态保留在原会话，切回后再继续处理。
        if (chat.getState().currentConversationId !== currentId) {
          return
        }
        // A-COMM 接管窗口：claim 领取后到内部流启动前（含 cancelStream 往返），用户消息
        // 不应走忙时插话投递——插话会被内部回流流误消费且不落历史。标记置位后
        // sendMessageFlow / InputArea 让窗口内的用户消息走排队（正常回合）。
        markAgentMessageRoundPending(currentId)
        try {
          if (chat.getState().isWaitingForResponse || chat.getState().isStreaming) {
            await chat.cancelStream({ preserveSubAgents: true })
          }

          if (flushGeneration !== lifecycleGeneration) return

          if (chat.getState().currentConversationId !== currentId) {
            // 与空闲发送路径一致：会话切换不主动退回，避免和已经进入后端写入阶段的
            // 请求竞争，导致同一完成结果被领取两次。
            return
          }
          if (chat.getState().isStreaming || chat.getState().isWaitingForResponse) {
            // 其他发送者抢先启动新流；claim 保留，等该流的动作边界/结束后继续。
            return
          }

          try {
            const sent = await chat.sendMessage(agentClaim.message!, undefined, {
              source: 'agent_message',
              agentMessageClaimId: agentClaim.claimId!
            })
            if (!sent) {
              console.warn('[backgroundTaskStore] Agent message action-boundary round did not start; claim remains pending')
              scheduleReportRetry(flushGeneration, true)
            } else if (flushGeneration === lifecycleGeneration) {
              resetReportRetry()
            }
          } catch (error) {
            console.warn('[backgroundTaskStore] Failed to send agent message after action; claim remains pending:', error)
            scheduleReportRetry(flushGeneration, true)
          }
          return
        } finally {
          clearAgentMessageRoundPending(currentId)
        }
      }

      const ready = taskList.value.filter(t =>
        !t.reported
        && t.status !== 'running'
        // 子代理内部的后台命令不回流主会话（任务条仍展示，可单独取消）
        && !t.subagentRunId
        && (!t.conversationId || t.conversationId === currentId)
      )
      if (ready.length === 0) return

      // 动作边界必然仍在响应中（流继续）；防御性判断以兼容迟到的调度
      // 与重检条件对称（isStreaming/isWaitingForResponse 任一活跃即需替换回合）
      if (chat.getState().isWaitingForResponse || chat.getState().isStreaming) {
        await chat.cancelStream({ preserveSubAgents: true })
      }

      if (flushGeneration !== lifecycleGeneration) return

      // 投递窗口内会话已切换：放弃本次，任务保持未回流，等待切回原会话后补发
      if (chat.getState().currentConversationId !== currentId) {
        return
      }

      // 投递窗口内已有其他发送者抢先开启新流：放弃本次，等待下一动作边界/回合结束
      if (chat.getState().isStreaming || chat.getState().isWaitingForResponse) {
        return
      }

      const report = buildCompletionReport(ready)
      markReported(ready)

      try {
        const sent = await chat.sendMessage(report, undefined, { source: 'background_task' })
        if (!sent) {
          console.error('Failed to send background task report after action, will retry later')
          rollbackReported(ready)
          scheduleReportRetry(flushGeneration, true)
        } else if (flushGeneration === lifecycleGeneration) {
          resetReportRetry()
        }
      } catch (error) {
        console.error('Failed to send background task report after action, will retry later:', error)
        rollbackReported(ready)
        scheduleReportRetry(flushGeneration, true)
      }
    } finally {
      if (flushingGeneration === flushGeneration) {
        flushing = false
        flushingGeneration = undefined
        if (flushDroppedEvent) {
          flushDroppedEvent = false
          void flushReports()
        }
      }
    }
  }

  // ============ 操作 ============

  /** 取消运行中的后台任务 */
  async function cancelTask(taskId: string): Promise<void> {
    try {
      await sendToExtension(MESSAGE_NAMES['task.cancel'], { taskId })
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
      }>(MESSAGE_NAMES['task.getAll'], {})

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

  let cleanup: (() => void) | undefined

  function initialize(): () => void {
    if (cleanup) return cleanup
    lifecycleGeneration += 1
    const initializedGeneration = lifecycleGeneration
    resetReportRetry()
    flushDroppedEvent = false
    initialized.value = true

    const unsubscribeMessages = onExtensionCommand<TaskEventLike>('taskEvent', event => {
      handleTaskEvent(event)
    })

    // 流结束 → 补发挂起回执（混合语义的"忙时暂存，闲时补发"）
    // 修改原因：flushReports 的忙闲判断同时看 isStreaming 和 isWaitingForResponse，但过去只监听前者；
    //          请求在进入流式前就失败时（isWaitingForResponse true→false 而 isStreaming 始终为 false），
    //          挂起的回执不会被补发，要一直等到下一次流结束或切换会话。
    // 修改方式：两个忙闲信号都监听，任一转为空闲即尝试补发（flushReports 自身幂等且有 flushing 保护）。
    // 修改目的：忙闲判断条件与补发触发条件保持一致。
    // 会话状态经单向桥接读取（chatStateSync 每次求值实时读取 chatStore 底层 ref，
    // 与旧实现 watch(() => chatStore.isStreaming) 的响应式语义一致）。
    // watch 句柄保存并在组件卸载时销毁，避免 HMR/重挂载后重复监听（重复触发 flushReports 是幂等的，
    // 但重复 watch 是资源泄漏）。
    const stopWatchStreaming = watch(() => chatStateSync().isStreaming, streaming => {
      if (!streaming) void flushReports()
    })
    const stopWatchWaiting = watch(() => chatStateSync().isWaitingForResponse, waiting => {
      if (!waiting) void flushReports()
    })

    // 切换会话 → 补发属于新会话的挂起回执
    const stopWatchConversation = watch(() => chatStateSync().currentConversationId, () => {
      void flushReports()
    })

    void restoreActiveTasks()
    // Webview 重载期间到达的 agent 消息没有对应前端事件；初始化时主动领取一次。
    void flushReports()

    let cleanedUp = false
    const cleanupCurrent = () => {
      if (cleanedUp) return
      cleanedUp = true
      if (lifecycleGeneration === initializedGeneration) {
        // 先失效旧代次，再清 timer；已在 await 中的 flush 之后无法重新挂 timer/发消息。
        lifecycleGeneration += 1
        initialized.value = false
      }
      resetReportRetry()
      flushDroppedEvent = false
      unsubscribeMessages()
      stopWatchStreaming()
      stopWatchWaiting()
      stopWatchConversation()
      if (cleanup === cleanupCurrent) cleanup = undefined
    }
    cleanup = cleanupCurrent
    return cleanupCurrent
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
