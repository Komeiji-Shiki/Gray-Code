/**
 * agentStopNotificationController - suppressNextStop 生命周期回归测试
 *
 * 问题背景：suppressNextStop 只在下一次 stop 或 cancelStream 失败时清除。
 * 用户取消后立刻发送新消息（新一轮开始），若旧一轮的 stop 处理因 agent 已恢复而中止
 * （handleAgentStopped 的 isAgentRunning 检查抢先返回），suppressNextStop 不会被消费，
 * 新一轮正常结束的 stop 会被误判为用户取消而吞掉通知。
 *
 * 修复：markUserCancelled 后，在下一次 isAgentRunning() 转 true（新一轮开始）时复位 suppressNextStop。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { nextTick, reactive } from 'vue'
import {
  AgentStopNotificationController,
  type AgentStopNotificationControllerChatStore
} from '../../services/agentStopNotificationController'

/**
 * 使用 reactive() 包装 store：控制器内部用 Vue watch 监听 isAgentRunning()，
 * 普通对象属性无法被追踪，必须响应式化才能驱动 watcher。
 */
function createStore(
  overrides: Partial<AgentStopNotificationControllerChatStore> = {}
): AgentStopNotificationControllerChatStore {
  return reactive<AgentStopNotificationControllerChatStore>({
    isStreaming: false,
    isWaitingForResponse: false,
    error: null,
    retryStatus: null,
    needsContinueButton: false,
    hasPendingToolConfirmation: false,
    pendingToolCalls: [],
    allMessages: [],
    currentConversationId: 'conv-1',
    currentConversation: null,
    ...overrides
  })
}
const enabledSoundSettings = {
  windowsAgentStopNotification: {
    enabled: true,
    onlyWhenWindowNotFocused: false,
    cases: { error: true, awaitingUserAction: true, continueRequired: true },
    content: {}
  }
} as any

async function flushWatcher(): Promise<void> {
  await nextTick()
  await Promise.resolve()
  await nextTick()
}

function createController(
  store: AgentStopNotificationControllerChatStore,
  sendToExtension: any
): AgentStopNotificationController {
  return new AgentStopNotificationController({
    chatStore: store,
    sendToExtension,
    getSoundSettings: () => enabledSoundSettings
  })
}

describe('AgentStopNotificationController suppressNextStop', () => {
  let sendToExtension: ReturnType<typeof vi.fn>

  beforeEach(() => {
    sendToExtension = vi.fn().mockResolvedValue({ success: true })
  })

  it('取消后新一轮开始会复位 suppressNextStop，新一轮正常结束的 stop 正常通知', async () => {
    const store = createStore({ isStreaming: true, isWaitingForResponse: true })
    const controller = createController(store, sendToExtension)

    // 用户点击取消
    controller.markUserCancelled()

    // 取消生效：isRunning → false，watcher 触发 (false, true)，handleAgentStopped 挂起等待
    store.isStreaming = false
    store.isWaitingForResponse = false
    await nextTick()

    // 新一轮立即开始（handleAgentStopped 尚未完成）：
    // isRunning → true，watcher 触发 (true, false)，应复位 suppressNextStop
    store.isStreaming = true
    store.isWaitingForResponse = true
    await flushWatcher()

    // 新一轮正常结束（需要 continue 按钮 → 应产生 continue_required 通知，而非被抑制）
    store.needsContinueButton = true
    store.isStreaming = false
    store.isWaitingForResponse = false
    await flushWatcher()

    expect(sendToExtension).toHaveBeenCalledWith(
      'notifications.agentStop',
      expect.objectContaining({ reason: 'continue_required' })
    )
  })

  it('正常取消流程不受影响：取消后的 stop 被抑制，且不产生误通知', async () => {
    const store = createStore({ isStreaming: true, isWaitingForResponse: true })
    const controller = createController(store, sendToExtension)

    controller.markUserCancelled()

    // 取消生效（独立 tick）：watcher (false, true) → handleAgentStopped 应抑制通知
    store.isStreaming = false
    store.isWaitingForResponse = false
    await flushWatcher()

    expect(sendToExtension).not.toHaveBeenCalled()

    // 新一轮开始并正常结束 → 应正常通知
    store.isStreaming = true
    store.isWaitingForResponse = true
    store.needsContinueButton = true
    await flushWatcher()

    store.isStreaming = false
    store.isWaitingForResponse = false
    await flushWatcher()

    expect(sendToExtension).toHaveBeenCalledWith(
      'notifications.agentStop',
      expect.objectContaining({ reason: 'continue_required' })
    )
  })

  it('agent 未运行时 markUserCancelled 被忽略，后续 stop 正常通知', async () => {
    const store = createStore()
    const controller = createController(store, sendToExtension)

    // agent 未运行：markUserCancelled 不应设置 suppressNextStop
    controller.markUserCancelled()

    store.isStreaming = true
    store.isWaitingForResponse = true
    store.needsContinueButton = true
    await flushWatcher()

    store.isStreaming = false
    store.isWaitingForResponse = false
    await flushWatcher()

    expect(sendToExtension).toHaveBeenCalledWith(
      'notifications.agentStop',
      expect.objectContaining({ reason: 'continue_required' })
    )
  })

  it('dispose 后不再响应状态变化', async () => {
    const store = createStore({ isStreaming: true, isWaitingForResponse: true })
    const controller = createController(store, sendToExtension)
    controller.dispose()

    store.isStreaming = false
    store.isWaitingForResponse = false
    store.needsContinueButton = true
    await flushWatcher()

    expect(sendToExtension).not.toHaveBeenCalled()
  })
})
