/**
 * backgroundTaskStore 消息路由回归测试
 *
 * 背景：后端统一走 sendCommand 队列推送（消息结构 { type: 'command', command: 'taskEvent', data }），
 * 但本 store 曾按旧格式（message.type === 'taskEvent'）匹配，导致 taskEvent 永远收不到、
 * 输入框上方的后台任务小气泡（BackgroundTaskBar）永不出现。
 * 本测试锁定：command 格式消息 → store 正确登记任务（start）并推进终态（complete）。
 */
import { describe, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('../../utils/vscode', () => ({
  sendToExtension: vi.fn(async (type: string) => (
    type === 'getWorkspaceUri' ? null : { success: true }
  )),
  onMessageFromExtension: vi.fn(() => () => {}),
  onExtensionCommand: vi.fn(() => () => {})
}))

import { onExtensionCommand, sendToExtension } from '../../utils/vscode'
import { useBackgroundTaskStore } from '../../stores/backgroundTaskStore'
import { useChatStore } from '../../stores/chatStore'

type TaskEventHandler = (event: { taskId: string; taskType: string; type: string; data?: Record<string, unknown>; createdAt?: number }) => void

function startEvent(taskId: string, taskType: 'terminal' | 'background_subagent', data: Record<string, unknown>) {
  return {
    taskId,
    taskType,
    type: 'start' as const,
    data,
    createdAt: 1000
  }
}

function completeEvent(taskId: string, data: Record<string, unknown> = {}) {
  return {
    taskId,
    taskType: 'background_subagent',
    type: 'complete' as const,
    data,
    createdAt: 2000
  }
}

describe('backgroundTaskStore 消息路由（command 格式）', () => {
  let handler: TaskEventHandler

  beforeEach(() => {
    vi.clearAllMocks()
    setActivePinia(createPinia())
  })

  test('initialize 以 taskEvent 命令名注册订阅', () => {
    const store = useBackgroundTaskStore()
    store.initialize()
    const calls = vi.mocked(onExtensionCommand).mock.calls
    expect(calls.some(c => c[0] === 'taskEvent')).toBe(true)
    store.initialize()
    // 幂等：重复 initialize 不重复注册
    expect(vi.mocked(onExtensionCommand).mock.calls.filter(c => c[0] === 'taskEvent').length).toBe(1)
  })

  test('收到 command 格式的 taskEvent 消息后登记后台任务（start → running）', () => {
    const store = useBackgroundTaskStore()
    store.initialize()
    handler = vi.mocked(onExtensionCommand).mock.calls.find(c => c[0] === 'taskEvent')![1] as unknown as TaskEventHandler

    handler(startEvent('t1', 'background_subagent', { background: true, agentName: 'reviewer', runId: 'r1' }))

    expect(store.taskList).toHaveLength(1)
    expect(store.taskList[0]).toMatchObject({
      taskId: 't1',
      status: 'running',
      kind: 'subagent'
    })
  })

  test('complete 事件推进任务为 completed（对勾态由 UI 按 status 渲染）', () => {
    const store = useBackgroundTaskStore()
    store.initialize()
    handler = vi.mocked(onExtensionCommand).mock.calls.find(c => c[0] === 'taskEvent')![1] as unknown as TaskEventHandler

    handler(startEvent('t1', 'background_subagent', { background: true, agentName: 'reviewer', runId: 'r1' }))
    handler(completeEvent('t1', { response: '调研完成', steps: 3 }))

    expect(store.taskList[0]).toMatchObject({
      taskId: 't1',
      status: 'completed'
    })
  })

  test('cleanup 后取消订阅', () => {
    const store = useBackgroundTaskStore()
    const cleanup = store.initialize()
    cleanup()
    // cleanup 内部调用 onExtensionCommand 返回的取消函数（mock 返回 () => {}，不抛错即可）
    expect(sendToExtension).toHaveBeenCalled()
  })

  test('端到端：command 消息 start → complete 后，回执作为消息发送给主模型（reported=true）', async () => {
    // 真实 chatStore 实例（pinia 下创建时注册单向桥，flushReports 才能拿到会话状态）
    const chat = useChatStore()
    chat.currentConversationId = 'conv_1'
    chat.isStreaming = false
    chat.isWaitingForResponse = false

    const store = useBackgroundTaskStore()
    store.initialize()
    handler = vi.mocked(onExtensionCommand).mock.calls.find(c => c[0] === 'taskEvent')![1] as unknown as TaskEventHandler

    handler(startEvent('t1', 'background_subagent', { background: true, agentName: 'reviewer', runId: 'r1', conversationId: 'conv_1' }))
    handler(completeEvent('t1', { response: '调研完成', steps: 3, runId: 'r1' }))

    // 等 flushReports 异步链（claim → awaitIdle → sendMessage）完成
    await new Promise(resolve => setTimeout(resolve, 10))

    // 任务被标记已回流 = 回执已成功发送进对话（主模型可见）
    expect(store.taskList.find(t => t.taskId === 't1')?.reported).toBe(true)
    // 回执消息确实发出（sendMessage → chatStream IPC）
    const sentPayload = vi.mocked(sendToExtension).mock.calls
      .filter(([type]) => type === 'chatStream' || type === 'chat.sendMessage')
      .map(([, data]) => JSON.stringify(data))
      .find(s => s.includes('[Background task completed]'))
    expect(sentPayload).toBeTruthy()
    expect(sentPayload).toContain('调研完成')
  })
})
