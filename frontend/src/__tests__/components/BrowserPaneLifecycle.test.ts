import { mount, flushPromises } from '@vue/test-utils';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import BrowserPane from '../../../../apps/client/src/components/BrowserPane.vue';

const mocks = vi.hoisted(() => ({ call: vi.fn(), errors: vi.fn(), notify: undefined as ((event: any) => void) | undefined }));
vi.mock('../../../../apps/client/src/api', () => ({ rpc: mocks.call, subscribe: (listener: typeof mocks.notify) => { mocks.notify = listener; return () => { mocks.notify = undefined; }; } }));
vi.mock('../../../../apps/client/src/state', () => ({ state: {}, guard: (action: () => Promise<unknown>) => action().catch(mocks.errors) }));
let wrapper: ReturnType<typeof mount> | undefined;
beforeEach(() => {
  mocks.call.mockReset(); mocks.errors.mockReset();
  window.graycode = { kind: 'desktop', call: mocks.call, subscribe: () => () => {} };
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1)); vi.stubGlobal('cancelAnimationFrame', vi.fn());
});
afterEach(() => { wrapper?.unmount(); wrapper = undefined; vi.unstubAllGlobals(); });

test('卸载浏览器面板后丢弃迟到结果并取消事件合并的补读', async () => {
  let finish!: (value: unknown) => void;
  mocks.call.mockImplementation(async method => method === 'browser.state' ? new Promise(resolve => { finish = resolve; }) : {});
  wrapper = mount(BrowserPane, { props: { active: true } }); await flushPromises();
  mocks.notify?.({ type: 'browser.changed' });
  wrapper.unmount(); wrapper = undefined;
  finish({ tabs: [], profiles: [] }); await flushPromises();
  expect(mocks.call.mock.calls.filter(([method]) => method === 'browser.state')).toHaveLength(1);
  expect(mocks.call).toHaveBeenCalledWith('browser.layout', expect.objectContaining({ visible: false }));
  expect(mocks.errors).not.toHaveBeenCalled();
});

test('卸载后的状态和隐藏请求失败不再通知已关闭面板', async () => {
  let fail!: (error: Error) => void;
  mocks.call.mockImplementation(async method => method === 'browser.state' ? new Promise((_resolve, reject) => { fail = reject; }) : Promise.reject(new Error('host closed')));
  wrapper = mount(BrowserPane, { props: { active: true } }); await flushPromises();
  wrapper.unmount(); wrapper = undefined; fail(new Error('host closed')); await flushPromises();
  expect(mocks.errors).not.toHaveBeenCalled();
});


test('切换到相同网址的另一标签时丢弃地址草稿，迟到选择回执不改回旧网址', async () => {
  const tabs = [{ id: 'a', title: 'A', url: 'https://same.example' }, { id: 'b', title: 'B', url: 'https://same.example' }];
  let activeTabId = 'a'; let first!: () => void;
  mocks.call.mockImplementation(async (method, params) => {
    if (method === 'browser.state') return { tabs, profiles: [], activeTabId };
    if (method === 'browser.select') { activeTabId = params.tabId; if (params.tabId === 'a') return new Promise<void>(resolve => { first = resolve; }); }
    return {};
  });
  wrapper = mount(BrowserPane, { props: { active: true } }); await flushPromises();
  await wrapper.get('input[aria-label="网页地址"]').setValue('unfinished address');
  await wrapper.findAll('[role="tab"]')[1].trigger('click'); await flushPromises();
  expect((wrapper.get('input[aria-label="网页地址"]').element as HTMLInputElement).value).toBe('https://same.example');
  await wrapper.findAll('[role="tab"]')[0].trigger('click');
  tabs[1].url = 'https://latest.example';
  await wrapper.findAll('[role="tab"]')[1].trigger('click'); await flushPromises();
  first(); await flushPromises();
  expect((wrapper.get('input[aria-label="网页地址"]').element as HTMLInputElement).value).toBe('https://latest.example');
});

test('布局提交失败后，同样的布局仍能在下一次调整时重试', async () => {
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
  let fail = true;
  mocks.call.mockImplementation(async method => {
    if (method === 'browser.state') return { tabs: [{ id: 'a', url: 'https://example.com' }], profiles: [], activeTabId: 'a' };
    if (method === 'browser.layout' && fail) { fail = false; throw new Error('temporary disconnect'); }
    return {};
  });
  wrapper = mount(BrowserPane, { props: { active: true } }); await flushPromises();
  frames.splice(0).at(-1)?.(0); await flushPromises();
  window.dispatchEvent(new Event('resize')); frames.splice(0).at(-1)?.(0); await flushPromises();
  expect(mocks.call.mock.calls.filter(([method]) => method === 'browser.layout')).toHaveLength(2);
});
