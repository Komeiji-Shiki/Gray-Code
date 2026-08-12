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
 * 终端输出监听的取消函数（模块级单例，与 chatStore 的 disposeChatStreamListener 同模式）。
 * HMR / App.vue 重挂载会重复 initialize()，保存句柄后重复调用时先注销旧监听再注册，
 * 保证任意时刻只有一份活跃订阅；dispose() 由 App.vue onBeforeUnmount 调用。
 */
let disposeTerminalOutputListener: (() => void) | null = null

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
  /** 命令（用于匹配） */
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
  // ============ 方法 ============
  
  /**
   * 注册终端（在工具调用开始时）
   * 不覆盖已有的终端状态
   */
  function registerTerminal(terminalId: string): void {
    // 如果终端已存在，不覆盖
    if (terminals.value.has(terminalId)) {
      return
    }
    
    const now = Date.now()
    terminals.value.set(terminalId, {
      id: terminalId,
      output: '',
      running: true,
      startTime: now,
      lastUpdate: now
    })
  }
  
  /**
   * 获取终端状态
   */
  function getTerminal(terminalId: string): TerminalState | undefined {
    return terminals.value.get(terminalId)
  }
  
  /**
   * 通过命令查找终端ID
   * 用于在 result 还没有返回时，通过命令参数匹配终端
   */
  function findTerminalByCommand(command: string, cwd?: string): string | undefined {
    // 精确匹配命令和工作目录
    for (const [terminalId, terminal] of terminals.value) {
      if (terminal.command === command && terminal.running) {
        if (cwd === undefined || terminal.cwd === cwd) {
          return terminalId
        }
      }
    }
    // 只匹配命令
    for (const [terminalId, terminal] of terminals.value) {
      if (terminal.command === command && terminal.running) {
        return terminalId
      }
    }
    return undefined
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
        // 终端启动事件：已存在（registerTerminal 已登记 / 重复 start 事件）时不整体覆盖，
        // 只补齐命令 / 工作目录 / shell 元数据，保留已累积的输出与运行状态
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
          terminal.output = (terminal.output + data).slice(-MAX_TERMINAL_OUTPUT)
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
        if (result.output) {
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
  
  /**
   * 获取终端输出（用于手动刷新）
   */
  async function refreshOutput(terminalId: string): Promise<void> {
    const { t } = useI18n()
    try {
      const result = await sendToExtension<{ success: boolean; output?: string; running?: boolean; error?: string }>(MESSAGE_NAMES['terminal.getOutput'], {
        terminalId
      })
      
      if (result.success) {
        const terminal = terminals.value.get(terminalId)
        if (terminal && result.output) {
          terminal.output = result.output.slice(-MAX_TERMINAL_OUTPUT)
          terminal.running = result.running ?? terminal.running
        }
      }
    } catch (error) {
      console.error(t('stores.terminalStore.errors.refreshOutputFailed'), error)
    }
  }
  
  /**
   * 清理已完成的终端（超过指定时间）
   */
  function cleanup(maxAge: number = 5 * 60 * 1000): void {
    const now = Date.now()
    const toDelete: string[] = []
    
    terminals.value.forEach((terminal, id) => {
      if (!terminal.running && (now - terminal.lastUpdate) > maxAge) {
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
    
    // M-7：保存 onExtensionCommand 返回的取消函数，dispose() 时注销，
    // 避免 HMR/重复初始化产生多份活跃订阅。
    // 订阅走统一 sendCommand 信封（{ type: 'command', command: 'terminalOutput', data }），
    // 与 shared/protocol.ts 及 backgroundTaskStore 的推送口径一致。
    disposeTerminalOutputListener = onExtensionCommand<TerminalOutputEvent | TerminalOutputEvent[]>('terminalOutput', (event) => {
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
    
    initialized.value = true
    terminalCleanup = () => {
      disposeTerminalOutputListener?.()
      disposeTerminalOutputListener = null
      initialized.value = false
      terminalCleanup = undefined
    }
    return terminalCleanup
  }
  
  /**
   * 释放资源：注销扩展消息监听并复位初始化状态（App.vue onBeforeUnmount 调用）
   */
  function dispose(): void {
    disposeTerminalOutputListener?.()
    disposeTerminalOutputListener = null
    initialized.value = false
  }
  
  return {
    // 状态
    terminals,
    
    // 计算属性
    runningCount,
    hasRunning,
    
    // 方法
    registerTerminal,
    getTerminal,
    findTerminalByCommand,
    handleTerminalOutput,
    killTerminal,
    refreshOutput,
    cleanup,
    removeTerminal,
    clearAll,
    initialize,
    dispose
  }
})