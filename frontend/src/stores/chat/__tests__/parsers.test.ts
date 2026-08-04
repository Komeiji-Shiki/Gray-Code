/**
 * parsers - BR-01 前端透传后端稳定节点 id。
 *
 * content.id → Message.id（不再每次加载重新生成）；无 id 时回退 generateId（向后兼容）；
 * 流式替换路径的显式 id 参数优先级最高。
 */
import { describe, it, expect } from 'vitest'
import { contentToMessage, contentToMessageEnhanced } from '../parsers'
import type { Content } from '../../../types'

function content(partial: Partial<Content> & { id?: string }): Content {
  return {
    role: 'user',
    parts: [{ text: 'hello' }],
    timestamp: 1000,
    ...partial
  } as Content
}

describe('parsers - BR-01 content.id 透传', () => {
  it('contentToMessage 使用 content.id 作为 Message.id（不再每次加载重新生成）', () => {
    const msg = contentToMessage(content({ role: 'model', id: 'node-123' }))
    expect(msg.id).toBe('node-123')
    expect(msg.backendIndex).toBeUndefined()
  })

  it('contentToMessageEnhanced 使用 content.id', () => {
    const msg = contentToMessageEnhanced(content({ id: 'node-456', index: 2 }))
    expect(msg.id).toBe('node-456')
    expect(msg.backendIndex).toBe(2)
  })

  it('显式 id 参数优先于 content.id（流式替换路径保持消息身份）', () => {
    const msg = contentToMessage(content({ role: 'model', id: 'node-1' }), 'stream-msg-1')
    expect(msg.id).toBe('stream-msg-1')

    const enhanced = contentToMessageEnhanced(content({ id: 'node-2' }), 'stream-msg-2')
    expect(enhanced.id).toBe('stream-msg-2')
  })

  it('无 content.id 时回退 generateId（向后兼容，两次加载生成不同 id）', () => {
    const a = contentToMessage(content({ role: 'model' }))
    const b = contentToMessage(content({ role: 'model' }))
    expect(a.id).toBeTruthy()
    expect(b.id).toBeTruthy()
    expect(a.id).not.toBe(b.id)

    const enhanced = contentToMessageEnhanced(content({ role: 'user' }))
    expect(enhanced.id).toBeTruthy()
  })

  it('空字符串 id 视为缺失，回退 generateId', () => {
    const msg = contentToMessage(content({ role: 'model', id: '' }))
    expect(msg.id).toBeTruthy()
    expect(msg.id).not.toBe('')
  })
})
