/**
 * backgroundTaskStore.dismissCompletedTasks 单元测试
 *
 * 覆盖：一键清除所有「已结束且已回流（reported）」的后台任务 chip；
 * 运行中任务与未回流任务（回执尚未进入对话历史）必须保留。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const mockChat = {
  isStreaming: false,
  isWaitingForResponse: false,
  currentConversationId: 'conv_1',
  sendMessage: vi.fn().mockResolvedValue(true)
}

vi.mock('../../utils/vscode', () => ({
  sendToExtension: vi.fn().mockResolvedValue({ success: true }),
  onMessageFromExtension: vi.fn()
}))

vi.mock('../../stores/chatStore', () => ({
  useChatStore: () => mockChat
}))

import { useBackgroundTaskStore } from '../../stores/backgroundTaskStore'

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
    taskType: 'terminal',
    type: 'complete' as const,
    data,
    createdAt: 2000
  }
}

/** 等待 store 内部异步回流（flushReports）完成 */
async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

describe('backgroundTaskStore.dismissCompletedTasks', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockChat.isStreaming = false
    mockChat.isWaitingForResponse = false
    mockChat.currentConversationId = 'conv_1'
    mockChat.sendMessage.mockResolvedValue(true)
    setActivePinia(createPinia())
  })

  it('一键清除所有已结束任务（含未回流），仅保留运行中', async () => {
    const store = useBackgroundTaskStore()

    // t1、t2：完成并成功回流（reported=true）
    store.handleTaskEvent(startEvent('t1', 'terminal', { background: true, command: 'npm test' }))
    store.handleTaskEvent(completeEvent('t1'))
    await settle()

    store.handleTaskEvent(startEvent('t2', 'background_subagent', { background: true, agentName: 'reviewer', runId: 'r2' }))
    store.handleTaskEvent(completeEvent('t2'))
    await settle()

    // t3：运行中
    store.handleTaskEvent(startEvent('t3', 'terminal', { background: true, command: 'sleep 100' }))

    // t4：完成但会话正忙 → 回执挂起（reported=false）
    mockChat.isStreaming = true
    store.handleTaskEvent(startEvent('t4', 'terminal', { background: true, command: 'build' }))
    store.handleTaskEvent(completeEvent('t4'))
    await settle()
    mockChat.isStreaming = false

    // 前置校验：t1/t2 已回流，t3 运行中，t4 未回流
    expect(store.taskList.find(t => t.taskId === 't1')?.reported).toBe(true)
    expect(store.taskList.find(t => t.taskId === 't2')?.reported).toBe(true)
    expect(store.taskList.find(t => t.taskId === 't3')?.status).toBe('running')
    expect(store.taskList.find(t => t.taskId === 't4')?.reported).toBe(false)

    // 一键清除：所有非 running 任务（含未回流的 t4）都被移除，运行中的 t3 保留
    store.dismissCompletedTasks()

    expect(store.taskList.map(t => t.taskId)).toEqual(['t3'])
    expect(store.taskList.find(t => t.taskId === 't3')?.status).toBe('running')
  })

  it('无可清除任务时不改动任务表', () => {
    const store = useBackgroundTaskStore()
    store.handleTaskEvent(startEvent('t1', 'terminal', { background: true, command: 'sleep' }))

    const before = store.tasks
    store.dismissCompletedTasks()
    expect(store.tasks).toBe(before)
    expect(store.taskList.map(t => t.taskId)).toEqual(['t1'])
  })
})
