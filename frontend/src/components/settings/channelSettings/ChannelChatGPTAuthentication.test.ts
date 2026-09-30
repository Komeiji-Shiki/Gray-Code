import { mount, flushPromises } from '@vue/test-utils'
import { describe, test, expect, vi, afterEach } from 'vitest'
import ChannelChatGPTAuthentication from './ChannelChatGPTAuthentication.vue'
import { sendToExtension } from '@/utils/vscode'

vi.mock('@/utils/vscode', () => ({ sendToExtension: vi.fn() }))
vi.mock('@/i18n', () => ({ t: (key: string) => key }))
const send = vi.mocked(sendToExtension)
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); send.mockReset() })

describe('ChatGPT 渠道认证界面', () => {
  test('准备草稿后打开授权，轮询完成并展示订阅与用量入口，离开时只取消本次登录', async () => {
    vi.useFakeTimers()
    let completed = false, pending = false
    send.mockImplementation(async (type: string) => {
      if (type === 'chatgpt.start') { pending = true; return { url: 'https://auth.openai.com/api/accounts/authorize?state=test' } as any }
      if (type === 'chatgpt.status') return {
        storageAvailable: true,
        accounts: completed ? [{ clientId: 'oaiapp_test', email: 'user@example.test', connected: true, planEnabled: true }] : [],
        activeClientId: completed ? 'oaiapp_test' : undefined, needsUsageNotice: completed,
        usageUrl: 'https://chatgpt.com/#settings/Usage',
        login: pending ? { state: completed ? 'completed' : 'pending' } : undefined,
      } as any
      return { success: true } as any
    })
    const open = vi.spyOn(window, 'open').mockReturnValue(null), prepare = vi.fn().mockResolvedValue(undefined)
    const wrapper = mount(ChannelChatGPTAuthentication, { props: { configId: 'channel', prepare }, global: { stubs: { ConfirmDialog: true } } })
    await flushPromises()
    await wrapper.find('button').trigger('click'); await flushPromises()
    expect(prepare).toHaveBeenCalledTimes(1)
    expect(open).toHaveBeenCalledWith(expect.stringContaining('https://auth.openai.com/'), '_blank', 'noopener,noreferrer')
    expect(wrapper.find('input').exists()).toBe(true)
    completed = true
    await vi.advanceTimersByTimeAsync(1000); await flushPromises()
    expect(wrapper.text()).toContain('desktop.chatgpt.usingPlan')
    expect(wrapper.text()).toContain('user@example.test')
    expect(wrapper.find('a[href="https://chatgpt.com/#settings/Usage"]').exists()).toBe(true)
    expect(wrapper.find('input').exists()).toBe(false)
    wrapper.unmount(); await flushPromises()
    expect(send).toHaveBeenCalledWith('chatgpt.cancel', { configId: 'channel' })
    expect(send).not.toHaveBeenCalledWith('config.revealApiKey', expect.anything())
  })
})
