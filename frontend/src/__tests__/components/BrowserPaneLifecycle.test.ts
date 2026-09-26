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
