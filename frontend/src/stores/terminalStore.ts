/**
 * Terminal Store - 终端状态管理
 * 
 * 管理活动终端的实时输出：
 * - 存储每个终端的输出缓冲区
 * - 处理终端输出事件
 * - 支持杀死终端
 */

import { MESSAGE_NAMES } from '@shared/protocol'
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { sendToExtension, onExtensionCommand } from '../utils/vscode'
import { useI18n } from '../composables/useI18n'

/**
 * 终端输出缓冲上限（字符数）。
 * 长驻终端的累积输出可能达到数 MB：无上限时每次追加都是 O(n²) 字符串拼接，
 * 且整段输出作为响应式状态会触发整段重渲染。超过上限后截断，仅保留最近部分。
 */
const MAX_TERMINAL_OUTPUT = 200 * 1024

/**
 * 终端输出事件类型（与后端对应）
 */
export interface TerminalOutputEvent {
  terminalId: string
  toolId?: string
  conversationId?: string
  type: 'start' | 'output' | 'error' | 'exit'
  data?: string
  command?: string  // start 事件时包含命令
  cwd?: string      // start 事件时包含工作目录
  shell?: string    // start 事件时包含 shell 类型
  exitCode?: number
  killed?: boolean
  duration?: number
}

/**
 * 终端状态
 */
export interface TerminalState {
  id: string
  toolId?: string
  conversationId?: string
  error?: string
  truncated?: boolean
  /** 累积的输出内容 */
  output: string
  /** 是否正在运行 */
  running: boolean
  /** 退出码（运行结束后设置） */
  exitCode?: number
  /** 是否被杀死 */
  killed?: boolean
  /** 执行时长（毫秒） */
  duration?: number
  /** 开始时间 */
  startTime: number
  /** 最后更新时间 */
  lastUpdate: number
  /** 执行命令 */
  command?: string
  /** 工作目录 */
  cwd?: string
  /** Shell 类型 */
  shell?: string
}

