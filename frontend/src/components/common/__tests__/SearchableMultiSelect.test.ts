import { mount, flushPromises } from '@vue/test-utils';
import { describe, expect, test } from 'vitest';
import SearchableMultiSelect from '../SearchableMultiSelect.vue';

describe('可搜索多选与模型选择列表一致', () => {
  test('点击整行选择、筛选全选和取消都保留筛选外的已选项', async () => {
    const wrapper = mount(SearchableMultiSelect, { attachTo: document.body, props: { modelValue: ['private'], label: '工具', options: [
      { value: 'private', label: '已有工具' }, { value: 'search', label: 'search' }, { value: 'search2', label: 'search more' },
    ] } });
    try {
      await wrapper.get('button').trigger('click'); await flushPromises();
      const input = document.querySelector<HTMLInputElement>('.multiselect-search input')!;
      input.value = 'search'; input.dispatchEvent(new Event('input', { bubbles: true })); await flushPromises();
      document.querySelector<HTMLButtonElement>('.multiselect-toolbar button')!.click(); await flushPromises();
      const selected = wrapper.emitted('update:modelValue')!.at(-1)![0] as string[];
      expect(selected).toEqual(['private', 'search', 'search2']); await wrapper.setProps({ modelValue: selected });
      expect(document.querySelectorAll('[role=option][aria-selected=true]')).toHaveLength(2);
      document.querySelector<HTMLButtonElement>('.multiselect-toolbar button')!.click(); await flushPromises();
      expect(wrapper.emitted('update:modelValue')!.at(-1)![0]).toEqual(['private']);
      document.querySelector<HTMLElement>('.multiselect-panel')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await flushPromises();
      expect(document.querySelector('.multiselect-panel')).toBeNull();
    } finally { wrapper.unmount(); }
  });
});
