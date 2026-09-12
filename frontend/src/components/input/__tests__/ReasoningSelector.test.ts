import { mount, flushPromises } from '@vue/test-utils';
import { expect, test } from 'vitest';
import ReasoningSelector from '../ReasoningSelector.vue';

test('在模型旁的控件选择档位并恢复跟随渠道设置', async () => {
  const wrapper = mount(ReasoningSelector, { attachTo: document.body, props: { modelValue: '', levels: ['low', 'high'] } });
  try {
    await wrapper.get('button').trigger('click'); await flushPromises();
    const options = [...document.querySelectorAll<HTMLElement>('[role=option]')];
    expect(options).toHaveLength(3);
    options.find(item => item.textContent?.includes('high'))!.click(); await flushPromises();
    expect(wrapper.emitted('update:modelValue')!.at(-1)).toEqual(['high']);
    await wrapper.setProps({ modelValue: 'high' }); await wrapper.get('button').trigger('click'); await flushPromises();
    [...document.querySelectorAll<HTMLElement>('[role=option]')].find(item => item.textContent?.includes('跟随渠道设置'))!.click(); await flushPromises();
    expect(wrapper.emitted('update:modelValue')!.at(-1)).toEqual(['']);
  } finally { wrapper.unmount(); }
});
