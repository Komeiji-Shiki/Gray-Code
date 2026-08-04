/**
 * VSCode API 通信工具
 */

import type { VSCodeMessage, VSCodeRequest } from '../types'
import { handleSoundEvent } from '../services/soundEventController'
import { routeExtensionMessage, type PendingRequestHandler } from './extensionMessageRouting'

// 获取 VSCode API
declare function acquireVsCodeApi(): any

let vscodeApi: any = null

export function getVSCodeAPI() {
  if (!vscodeApi) {
    vscodeApi = acquireVsCodeApi()
  }
  return vscodeApi
}

// 消息请求ID生成器
let requestIdCounter = 0
export function generateRequestId(): string {
  return `req_${Date.now()}_${++requestIdCounter}`
}

/**
 * 不设通用超时的请求类型。
 *
 * - 流式对话：响应要等整轮工具循环跑完才回，时长由模型和工具决定
 * - 依赖安装 / 存储迁移：本身就是分钟级的长任务
 * - checkpoint.restore / deleteBatch / previewRestore：大工作区恢复/批量删除/预览可能超过 180s，
 *   超时会让前端误判失败而后端在互斥锁内继续执行，导致重复恢复/删除（checkpoint-frontend-review M-1）
 * - deleteMessage：删除会话消息可能在后端互斥锁内等待其他回合收尾而超过 180s；
 *   超时误判删除失败会触发前端重载/中止重试路径，而删除实际已生效，造成窗口与历史错位（FIX-C-2）
 */
const UNBOUNDED_REQUEST_TYPES = new Set([
  'chatStream',
  'retryStream',
  'editAndRetryStream',
  'chat.rerollStream',
  'chat.editBranchStream',
  'toolConfirmation',
  'cancelStream',
  'deleteMessage',
  'dependencies.install',
  'dependencies.uninstall',
  'storagePath.migrate',
  'storagePath.selectFolder',
  'checkpoint.restore',
  'checkpoint.deleteBatch',
  'checkpoint.previewRestore'
])

/**
 * 其余请求的兜底超时。
 *
 * 「后端渠道配置已有超时」这个理由只覆盖 LLM 请求：任何因为处理器异常、面板销毁等原因
 * 不回复的普通消息，都会让 messageHandlers 永久留一条、调用方永久 pending——用户看到的是
 * 一个再也不会停下来的加载态。这里给一个足够宽松的上界，超过就报错而不是静默挂着。
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 180_000

/**
 * Vue 响应式对象内部标记键（与 Vue 3 的 toRaw 实现一致）。
 * Vue 的 reactive/readonly 代理在读取该键时返回原始目标对象，普通对象返回 undefined。
 */
const VUE_RAW_KEY = '__v_raw'

/**
 * 判断对象是否为 Vue 响应式 Proxy（reactive / readonly / ref 解包后的响应式对象）。
 * 读取 __v_raw 触发 Vue 代理的 get trap 并返回原始目标；普通对象读取为 undefined。
 * 读取抛错时保守视为 Proxy（走 JSON 往返，保证不破坏原有解包行为）。
 */
function isVueReactiveProxy(value: any): boolean {
  try {
    const raw = value[VUE_RAW_KEY]
    return raw !== undefined && raw !== value
  } catch {
    return true
  }
}

/**
 * 判断 payload 是否必须 JSON 往返解包：
 * - 树中存在 Vue 响应式 Proxy → 是（structured clone 无法序列化 Proxy，会抛 DataCloneError）
 * - 存在循环引用 → 是（JSON.stringify 会抛错 → 保持原有 reject 行为）
 * - 存在非普通对象（Date/Map/Set/RegExp/函数等）→ 是（保持原有 JSON 化语义）
 * - 纯 JSON 结构（对象/数组/字符串/数字/布尔/null，含 base64 大字符串）→ 否，直接透传
 *
 * 遍历为引用级检查，不复制字符串，开销远小于 JSON.stringify；visited 防止循环引用死循环。
 */
