import { mount } from '@vue/test-utils'
import { describe, expect, test } from 'vitest'
import ChannelImageInput from '../ChannelImageInput.vue'
import type { ChannelConfig } from '@/types'

describe('渠道图片数量上限', () => {
  test('Gemini 旧设置可直接调整，清空输入保持草稿，零值可以关闭限制', async () => {
    const wrapper = mount(ChannelImageInput, { props: { config: { id: 'gemini', type: 'gemini', options: { maxImages: 5 }, optionsEnabled: { maxImages: true } } as ChannelConfig } })
    expect((wrapper.get('input').element as HTMLInputElement).value).toBe('5')
    await wrapper.get('input').setValue(''); expect(wrapper.emitted('update:limit')).toBeUndefined()
    await wrapper.get('input').setValue('3'); expect(wrapper.emitted('update:limit')?.at(-1)).toEqual([3])
    await wrapper.get('input').setValue('0'); expect(wrapper.emitted('update:limit')?.at(-1)).toEqual([0])
    wrapper.unmount()
  })
  test('所有渠道都可配置，负数和小数不写入设置', async () => {
    const wrapper = mount(ChannelImageInput, { props: { config: { id: 'openai', type: 'openai' } as ChannelConfig } })
    expect((wrapper.get('input').element as HTMLInputElement).value).toBe('0')
    await wrapper.get('input').setValue('-1'); await wrapper.get('input').setValue('1.5')
    expect(wrapper.emitted('update:limit')).toBeUndefined()
    await wrapper.get('input').setValue('10'); expect(wrapper.emitted('update:limit')?.at(-1)).toEqual([10])
    wrapper.unmount()
  })
})
