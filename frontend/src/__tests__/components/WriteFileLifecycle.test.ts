import { shallowMount, flushPromises } from '@vue/test-utils';
import { afterEach, expect, test, vi } from 'vitest';
import WriteFile from '../../components/tools/file/write_file.vue';
import { setLanguage } from '../../i18n';
const { load } = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock('../../utils/vscode', () => ({ loadDiffContent: load, showNotification: vi.fn() }));
vi.mock('../../components/tools/file/useWriteFilePlans', () => ({ useWriteFilePlans: () => ({ channelOptions: [], modelOptions: [], selectedChannelId: '', selectedModelId: '', isLoadingChannels: false,
  isLoadingModels: false, isExecutingPlan: false, togglePlanExpand() {}, isPlanExpanded: () => false, executePlan() {} }) }));
const wrappers: ReturnType<typeof shallowMount>[] = [];
afterEach(() => { wrappers.splice(0).forEach(wrapper => wrapper.unmount()); load.mockReset(); setLanguage('auto'); });
const result = (id?: string) => ({ data: { results: [{ path: 'sample.txt', success: true, diffContentId: id }] } });
test('同一路径的新差异先完成时，旧响应不能覆盖新预览', async () => {
  let old!: (value: unknown) => void;
  load.mockReturnValueOnce(new Promise(resolve => { old = resolve; })).mockResolvedValueOnce({ originalContent: 'base', newContent: 'latest', filePath: 'sample.txt' });
  const wrapper = shallowMount(WriteFile, { props: { args: { path: 'sample.txt', content: 'text' }, result: result('old') } }); wrappers.push(wrapper);
  await wrapper.setProps({ result: result('new') }); await flushPromises();
  expect(load.mock.calls.map(args => args[0])).toEqual(['old', 'new']);
  old({ originalContent: 'base', newContent: 'obsolete', filePath: 'sample.txt' }); await flushPromises();
  const state = wrapper.vm as unknown as { diffContents: Map<string, { newContent: string }> };
  expect(state.diffContents.get('sample.txt')?.newContent).toBe('latest');
  expect(wrapper.findComponent({ name: 'VirtualDiffLines' }).exists()).toBe(true);
});
test('当前结果不再引用差异时清理旧预览和加载状态', async () => {
  let finish!: (value: unknown) => void; load.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const wrapper = shallowMount(WriteFile, { props: { args: { path: 'sample.txt', content: 'text' }, result: result('old') } }); wrappers.push(wrapper);
  await wrapper.setProps({ result: result() }); finish({ originalContent: 'base', newContent: 'obsolete', filePath: 'sample.txt' }); await flushPromises();
  const state = wrapper.vm as unknown as { diffContents: Map<string, unknown> };
  expect(state.diffContents.size).toBe(0); expect(wrapper.find('.loading-diff').exists()).toBe(false);
});

test('写入回执到达前保留待写内容，失败时显示全局原因', async () => {
  setLanguage('zh-CN');
  const wrapper = shallowMount(WriteFile, {
    props: { args: { path: 'sample.txt', content: '待写正文' } },
    global: { stubs: { CustomScrollbar: { template: '<div><slot /></div>' }, ToolErrorMessage: false } }
  });
  wrappers.push(wrapper);
  expect(wrapper.find('.stat.success').exists()).toBe(false);
  expect(wrapper.text()).toContain('待写正文');
  await wrapper.setProps({ error: '写入已取消' });
  expect(wrapper.get('.panel-error').text()).toContain('写入已取消');

  const originalError = "ENOENT: no such file or directory, open '/workspace/sample.txt'";
  await wrapper.setProps({ error: originalError });
  expect(wrapper.get('.panel-error').text()).toContain(originalError);
  expect(wrapper.find('.panel-error details').exists()).toBe(false);
  await wrapper.setProps({ result: { success: false, error: originalError, displayErrorCode: 'ENOENT' } });
  const errorPanel = wrapper.get('.panel-error');
  expect(errorPanel.text()).toContain('文件或目录不存在');
  expect(errorPanel.get('.error-path').text()).toBe('sample.txt');
  expect(errorPanel.text()).not.toContain(originalError);
  const details = errorPanel.get<HTMLDetailsElement>('details');
  details.element.open = true;
  await details.trigger('toggle');
  expect(errorPanel.get('pre').text()).toBe(originalError);

  await wrapper.setProps({ error: undefined, result: { success: false,
    data: { results: [{ path: 'sample.txt', success: false, error: '未授予文件访问权限', displayErrorCode: 'EACCES' }] } } });
  expect(wrapper.get('.file-error').text()).toContain('没有权限访问该文件或目录');
  expect(wrapper.get('.file-error .error-path').text()).toBe('sample.txt');
});
