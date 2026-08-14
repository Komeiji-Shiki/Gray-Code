/**
 * A-COMM agent 间消息卡片（展示层）测试
 *
 * 覆盖：
 * - 后端投递成功事件（toRunId 为子代理）→ backgroundTaskStore 路由到
 *   chatStore.insertAgentMessageCard，卡片插入收件方位置、后续消息 backendIndex +1；
 * - 幂等：同 mailbox messageId 重复事件不重复插入；
 * - 窗口外（插入点早于 windowStartIndex）忽略，由历史加载覆盖；
 * - 收件方为主会话（main）的事件仍走原 claim 调度（不插入卡片）。
 */
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { Message } from '../../types'
import type { AgentMessageCardInfo } from '../../types'

vi.mock('../../utils/vscode', () => ({
  sendToExtension: vi.fn(async () => ({ success: true })),
  onMessageFromExtension: vi.fn(() => () => {}),
  onExtensionCommand: vi.fn(() => () => {})
}))

import { sendToExtension } from '../../utils/vscode'
import { useChatStore } from '../../stores/chatStore'
import { useBackgroundTaskStore } from '../../stores/backgroundTaskStore'

function makeMessage(index: number): Message {
  return {
    id: `msg_${index}`,
    role: 'user',
    content: `message ${index}`,
    timestamp: 1000 + index,
    backendIndex: index,
    parts: [{ text: `message ${index}` }]
  } as Message
}

function makeCard(messageId: string, toRunId: string, text: string): AgentMessageCardInfo {
  return {
    messageId,
    fromRunId: 'run_a',
    fromAgentName: 'Agent A',
    toRunId,
    toAgentName: 'Agent B',
    threadId: `thread_${messageId}`,
    hopDepth: 1,
    text,
    createdAt: 5000
  }
}

/** 等待 store 内部异步处理完成 */
async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

