import { mount, flushPromises } from '@vue/test-utils';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import ScreenSenseSettings from '../../../../apps/client/src/components/ScreenSenseSettings.vue';
const { call } = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../../../../apps/client/src/api', () => ({ call, subscribe: () => () => {} }));
const wrappers: ReturnType<typeof mount>[] = [];
beforeEach(() => { call.mockReset(); HTMLDialogElement.prototype.showModal = vi.fn(); });
afterEach(() => wrappers.splice(0).forEach(wrapper => wrapper.unmount()));
test('初始读取期间卸载，不再请求选项或重复读取', async () => {
  let complete!: (value: unknown) => void;
  call.mockReturnValue(new Promise(resolve => { complete = resolve; }));
  const wrapper = mount(ScreenSenseSettings); wrapper.unmount();
  complete({ status: {} }); await flushPromises();
  expect(call.mock.calls.map(args => args[0])).toEqual(['screenSense.get']);
});
test('慢采集期间仍可立即停止，卸载后的采集结果不再补读', async () => {
  let capture!: () => void;
  call.mockImplementation(async method => {
    if (method === 'screenSense.get') return { history: [], status: { active: true, captures: 0, maxCaptures: 3 } };
    if (method === 'screenSense.options') return { targets: { windows: [], displays: [] }, providers: [], conversations: [] };
    if (method === 'screenSense.capture') return new Promise<void>(resolve => { capture = resolve; });
  });
  const wrapper = mount(ScreenSenseSettings); await flushPromises();
  const button = (label: string) => wrapper.findAll('button').find(item => item.text() === label)!;
  await button('立即采集一次').trigger('click'); await button('立即停止采集').trigger('click');
  await flushPromises(); expect(call).toHaveBeenCalledWith('screenSense.stop');
  wrapper.unmount(); const count = call.mock.calls.length;
  capture(); await flushPromises(); expect(call).toHaveBeenCalledTimes(count);
});