function requiresJsonRoundTrip(value: any, visited: Set<object> = new Set()): boolean {
  if (value === null || typeof value !== 'object') return false
  if (visited.has(value)) return true
  visited.add(value)

  if (isVueReactiveProxy(value)) return true

  const proto = Object.getPrototypeOf(value)
  if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) return true

  if (Array.isArray(value)) {
    for (const item of value) {
      if (requiresJsonRoundTrip(item, visited)) return true
    }
    return false
  }

  for (const key of Object.keys(value)) {
    if (requiresJsonRoundTrip(value[key], visited)) return true
  }
  return false
}

// 发送消息到插件
export function sendToExtension<T = any>(type: string, data: any, options?: { timeoutMs?: number }): Promise<T> {
  return new Promise((resolve, reject) => {
    const requestId = generateRequestId()
    const vscode = getVSCodeAPI()

    const timeoutMs = options?.timeoutMs
      ?? (UNBOUNDED_REQUEST_TYPES.has(type) ? 0 : DEFAULT_REQUEST_TIMEOUT_MS)
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined
    if (timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        messageHandlers.delete(requestId)
        reject(new Error(`Request "${type}" timed out after ${timeoutMs}ms`))
      }, timeoutMs)
    }
    const clearTimeoutTimer = () => {
      if (timeoutTimer !== undefined) {
        clearTimeout(timeoutTimer)
        timeoutTimer = undefined
      }
    }

    // 注册响应处理器
    messageHandlers.set(requestId, {
      resolve: (data: T) => {
        clearTimeoutTimer()
        resolve(data)
      },
      reject: (error: Error) => {
        clearTimeoutTimer()
        reject(error)
      }
    })

    // 发送消息
    try {
      // 修改原因：Vue ref 响应式对象是 Proxy，vscode.postMessage 的 structured clone
      //          无法序列化 Proxy，会抛 DataCloneError。调用方传进来的 data 可能含有来自
      //          ref 的深层嵌套 Proxy（如预设模板的 tools.whitelist 数组）。
      // 修改方式：仅当 payload 树中检测到 Proxy 时才 JSON 往返解包；纯 JSON payload
      //          （如带 base64 附件的大对象）直接透传，避免每次复制数 MB 字符串。
      //          透传若因漏检的非 Vue Proxy 抛 DataCloneError，回退 JSON 解包重试一次。
      // 修改目的：调用方无需感知 Vue 响应式细节，全局消除 "could not be cloned"，
      //          同时消除大 payload 的双份 JSON 序列化开销。
      let safeData = data
      if (requiresJsonRoundTrip(data)) {
        safeData = JSON.parse(JSON.stringify(data))
      }
      try {
        vscode.postMessage({
          type,
          requestId,
          data: safeData
        } as VSCodeRequest)
      } catch (postErr: any) {
        // 已 JSON 化仍失败（如 payload 超限）→ 直接抛出，由外层统一处理
        if (safeData !== data) throw postErr
        // 透传失败（漏检的非 Vue Proxy 等）→ 回退 JSON 解包重试一次
        safeData = JSON.parse(JSON.stringify(data))
        vscode.postMessage({
          type,
          requestId,
          data: safeData
        } as VSCodeRequest)
      }
    } catch (err: any) {
      // 例如：payload 过大导致 structured clone / postMessage 失败
      clearTimeoutTimer()
      messageHandlers.delete(requestId)
      const msg = typeof err?.message === 'string' && err.message.trim()
        ? err.message
        : 'Failed to post message to VS Code extension'
      reject(new Error(msg))
    }
  })
}

// 消息处理器映射
type MessageHandler<T = any> = PendingRequestHandler<T>

const messageHandlers = new Map<string, MessageHandler>()