describe('agent 间消息卡片（A-COMM 展示层）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.mocked(sendToExtension).mockClear()
    vi.mocked(sendToExtension).mockResolvedValue({ success: true })
  })

  test('事件到达后卡片插入收件方位置，插入点之后的后端消息 backendIndex +1', async () => {
    const store = useChatStore()
    store.currentConversationId = 'conv_1'
    store.isStreaming = false
    store.isWaitingForResponse = false
    store.windowStartIndex = 0
    store.allMessages = [makeMessage(0), makeMessage(1), makeMessage(2)]

    const bgStore = useBackgroundTaskStore()
    bgStore.handleTaskEvent({
      taskId: 'agentmsg:card_1',
      taskType: 'agent_message',
      type: 'progress',
      data: {
        conversationId: 'conv_1',
        messageId: 'card_1',
        toRunId: 'run_b',
        card: makeCard('card_1', 'run_b', 'hello B'),
        insertPosition: 2
      },
      createdAt: 6000
    })
    await settle()

    expect(store.allMessages).toHaveLength(4)
    const card = store.allMessages[2]
    expect(card.source).toBe('agent_message')
    expect(card.agentMessage?.messageId).toBe('card_1')
    expect(card.agentMessage?.text).toBe('hello B')
    expect(card.backendIndex).toBe(2)
    // 插入点之后的消息索引同步后移（与后端 insertContent 一致）
    expect(store.allMessages[3].id).toBe('msg_2')
    expect(store.allMessages[3].backendIndex).toBe(3)
    // 之前的消息不受影响
    expect(store.allMessages[0].backendIndex).toBe(0)
    expect(store.allMessages[1].backendIndex).toBe(1)
  })

  test('幂等：同 mailbox messageId 的重复事件不重复插入', async () => {
    const store = useChatStore()
    store.currentConversationId = 'conv_1'
    store.isStreaming = false
    store.isWaitingForResponse = false
    store.windowStartIndex = 0
    store.allMessages = [makeMessage(0)]

    const bgStore = useBackgroundTaskStore()
    const event = {
      taskId: 'agentmsg:card_2',
      taskType: 'agent_message' as const,
      type: 'progress' as const,
      data: {
        conversationId: 'conv_1',
        messageId: 'card_2',
        toRunId: 'run_b',
        card: makeCard('card_2', 'run_b', 'hello again'),
        insertPosition: 1
      },
      createdAt: 6000
    }
    bgStore.handleTaskEvent(event)
    await settle()
    bgStore.handleTaskEvent(event)
    await settle()

    expect(store.allMessages).toHaveLength(2)
    expect(store.allMessages.filter(m => m.agentMessage?.messageId === 'card_2')).toHaveLength(1)
  })

  test('插入点在窗口外（早于 windowStartIndex）时忽略，交给历史加载', async () => {
    const store = useChatStore()
    store.currentConversationId = 'conv_1'
    store.isStreaming = false
    store.isWaitingForResponse = false
    store.windowStartIndex = 5
    store.allMessages = [makeMessage(5), makeMessage(6)]

    const bgStore = useBackgroundTaskStore()
    bgStore.handleTaskEvent({
      taskId: 'agentmsg:card_3',
      taskType: 'agent_message',
      type: 'progress',
      data: {
        conversationId: 'conv_1',
        messageId: 'card_3',
        toRunId: 'run_b',
        card: makeCard('card_3', 'run_b', 'outside window'),
        insertPosition: 2 // 绝对索引 2 < windowStartIndex 5
      },
      createdAt: 6000
    })
    await settle()

    expect(store.allMessages).toHaveLength(2)
    expect(store.allMessages.some(m => m.agentMessage?.messageId === 'card_3')).toBe(false)
  })

  test('非当前会话的事件不插入（后端已持久化，切回时历史加载覆盖）', async () => {
    const store = useChatStore()
    store.currentConversationId = 'conv_1'
    store.isStreaming = false
    store.isWaitingForResponse = false
    store.windowStartIndex = 0
    store.allMessages = [makeMessage(0)]

    const bgStore = useBackgroundTaskStore()
    bgStore.handleTaskEvent({
      taskId: 'agentmsg:card_4',
      taskType: 'agent_message',
      type: 'progress',
      data: {
        conversationId: 'conv_other',
        messageId: 'card_4',
        toRunId: 'run_b',
        card: makeCard('card_4', 'run_b', 'other conversation'),
        insertPosition: 1
      },
      createdAt: 6000
    })
    await settle()

    expect(store.allMessages).toHaveLength(1)
  })

  test('收件方为主会话（main）的事件仍走 claim 调度，不插入卡片', async () => {
    const store = useChatStore()
    store.currentConversationId = 'conv_1'
    store.isStreaming = false
    store.isWaitingForResponse = false
    store.windowStartIndex = 0
    store.allMessages = [makeMessage(0)]

    const bgStore = useBackgroundTaskStore()
    bgStore.handleTaskEvent({
      taskId: 'agentmsg:m1',
      taskType: 'agent_message',
      type: 'progress',
      data: { conversationId: 'conv_1', messageId: 'm1' }, // 无 toRunId → 主会话语义
      createdAt: 6000
    })
    await settle()

    // 走原 claim 调度路径（chat.claimAgentMessages 被调用），不插入卡片
    expect(vi.mocked(sendToExtension).mock.calls.some(([type]) => type === 'chat.claimAgentMessages')).toBe(true)
    expect(store.allMessages.some(m => m.agentMessage?.messageId === 'm1')).toBe(false)
  })

  test('事件缺少卡片数据/插入位置时安全忽略', async () => {
    const store = useChatStore()
    store.currentConversationId = 'conv_1'
    store.isStreaming = false
    store.isWaitingForResponse = false
    store.windowStartIndex = 0
    store.allMessages = [makeMessage(0)]

    const bgStore = useBackgroundTaskStore()
    bgStore.handleTaskEvent({
      taskId: 'agentmsg:card_5',
      taskType: 'agent_message',
      type: 'progress',
      data: { conversationId: 'conv_1', messageId: 'card_5', toRunId: 'run_b' }, // 缺 card / insertPosition
      createdAt: 6000
    })
    await settle()

    expect(store.allMessages).toHaveLength(1)
    expect(store.allMessages.some(m => m.agentMessage?.messageId === 'card_5')).toBe(false)
  })
})
