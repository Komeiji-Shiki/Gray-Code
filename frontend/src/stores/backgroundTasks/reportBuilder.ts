/**
 * 后台任务记录与回执构建（纯函数模块）
 *
 * 修改原因：混合回流逻辑（任务事件归约、回执文本构建）需要独立于 store 的可测试实现。
 * 修改方式：所有状态转换使用不可变纯函数，store 只负责持有状态与触发时机。
 * 修改目的：回流合并与竞态逻辑可以直接单元测试，不依赖 Pinia 与消息通道。
 */

export type BackgroundTaskKind = 'subagent' | 'terminal'
export type BackgroundTaskStatus = 'running' | 'completed' | 'error' | 'cancelled'

/**
 * 前端持有的后台任务记录
 */
export interface BackgroundTaskRecord {
  taskId: string
  kind: BackgroundTaskKind
  conversationId?: string
  /** 展示标签：agent 名称或命令摘要 */
  label: string
  status: BackgroundTaskStatus
  startedAt: number
  finishedAt?: number
  /** SubAgent 运行 ID（打开 Monitor 用） */
  runId?: string
  /** 终端 ID（查看输出用） */
  terminalId?: string
  /** SubAgent 最终报告全文 */
  response?: string
  steps?: number
  /** 命令输出尾部 */
  output?: string
  exitCode?: number | null
  error?: string
  /** 回执是否已发送给主模型 */
  reported: boolean
}

/**
 * 与后端 TaskEvent 同构的事件形状
 */
export interface TaskEventLike {
  taskId: string
  taskType: string
  type: 'start' | 'progress' | 'complete' | 'cancelled' | 'error'
  data?: Record<string, unknown>
  error?: string
  createdAt?: number
}

const COMMAND_LABEL_MAX_LENGTH = 60

/**
 * 回执中允许携带的 SubAgent 结果正文上限。
 *
 * 修改原因：后台 SubAgent 的工具调用立即返回 taskId stub，主模型不会通过 functionResponse 拿到任何结果，
 *          回执是结果回到主模型的唯一通道；但完整报告可能长达数万字符，直接内联会刷屏。
 * 修改方式：内联正文并按上限截断，截断时显式提示可去 Monitor 查看完整 transcript。
 * 修改目的：主模型能真正拿到后台任务产出，同时最坏情况下的消息体积可控。
 */
const SUBAGENT_RESPONSE_MAX_LENGTH = 4000

/**
 * 是否是后台任务的 start 事件。
 *
 * background_subagent 全部是后台；terminal 仅当 metadata.background === true。
 */
export function isBackgroundStartEvent(event: TaskEventLike): boolean {
  if (event.type !== 'start') return false
  if (event.taskType === 'background_subagent') return true
  return event.taskType === 'terminal' && event.data?.background === true
}

/**
 * 从 start 事件（或 task.getAll 恢复数据）构建任务记录
 */
export function taskRecordFromStartEvent(event: TaskEventLike): BackgroundTaskRecord {
  const data = event.data || {}
  const conversationId = typeof data.conversationId === 'string' ? data.conversationId : undefined
  const startedAt = typeof event.createdAt === 'number' ? event.createdAt : Date.now()

  if (event.taskType === 'background_subagent') {
    return {
      taskId: event.taskId,
      kind: 'subagent',
      conversationId,
      label: typeof data.agentName === 'string' && data.agentName ? data.agentName : 'Sub-agent',
      status: 'running',
      startedAt,
      runId: typeof data.runId === 'string' ? data.runId : undefined,
      reported: false
    }
  }

  const command = typeof data.command === 'string' ? data.command : ''
  return {
    taskId: event.taskId,
    kind: 'terminal',
    conversationId,
    label: command.length > COMMAND_LABEL_MAX_LENGTH
      ? `${command.slice(0, COMMAND_LABEL_MAX_LENGTH)}…`
      : (command || 'command'),
    status: 'running',
    startedAt,
    terminalId: event.taskId,
    reported: false
  }
}

/**
 * 应用完成事件（complete/cancelled/error），返回新记录（不可变）
 */
