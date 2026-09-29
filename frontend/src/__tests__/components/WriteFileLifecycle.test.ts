import { shallowMount, flushPromises } from '@vue/test-utils';
import { afterEach, expect, test, vi } from 'vitest';
import WriteFile from '../../components/tools/file/write_file.vue';
const { load } = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock('../../utils/vscode', () => ({ loadDiffContent: load, showNotification: vi.fn() }));
vi.mock('../../components/tools/file/useWriteFilePlans', () => ({ useWriteFilePlans: () => ({ channelOptions: [], modelOptions: [], selectedChannelId: '', selectedModelId: '', isLoadingChannels: false,
  isLoadingModels: false, isExecutingPlan: false, togglePlanExpand() {}, isPlanExpanded: () => false, executePlan() {} }) }));
const wrappers: ReturnType<typeof shallowMount>[] = [];
afterEach(() => { wrappers.splice(0).forEach(wrapper => wrapper.unmount()); load.mockReset(); });
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
});
test('当前结果不再引用差异时清理旧预览和加载状态', async () => {
  let finish!: (value: unknown) => void; load.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const wrapper = shallowMount(WriteFile, { props: { args: { path: 'sample.txt', content: 'text' }, result: result('old') } }); wrappers.push(wrapper);
  await wrapper.setProps({ result: result() }); finish({ originalContent: 'base', newContent: 'obsolete', filePath: 'sample.txt' }); await flushPromises();
  const state = wrapper.vm as unknown as { diffContents: Map<string, unknown>; loadingDiffs: Set<string> };
  expect(state.diffContents.size).toBe(0); expect(state.loadingDiffs.size).toBe(0);
});
