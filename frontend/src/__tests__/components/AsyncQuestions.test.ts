import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import AsyncQuestions from '../../components/input/AsyncQuestions.vue'

const mock = vi.hoisted(() => ({ send: vi.fn(), changed: undefined as undefined | ((message: { type: string }) => void) }))
vi.mock('../../utils/vscode', () => ({
  sendToExtension: mock.send,
  onMessageFromExtension: (handler: (message: { type: string }) => void) => { mock.changed = handler; return vi.fn() }
}))
const question = (id: string) => ({ id, runId: 'run', actorId: 'actor', createdAt: 0, expiresAt: 1000, questions: [{ title: id }] })

describe('异步问题的会话归属', () => {
  beforeEach(() => mock.send.mockReset())
  afterEach(() => { mock.changed = undefined })

  test('切换会话立即移除旧问题，等待新列表时不能提交旧回答', async () => {
    mock.send.mockResolvedValueOnce([question('first')]).mockReturnValueOnce(new Promise(() => {}))
    const wrapper = mount(AsyncQuestions, { props: { conversationId: 'first' } })
    await flushPromises()
    expect(wrapper.find('.async-question').exists()).toBe(true)
    await wrapper.setProps({ conversationId: 'second' })
    expect(wrapper.find('.async-question').exists()).toBe(false)
    wrapper.unmount()
  })

  test('同会话较早的刷新迟到时，不重新显示已经消失的问题', async () => {
    let finishOld!: (result: unknown) => void
    mock.send.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve }))
      .mockResolvedValueOnce([])
    const wrapper = mount(AsyncQuestions, { props: { conversationId: 'conversation' } })
    mock.changed!({ type: 'platformQuestionsChanged' })
    await flushPromises()
    finishOld([question('answered')])
    await flushPromises()
    expect(wrapper.find('.async-question').exists()).toBe(false)
    wrapper.unmount()
  })

  test('提交在途时禁止重复提交，切换后的旧失败不污染新问题', async () => {
    let rejectAnswer!: (error: Error) => void
    mock.send.mockImplementation((type, data) => type === 'platform.questions.answer'
      ? new Promise((_resolve, reject) => { rejectAnswer = reject })
      : Promise.resolve(type === 'platform.questions.list' ? [question(data.conversationId)] : undefined))
    const wrapper = mount(AsyncQuestions, { props: { conversationId: 'first' } })
    await flushPromises()
    await wrapper.get('input').setValue('answer')
    await wrapper.get('button').trigger('click')
    expect(wrapper.get('button').attributes('disabled')).toBeDefined()
    await wrapper.setProps({ conversationId: 'second' })
    await flushPromises()
    rejectAnswer(new Error('old request failed'))
    await flushPromises()
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('second')
    wrapper.unmount()
  })
})
