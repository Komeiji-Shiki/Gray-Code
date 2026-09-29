import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import DesktopUpdateSettings from '../../components/settings/panel/DesktopUpdateSettings.vue';
import { sendToExtension } from '../../utils/vscode';
vi.mock('../../utils/vscode', () => ({ sendToExtension: vi.fn() }));
const call = vi.mocked(sendToExtension);
const initial = { kind: 'installed', currentVersion: '2.0.0', busy: false };
let wrapper: ReturnType<typeof mount> | undefined;
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
beforeEach(() => { vi.useFakeTimers(); call.mockReset(); call.mockResolvedValue(initial); Object.defineProperty(document, 'hidden', { configurable: true, value: false }); });
afterEach(() => { wrapper?.unmount(); wrapper=undefined; vi.useRealTimers(); });
const statusCalls = () => call.mock.calls.filter(([method]) => method === 'desktop.updates.status').length;

test('卸载中的状态请求或更新操作结束后，不继续轮询或补读', async () => {
  const pending = deferred<any>(); call.mockReturnValue(pending.promise);
  wrapper = mount(DesktopUpdateSettings); expect(statusCalls()).toBe(1);
  wrapper.unmount(); wrapper = undefined; pending.resolve({ ...initial, busy: true }); await flushPromises();
  await vi.advanceTimersByTimeAsync(5000); expect(statusCalls()).toBe(1);
  call.mockResolvedValue(initial); wrapper=mount(DesktopUpdateSettings); await flushPromises();
  const action = deferred<any>(); call.mockImplementation(method => method === 'updateNow' ? action.promise : Promise.resolve(initial));
  await wrapper.findAll('button').find(button=>button.text()==='下载更新')!.trigger('click');await flushPromises();
  wrapper.unmount();wrapper=undefined;const count=statusCalls();action.resolve({downloaded:true,version:'2.1.0'});await flushPromises();
  await vi.advanceTimersByTimeAsync(5000);expect(statusCalls()).toBe(count);
});

test('更新结束时等待旧快照，然后补读真实完成态；没有重复轮询链', async () => {
  wrapper=mount(DesktopUpdateSettings);await flushPromises();
  const stale=deferred<any>(), action=deferred<any>();let completed=false;
  call.mockImplementation(method => method==='updateNow' ? action.promise : completed ? Promise.resolve({...initial,ready:{version:'2.1.0'}}) : stale.promise);
  await wrapper.findAll('button').find(button=>button.text()==='下载更新')!.trigger('click');
  document.dispatchEvent(new Event('visibilitychange'));document.dispatchEvent(new Event('visibilitychange'));
  await vi.advanceTimersByTimeAsync(2500);expect(statusCalls()).toBe(2);
  completed=true;action.resolve({downloaded:true,version:'2.1.0'});await flushPromises();
  stale.resolve({...initial,busy:true});await flushPromises();
  expect(statusCalls()).toBe(3);expect(wrapper.get('.ready').text()).toContain('2.1.0');
  await vi.advanceTimersByTimeAsync(5000);expect(statusCalls()).toBe(3);
});

test('真实进度有界，未知进度保持不定态；后台窗口暂停轮询', async () => {
  call.mockResolvedValue({...initial,busy:true,progress:{phase:'downloading',percent:170}});
  wrapper=mount(DesktopUpdateSettings);await flushPromises();
  expect(wrapper.get('progress').attributes('value')).toBe('100');
  Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));
  const count=statusCalls();await vi.advanceTimersByTimeAsync(5000);expect(statusCalls()).toBe(count);
  call.mockResolvedValue({...initial,busy:true,progress:{phase:'backup'}});
  Object.defineProperty(document,'hidden',{configurable:true,value:false});document.dispatchEvent(new Event('visibilitychange'));await flushPromises();
  expect(wrapper.get('progress').attributes('value')).toBeUndefined();expect(wrapper.text()).toContain('正在备份当前数据');
});

test('下载期间发行页面仍可访问，重复下载不会再发请求',async()=>{
  wrapper=mount(DesktopUpdateSettings);await flushPromises();const pending=deferred<any>();
  call.mockImplementation(method=>method==='updateNow'?pending.promise:Promise.resolve(initial));
  const download=wrapper.findAll('button').find(button=>button.text()==='下载更新')!;await download.trigger('click');await download.trigger('click');
  await wrapper.findAll('button').find(button=>button.text()==='打开发行页面')!.trigger('click');
  expect(call.mock.calls.filter(([method])=>method==='updateNow')).toHaveLength(1);expect(call).toHaveBeenCalledWith('openUpdatePage',{});
  pending.resolve({cancelled:true});await flushPromises();
});