export function applyCompletionEvent(record: BackgroundTaskRecord, event: TaskEventLike): BackgroundTaskRecord {
  const data = event.data || {}
  const status: BackgroundTaskStatus = event.type === 'complete'
    ? 'completed'
    : event.type === 'cancelled' ? 'cancelled' : 'error'

  return {
    ...record,
    status,
    finishedAt: typeof event.createdAt === 'number' ? event.createdAt : Date.now(),
    response: typeof data.response === 'string' ? data.response : record.response,
    steps: typeof data.steps === 'number' ? data.steps : record.steps,
    output: typeof data.output === 'string' ? data.output : record.output,
    exitCode: typeof data.exitCode === 'number' || data.exitCode === null
      ? data.exitCode as number | null
      : record.exitCode,
    runId: typeof data.runId === 'string' ? data.runId : record.runId,
    error: typeof data.error === 'string' && data.error
      ? data.error
      : (event.error || record.error)
  }
}

function formatDurationSeconds(record: BackgroundTaskRecord): string {
  if (!record.finishedAt) return ''
  const seconds = Math.max(0, Math.round((record.finishedAt - record.startedAt) / 1000))
  return `${seconds}s`
}

function buildSubAgentSection(task: BackgroundTaskRecord): string {
  const lines: string[] = []
  lines.push(`Task: sub-agent "${task.label}"${task.runId ? ` (runId: ${task.runId})` : ''}`)

  const statusText = task.status === 'completed'
    ? 'success'
    : task.status === 'cancelled' ? 'cancelled by user' : 'failed'
  const meta: string[] = []
  if (typeof task.steps === 'number') meta.push(`${task.steps} steps`)
  const duration = formatDurationSeconds(task)
  if (duration) meta.push(duration)
  lines.push(`Status: ${statusText}${meta.length > 0 ? ` (${meta.join(', ')})` : ''}`)

  if (task.error) lines.push(`Error: ${task.error}`)

  // 修改原因：后台 SubAgent 的 functionResponse 只含 taskId，主模型无法从别处得到结果；旧实现省略正文导致后台任务产出被静默丢弃。
  // 修改方式：内联结果正文并按 SUBAGENT_RESPONSE_MAX_LENGTH 截断，截断时提示去 Monitor 查看完整 transcript。
  // 修改目的：后台派发的工作真正回到主模型手里，同时回执体积仍然有界。
  const response = task.response?.trim()
  if (response) {
    lines.push('Result:')
    if (response.length > SUBAGENT_RESPONSE_MAX_LENGTH) {
      lines.push(`${response.slice(0, SUBAGENT_RESPONSE_MAX_LENGTH)}…`)
      lines.push(`[Truncated ${response.length - SUBAGENT_RESPONSE_MAX_LENGTH} more characters. Open Monitor to view the full transcript.]`)
    } else {
      lines.push(response)
    }
  } else {
    lines.push('Open Monitor to view full transcript.')
  }
  return lines.join('\n')
}

function buildTerminalSection(task: BackgroundTaskRecord): string {
  const lines: string[] = []
  lines.push(`Task: command \`${task.label}\``)

  const duration = formatDurationSeconds(task)
  if (task.status === 'cancelled') {
    lines.push(`Status: cancelled by user${duration ? ` (${duration})` : ''}`)
  } else {
    const exitText = task.exitCode === null || task.exitCode === undefined ? 'unknown' : String(task.exitCode)
    lines.push(`Status: exit code ${exitText}${duration ? ` (${duration})` : ''}`)
  }

  if (task.error) lines.push(`Error: ${task.error}`)
  if (task.output) {
    lines.push('Output:')
    lines.push(task.output)
  }
  return lines.join('\n')
}

/**
 * 构建回执消息（英文，面向模型）。多个已完成任务合并为一条。
 */
export function buildCompletionReport(tasks: BackgroundTaskRecord[]): string {
  const sections = tasks.map(task =>
    task.kind === 'subagent' ? buildSubAgentSection(task) : buildTerminalSection(task)
  )
  return `[Background task completed]\n\n${sections.join('\n\n---\n\n')}`
}
