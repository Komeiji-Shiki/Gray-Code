import { mount, flushPromises } from '@vue/test-utils';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import SearchPanel from '../../../../apps/client/src/components/SearchPanel.vue';

const mocks = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../../../../apps/client/src/api', () => ({ call: mocks.call }));
const wrappers: ReturnType<typeof mount>[] = [];
const deferred = <T,>() => {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};
const result = () => ({ count: 1, truncated: false, skipped: [], files: [{ path: 'a.txt', hash: 'original-hash', draft: false,
  matches: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } }, text: 'needle', preview: 'needle' }] }] });
const rpc = async (method: string, params: any) => {
  if (method === 'files.search') return result();
  if (method === 'files.replacePreview') return params.files.map((file: any) => ({ path: file.path, before: 'needle', after: params.replacement }));
};
beforeEach(() => {
  mocks.call.mockReset().mockImplementation(rpc);
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  let id = 0; vi.stubGlobal('crypto', { randomUUID: () => 'query-' + (++id) });
});
afterEach(() => { wrappers.splice(0).forEach(wrapper => wrapper.unmount()); vi.unstubAllGlobals(); });
function panel() {
  const flush = vi.fn(async () => {}), history = { undo: vi.fn(async () => {}), redo: vi.fn(async () => {}) };
  const apply = vi.fn(async () => history), saveAll = vi.fn(async () => {});
  const wrapper = mount(SearchPanel, { props: { workspaceId: 'first', flush, apply, saveAll } }); wrappers.push(wrapper);
  const replaceButton = () => wrapper.findAll('button').find(button => button.text() === '替换所选文件')!;
  return { wrapper, flush, history, apply, saveAll, replaceButton };
}
async function searched(value: ReturnType<typeof panel>) {
  await value.wrapper.get('header button').trigger('click');
  await value.wrapper.get('input[aria-label="项目搜索内容"]').setValue('needle');
  await value.wrapper.get('input[aria-label="替换内容"]').setValue('replacement');
  await value.wrapper.get('form').trigger('submit'); await flushPromises();
}

test('搜索窗口只挂载附近命中，滚动定位保留原 range，屏幕外勾选仍参与替换', async () => {
  const files = Array.from({ length: 50 }, (_, index) => ({
    ...result().files[0], path: `f${index}.txt`,
    matches: [{ ...result().files[0].matches[0], range: {
      start: { line: index, character: 0 }, end: { line: index, character: 6 },
    } }],
  }));
  mocks.call.mockImplementation((method, params) => method === 'files.search'
    ? Promise.resolve({ ...result(), count: 50, files }) : rpc(method, params));
  const value = panel();
  await searched(value);
  expect(value.wrapper.findAll('.search-match').length).toBeLessThan(50);
  await value.wrapper.get('input[aria-label="选择替换 f0.txt"]').setValue(false);
  await value.wrapper.findAll('.search-file-toggle')[0].trigger('click');
  expect(value.wrapper.find('.search-match[title="f0.txt:1:1"]').exists()).toBe(false);

  const viewport = value.wrapper.get('.search-results');
  (viewport.element as HTMLElement).scrollTop = 32 * 70;
  await viewport.trigger('scroll');
  await value.wrapper.findAll('.search-match')[0].trigger('click');
  expect(value.wrapper.emitted('open')?.[0]).toEqual(['f31.txt', files[31].matches[0].range, 'first']);
  await value.replaceButton().trigger('click');
  await flushPromises();
  const preview = mocks.call.mock.calls.find(([method]) => method === 'files.replacePreview')!;
  expect(preview[1].files.map((file: { path: string }) => file.path)).toEqual(files.slice(1).map(file => file.path));
});

test('替换固定点击时的查询、替换文本与勾选文件，等待同步时的输入不会改变操作', async () => {
  const value = panel(); await searched(value);
  const sync = deferred<void>(); value.flush.mockReturnValueOnce(sync.promise);
  await value.replaceButton().trigger('click');
  await value.wrapper.get('input[aria-label="项目搜索内容"]').setValue('later-query');
  await value.wrapper.get('input[aria-label="替换内容"]').setValue('later-replacement');
  await value.wrapper.get('input[aria-label="选择替换 a.txt"]').setValue(false);
  sync.resolve(); await flushPromises();
  expect(mocks.call).toHaveBeenCalledWith('files.replacePreview', expect.objectContaining({ workspaceId: 'first',
    options: expect.objectContaining({ query: 'needle' }), replacement: 'replacement', files: [{ path: 'a.txt', hash: 'original-hash' }] }));
  expect(value.apply).toHaveBeenCalledWith('first', [{ path: 'a.txt', before: 'needle', after: 'replacement' }]);
});

test('同步期间切换项目并完成新搜索，旧替换不会再请求新结果中的文件', async () => {
  const value = panel(); await searched(value);
  const sync = deferred<void>(); value.flush.mockReturnValueOnce(sync.promise);
  await value.replaceButton().trigger('click');
  await value.wrapper.setProps({ workspaceId: 'second' });
  await value.wrapper.get('form').trigger('submit'); await flushPromises();
  sync.resolve(); await flushPromises();
  expect(mocks.call.mock.calls.filter(([method]) => method === 'files.replacePreview')).toEqual([]);
  expect(value.apply).not.toHaveBeenCalled();
});

test.each(['save', 'undo'] as const)('切换项目后的旧 %s 结果不覆盖新搜索的忙碌状态和提示', async action => {
  const value = panel(); await searched(value);
  await value.replaceButton().trigger('click'); await flushPromises();
  const old = deferred<void>();
  if (action === 'save') value.saveAll.mockReturnValueOnce(old.promise);
  else value.history.undo.mockReturnValueOnce(old.promise);
  await value.wrapper.findAll('.search-batch button')[action === 'save' ? 2 : 0].trigger('click');
  await value.wrapper.setProps({ workspaceId: 'second' });
  const searching = deferred<ReturnType<typeof result>>();
  mocks.call.mockImplementation((method, params) => method === 'files.search' ? searching.promise : rpc(method, params));
  await value.wrapper.get('form').trigger('submit'); await flushPromises();
  if (action === 'save') old.resolve(); else old.reject(new Error('旧操作失败'));
  await flushPromises();
  expect(value.wrapper.find('.search-error').exists()).toBe(false);
  expect(value.wrapper.text()).not.toContain('已保存打开文件的修改');
  expect(value.wrapper.get('[role="status"]').text()).toBe('正在处理…');
  searching.resolve(result()); await flushPromises();
});