export const useTerminalStore = defineStore('terminal', () => {
  // ============ 状态 ============
  
  /** 活动终端状态（按终端ID索引） */
  const terminals = ref<Map<string, TerminalState>>(new Map())
  
  /** 是否已初始化监听 */
  const initialized = ref(false)
  const consumers = new Map<string, number>()
  
  // ============ 计算属性 ============
  
  /** 运行中的终端数量 */
  const runningCount = computed(() => {
    let count = 0
    terminals.value.forEach(t => {
      if (t.running) count++
    })
    return count
  })
  
  /** 是否有运行中的终端 */
  const hasRunning = computed(() => runningCount.value > 0)
  
  // ============ 方法 ============
  
  /**
   * 获取终端状态
   */
  function getTerminal(terminalId: string): TerminalState | undefined {
    return terminals.value.get(terminalId)
  }

  /** 正在展示的卡片保留状态；折叠或卸载后允许过期输出释放。 */
  function retainTerminal(terminalId: string): () => void {
    consumers.set(terminalId, (consumers.get(terminalId) ?? 0) + 1)
    return () => {
      const count = consumers.get(terminalId) ?? 0
      if (count > 1) consumers.set(terminalId, count - 1)
      else consumers.delete(terminalId)
    }
  }
  
  /** 独立宿主提供调用归属；旧扩展宿主直接使用调用 ID 作为终端 ID。 */
  function findTerminalByTool(toolId: string, conversationId?: string | null): TerminalState | undefined {
    const direct = terminals.value.get(toolId)
    if (direct && (!conversationId || !direct.conversationId || direct.conversationId === conversationId)) return direct
    for (const terminal of terminals.value.values()) {
      if (terminal.toolId === toolId && (!conversationId || terminal.conversationId === conversationId)) return terminal
    }
  }

  /**
   * 处理终端输出事件
   */
  function handleTerminalOutput(event: TerminalOutputEvent): void {
    const { terminalId, type, data, command, cwd, shell, exitCode, killed, duration } = event
    
    let terminal = terminals.value.get(terminalId)
    
    const now = Date.now()
    
    switch (type) {
      case 'start':
        // 重复启动事件只补齐元数据，保留已收到的输出和终态。
        if (terminal) {
          if (command !== undefined) terminal.command = command
          if (cwd !== undefined) terminal.cwd = cwd
          if (shell !== undefined) terminal.shell = shell
          terminal.lastUpdate = now
        } else {
          terminal = {
            id: terminalId,
            output: '',
            running: true,
            startTime: now,
            lastUpdate: now,
            command,
            cwd,
            shell
          }
          terminals.value.set(terminalId, terminal)
        }
        
        break
        
      case 'output':
      case 'error':
        // 如果终端不存在，创建它
        if (!terminal) {
          terminal = {
            id: terminalId,
            output: '',
            running: true,
            startTime: now,
            lastUpdate: now
          }
          terminals.value.set(terminalId, terminal)
        }
        
        terminal.lastUpdate = now
        // 追加输出（有界：超过 MAX_TERMINAL_OUTPUT 后截断仅保留尾部，避免 O(n²) 拼接与整段重渲染）
        if (data) {
          const nextOutput = terminal.output + data
          terminal.truncated ||= nextOutput.length > MAX_TERMINAL_OUTPUT
          terminal.output = nextOutput.slice(-MAX_TERMINAL_OUTPUT)
        }
        break
        
      case 'exit':
        // 如果终端不存在，创建它
        if (!terminal) {
          terminal = {
            id: terminalId,
            output: '',
            running: false,
            startTime: now,
            lastUpdate: now
          }
          terminals.value.set(terminalId, terminal)
        }
        
        terminal.lastUpdate = now
        // 终端结束
        terminal.running = false
        terminal.exitCode = exitCode
        terminal.killed = killed
        terminal.duration = duration
        
        break
    }
    if (terminal) {
      if (event.toolId !== undefined) terminal.toolId = event.toolId
      if (event.conversationId !== undefined) terminal.conversationId = event.conversationId
    }
  }
  
  /**
   * 杀死终端
   */
  async function killTerminal(terminalId: string): Promise<{ success: boolean; output?: string; error?: string }> {
    const { t } = useI18n()
    try {
      const result = await sendToExtension<{ success: boolean; output?: string; error?: string }>(MESSAGE_NAMES['terminal.kill'], {
        terminalId
      })
      
      // 更新本地状态
      const terminal = terminals.value.get(terminalId)
      if (terminal && result.success) {
        terminal.running = false
        terminal.killed = true
        if (typeof result.output === 'string') {
          terminal.output = result.output.slice(-MAX_TERMINAL_OUTPUT)
        }
      }
      
      return result
    } catch (error: any) {
      return {
        success: false,
        error: error.message || t('stores.terminalStore.errors.killTerminalFailed')
      }
    }
  }
  
  /** 历史后台任务按需恢复一次，等待期间收到的实时事件优先。 */
  async function restoreTerminal(terminalId: string): Promise<void> {
    if (terminals.value.has(terminalId)) return
    const result = await sendToExtension<{ success: boolean; output?: string; running?: boolean; exitCode?: number; killed?: boolean; duration?: number; error?: string }>(
      MESSAGE_NAMES['terminal.getOutput'], { terminalId })
    if (!result.success) throw new Error(result.error || useI18n().t('stores.terminalStore.errors.refreshOutputFailed'))
    if (terminals.value.has(terminalId)) return
    const output = result.output ?? '', now = Date.now()
    terminals.value.set(terminalId, { id: terminalId, output: output.slice(-MAX_TERMINAL_OUTPUT), running: result.running === true,
      exitCode: result.exitCode, killed: result.killed, duration: result.duration, error: result.error,
      truncated: output.length > MAX_TERMINAL_OUTPUT, startTime: now, lastUpdate: now })
  }
  
  /**
   * 清理已完成的终端（超过指定时间）
   */
  function cleanup(maxAge: number = 5 * 60 * 1000): void {
    const now = Date.now()
    const toDelete: string[] = []
    
    terminals.value.forEach((terminal, id) => {
      if (!terminal.running && !consumers.has(id) && (now - terminal.lastUpdate) > maxAge) {
        toDelete.push(id)
      }
    })
    
    toDelete.forEach(id => terminals.value.delete(id))
  }
  
  /**
   * 清除指定终端
   */
  function removeTerminal(terminalId: string): void {
    terminals.value.delete(terminalId)
  }
  
  /**
   * 清除所有终端
   */
  function clearAll(): void {
    terminals.value.clear()
  }
  
  // ============ 初始化 ============
  
  let terminalCleanup: (() => void) | undefined

  /**
   * 初始化 store，监听终端输出事件
   *
   * @returns 取消订阅的 cleanup 函数（重复调用返回当前 cleanup，不重复注册监听）
   */
  function initialize(): () => void {
    if (terminalCleanup) return terminalCleanup
    
    const unsubscribe = onExtensionCommand<TerminalOutputEvent | TerminalOutputEvent[]>('terminalOutput', (event) => {
      // 入口校验：缺失 terminalId/type 的事件会污染 terminals Map（Map 以 terminalId 为键）。
      // 扩展端 50ms 节流批处理会把短窗口内多条事件合并为数组消息：逐条按原语义处理
      // （数组内顺序即产生顺序，start/output/error/exit 的相对次序保持不变）。
      if (Array.isArray(event)) {
        for (const item of event) {
          if (!item || typeof item.terminalId !== 'string' || typeof item.type !== 'string') continue
          handleTerminalOutput(item)
        }
        return
      }
      if (!event || typeof event.terminalId !== 'string' || typeof event.type !== 'string') return
      handleTerminalOutput(event)
    })
    
    const cleanupTimer = setInterval(() => cleanup(), 60_000)
    initialized.value = true
    terminalCleanup = () => {
      clearInterval(cleanupTimer)
      unsubscribe()
      initialized.value = false
      terminalCleanup = undefined
    }
    return terminalCleanup
  }
  
  return {
    // 状态
    terminals,
    
    // 计算属性
    runningCount,
    hasRunning,
    
    // 方法
    getTerminal,
    retainTerminal,
    findTerminalByTool,
    handleTerminalOutput,
    killTerminal,
    restoreTerminal,
    cleanup,
    removeTerminal,
    clearAll,
    initialize
  }
})