/**
 * 主动推送消息的订阅者集合。
 *
 * 修改原因：过去每次 onMessageFromExtension 都往 window 挂一个独立的 'message' 监听器，而每个监听器里
 *          又各自重复一遍「这是不是某个请求的响应」判断。十几个组件订阅后，流式期间的每一个 chunk 都要
 *          走十几遍相同的分发逻辑；更糟的是响应消息只被第一个监听器消费（它会 delete 掉 requestId），
 *          其余监听器查不到 requestId，就把这条响应当成主动推送消息交给了业务 handler。
 * 修改方式：只保留一个全局分发器——响应在这里就地兑现，其余消息再广播给订阅者。
 * 修改目的：每条消息只解析一次、只分类一次，且响应永远不会漏进推送处理链路。
 */
const pushMessageSubscribers = new Set<(message: VSCodeMessage) => void>()
let dispatcherAttached = false

function dispatchExtensionMessage(event: MessageEvent) {
  routeExtensionMessage(event.data, messageHandlers, message => {
    // 复制一份再遍历：订阅者可能在处理过程中取消订阅
    // 单个订阅者崩溃不应中断其余订阅者（如 backgroundTaskStore 等）
    for (const subscriber of [...pushMessageSubscribers]) {
      try {
        subscriber(message as VSCodeMessage)
      } catch (error) {
        console.error('[vscode] push message subscriber error:', error)
      }
    }
  })
}

// 监听来自插件的消息
export function onMessageFromExtension(
  handler: (message: VSCodeMessage) => void
): () => void {
  if (!dispatcherAttached) {
    dispatcherAttached = true
    window.addEventListener('message', dispatchExtensionMessage)
  }
  pushMessageSubscribers.add(handler)

  // 返回取消订阅函数
  return () => {
    pushMessageSubscribers.delete(handler)
  }
}

/**
 * 监听来自插件的命令推送
 * 
 * @param command 命令名称
 * @param handler 处理器
 * @returns 取消监听函数
 */
export function onExtensionCommand<T = any>(
  command: string,
  handler: (data: T) => void
): () => void {
  return onMessageFromExtension((message: any) => {
    if (message.type === 'command' && message.command === command) {
      handler(message.data)
    }
  })
}

// 状态持久化
export function saveState(key: string, value: any) {
  const vscode = getVSCodeAPI()
  const state = vscode.getState() || {}
  state[key] = value
  vscode.setState(state)
}

export function loadState<T = any>(key: string, defaultValue?: T): T | undefined {
  const vscode = getVSCodeAPI()
  const state = vscode.getState() || {}
  return state[key] !== undefined ? state[key] : defaultValue
}

export function clearState() {
  const vscode = getVSCodeAPI()
  vscode.setState({})
}

/**
 * 显示 VSCode 通知
 *
 * @param message 通知消息
 * @param type 通知类型：'info' | 'warning' | 'error'
 */
export async function showNotification(
  message: string,
  type: 'info' | 'warning' | 'error' = 'info'
): Promise<void> {
  try {
    // 声音提醒（失败不影响通知本身）
    if (type === 'warning') {
      void handleSoundEvent({
        cue: 'warning',
        source: 'notification',
        createdAt: Date.now()
      })
    } else if (type === 'error') {
      void handleSoundEvent({
        cue: 'error',
        source: 'notification',
        createdAt: Date.now()
      })
    }

    await sendToExtension('showNotification', { message, type })
  } catch (err) {
    console.error('Failed to show notification:', err)
  }
}

/**
 * 加载 diff 内容（用于 apply_diff 工具的按需加载）
 *
 * @param diffContentId Diff 内容 ID
 * @returns Diff 内容或 null
 */
export async function loadDiffContent(diffContentId: string): Promise<{
  originalContent: string
  newContent: string
  filePath: string
} | null> {
  try {
    const result = await sendToExtension<{
      success: boolean
      originalContent?: string
      newContent?: string
      filePath?: string
      error?: string
    }>('diff.loadContent', { diffContentId })
    
    if (result.success && result.originalContent && result.newContent) {
      return {
        originalContent: result.originalContent,
        newContent: result.newContent,
        filePath: result.filePath || ''
      }
    }
    return null
  } catch (err) {
    console.error('Failed to load diff content:', err)
    return null
  }
}