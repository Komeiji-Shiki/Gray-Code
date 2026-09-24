import { mount } from '@vue/test-utils'
import BotConversationFields from '../../components/settings/discord/BotConversationFields.vue'

describe('Bot 总结设置', () => {
  test('旧时间设置显示两种方式与时间开关，修改旧参数后仍保留旧配置', async () => {
    const wrapper = mount(BotConversationFields, { props: { modelValue: { autoSummary: {
      enabled: true, method: 'time' as const, trigger: 'idle' as const, minutes: 30, percent: 80, prompt: '保留事实',
    } } } })
    const label = (text: string) => wrapper.findAll('label').find(item => item.text().includes(text))!
    expect(label('总结方式').findAll('option').map(option => option.attributes('value'))).toEqual(['summary', 'notes'])
    expect((label('开启时间总结').find('input').element as HTMLInputElement).checked).toBe(true)
    await label('压缩前面多少内容').find('input').setValue('60')
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toMatchObject({ autoSummary: { method: 'time', percent: 60 } })
    await label('开启时间总结').find('input').setValue(false)
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toMatchObject({ autoSummary: { method: 'summary', timedEnabled: false } })
  })
})
