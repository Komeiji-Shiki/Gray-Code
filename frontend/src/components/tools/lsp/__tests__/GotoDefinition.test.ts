import { mount } from '@vue/test-utils';
import { afterEach, expect, test } from 'vitest';
import { setLanguage } from '../../../../i18n';
import GotoDefinition from '../goto_definition.vue';

afterEach(() => setLanguage('auto'));
test('展示真实分页数量和片段截断，不把空的末页称为符号不存在', () => {
  setLanguage('en');
  const wrapper = mount(GotoDefinition, { props: { args: {}, result: { data: {
    path: 'main.ts', line: 1, column: 1, definitionCount: 1, totalCount: 2, nextOffset: 1,
    definitions: [{ path: 'target.ts', line: 1, endLine: 10, content: 'code', contentTruncated: true }]
  } } }, global: { stubs: { CustomScrollbar: { template: '<div><slot /></div>' } } } });
  expect(wrapper.text()).toContain('1 definitions on this page, 2 total');
  expect(wrapper.text()).toContain('offset=1');
  expect(wrapper.text()).toContain('This definition is truncated');
  wrapper.unmount();
  const empty = mount(GotoDefinition, { props: { args: {}, result: { data: { totalCount: 2, definitionCount: 0, definitions: [] } } } });
  expect(empty.text()).toContain('No definitions on this page');
  empty.unmount();
});
