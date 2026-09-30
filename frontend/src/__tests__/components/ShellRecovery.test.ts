import { shallowMount, flushPromises } from '@vue/test-utils';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import App from '../../../../apps/client/src/App.vue';
import { state } from '../../../../apps/client/src/state';
import { CHAT_INITIALIZATION_MESSAGE } from '../../../../shared/chatInitialization';

const mocks = vi.hoisted(() => ({ call: vi.fn(), initialize: vi.fn(), report: vi.fn(), listeners: new Set<(event: any) => void>() }));
vi.mock('../../../../apps/client/src/api', () => ({ call: mocks.call, rpc: mocks.call,
  subscribe: (listener: (event: any) => void) => { mocks.listeners.add(listener); return () => mocks.listeners.delete(listener); } }));
vi.mock('../../../../apps/client/src/state', async () => {
  const { reactive, computed } = await import('vue');
  const state = reactive({ ready: false, initializing: false, initializationError: '', error: '', notice: null, workspaceId: '', mode: 'chat', snapshot: null,
    chatFocused: true, settingsOpen: false, navigationDialogOpen: false, fileDialogOpen: false, panelMenuOpen: false });
  return { state, appearance: computed(() => null), initialize: mocks.initialize, loadSettings: vi.fn(), report: mocks.report,
    guard: async (operation: () => Promise<unknown>) => { try { return await operation(); } catch (error) { mocks.report(error); } } };
});
vi.mock('../../../../apps/client/src/appearance', async () => {
  const { ref } = await import('vue'); return { appearancePalette: ref({}), resolvedTheme: ref('dark'), useSystemAppearance() {} };
});
vi.mock('../../../../apps/client/src/webBridge', () => ({ webUi: { connection: 'connected' } }));
vi.mock('../../../../apps/client/src/components/PetSurface.vue', () => ({ default: { name: 'PetSurface', template: '<div />' } }));
const wrappers: ReturnType<typeof shallowMount>[] = [];
beforeEach(() => {
  vi.useFakeTimers(); mocks.listeners.clear(); mocks.call.mockReset().mockResolvedValue(undefined);
  mocks.report.mockReset().mockImplementation(error => { state.error = error instanceof Error ? error.message : String(error); });
  Object.assign(state, { ready: false, initializing: false, initializationError: '', error: '', notice: null, workspaceId: '', mode: 'code', snapshot: null, chatFocused: true, settingsOpen: false });
  mocks.initialize.mockReset().mockImplementation(async () => { state.initializationError = ''; state.ready = true; return () => {}; });
  Object.defineProperty(window, 'graycode', { configurable: true, value: { kind: 'web' } });
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
});
afterEach(() => { wrappers.splice(0).forEach(wrapper => wrapper.unmount()); mocks.listeners.clear(); vi.useRealTimers(); document.body.innerHTML = ''; });
function shell() { const wrapper = shallowMount(App, { attachTo: document.body }); wrappers.push(wrapper); return wrapper; }

test('启动读取失败显示原因与重试入口，重试成功进入工作台且不叠加宿主订阅', async () => {
  mocks.initialize.mockRejectedValueOnce(new Error('host unavailable'));
  const wrapper = shell(); await flushPromises();
  expect(wrapper.get('.startup-error').text()).toContain('host unavailable');
  expect(wrapper.find('iframe.product-chat').exists()).toBe(false);
  await wrapper.get('.startup-error button').trigger('click'); await flushPromises();
  expect(mocks.initialize).toHaveBeenCalledTimes(2); expect(mocks.listeners.size).toBe(1);
  expect(state.error).toBe('');
  expect(wrapper.find('.startup-error').exists()).toBe(false); expect(wrapper.find('iframe.product-chat').exists()).toBe(true);
});

test('聊天就绪回执超时后出现恢复入口，显式重载仅更换聊天iframe并等新回执', async () => {
  const wrapper = shell(); await flushPromises();
  const original = wrapper.get('iframe.product-chat').element;
  for (const listener of mocks.listeners) listener({ type: 'ui.ready' });
  await vi.advanceTimersByTimeAsync(20_001); await flushPromises();
  const banner = wrapper.get('.notice-banner[role="alert"]'); expect(banner.text()).toBeTruthy();
  await banner.get('button').trigger('click'); await flushPromises();
  expect(wrapper.get('iframe.product-chat').element).not.toBe(original); expect(mocks.initialize).toHaveBeenCalledTimes(1);
  expect(wrapper.find('.notice-banner[role="alert"]').exists()).toBe(false);
  for (const listener of mocks.listeners) listener({ type: 'ui.ready' });
  window.dispatchEvent(new MessageEvent('message', { source: wrapper.get<HTMLIFrameElement>('iframe.product-chat').element.contentWindow!,
    origin: window.location.origin, data: { type: CHAT_INITIALIZATION_MESSAGE, status: 'ready' } }));
  await vi.advanceTimersByTimeAsync(20_001); await flushPromises();
  expect(wrapper.find('.notice-banner[role="alert"]').exists()).toBe(false);
  expect(wrapper.get('.conversation-navigation').attributes('inert')).toBeUndefined();
});

test('聊天初始化失败立即显示原因，旧 iframe 的就绪消息不能清除新页面失败', async () => {
  const wrapper = shell(); await flushPromises();
  const original = wrapper.get<HTMLIFrameElement>('iframe.product-chat').element.contentWindow!;
  const notify = (source: Window, status: string, error?: string) => window.dispatchEvent(new MessageEvent('message', {
    source, origin: window.location.origin, data: { type: CHAT_INITIALIZATION_MESSAGE, status, error },
  }));
  notify(original, 'failed', 'history unavailable'); await flushPromises();
  expect(wrapper.get('.notice-banner[role="alert"]').text()).toContain('history unavailable');
  await wrapper.get('.notice-banner[role="alert"] button').trigger('click'); await flushPromises();
  notify(wrapper.get<HTMLIFrameElement>('iframe.product-chat').element.contentWindow!, 'failed', 'retry failed');
  notify(original, 'ready'); await flushPromises();
  expect(wrapper.get('.notice-banner[role="alert"]').text()).toContain('retry failed');
});

test('iframe加载失败可立即恢复，卸载后不处理迟到的聊天或连接事件', async () => {
  const wrapper = shell(); await flushPromises();
  await wrapper.get('iframe.product-chat').trigger('error'); expect(wrapper.find('.notice-banner[role="alert"]').exists()).toBe(true);
  const callbacks = [...mocks.listeners]; wrapper.unmount();
  for (const listener of callbacks) listener({ type: 'transport.resumed' });
  expect(mocks.initialize).toHaveBeenCalledTimes(1); expect(mocks.listeners.size).toBe(0);
});

test('模式菜单打开聚焦当前模式，方向键与Tab循环，Escape返回触发按钮', async () => {
  const wrapper = shell(); await flushPromises();
  const trigger = wrapper.get('.mode-trigger'); await trigger.trigger('click'); await flushPromises();
  const menu = wrapper.get('.mode-menu'), items = menu.findAll('button');
  expect(document.activeElement).toBe(items[1].element);
  await items[1].trigger('keydown', { key: 'End' }); expect(document.activeElement).toBe(items[2].element);
  await items[2].trigger('keydown', { key: 'Tab' }); expect(document.activeElement).toBe(items[0].element);
  await items[0].trigger('keydown', { key: 'Escape' }); await flushPromises();
  expect(wrapper.find('.mode-menu').exists()).toBe(false); expect(document.activeElement).toBe(trigger.element);
});

test('聊天宿主重复加载后只保留当前订阅，pagehide 释放父页面回调', async () => {
  const { ref } = await import('vue');
  const previousHost = window.__GRAYCODE_HOST;
  vi.doMock('../../i18n', () => ({ actualLanguage: ref('zh-CN') }));
  vi.doMock('../../platform/appearance', () => ({ applyDesktopAppearance() {} }));
  vi.doMock('../../components/common/markdown/markdownItCore', () => ({ invalidateWorkspaceAssets() {} }));
  vi.doMock('../../platform/settingsDraft', () => ({ desktopSettingsDraft: {}, saveDesktopSettings: vi.fn(),
    trackPreferenceRequest: (_type: string, _data: unknown, request: Promise<unknown>) => request }));
  vi.doMock('../../main', () => ({}));
  const listeners = new Set<(event: any) => void>();
  Object.defineProperty(window, 'graycode', { configurable: true, value: { kind: 'web',
    call: async (method: string, params?: any) => method === 'ui.state.get' ? {} : params?.type === 'getPromptModes' ? { currentModeId: 'code' } : {},
    subscribe: (listener: (event: any) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
  } });
  try {
    for (let round = 0; round < 2; round++) {
      vi.resetModules(); await import('../../platform/main');
      expect(listeners.size).toBe(1);
      const receive = [...listeners][0], delivered = vi.fn();
      window.__GRAYCODE_HOST!.subscribe!(delivered);
      window.dispatchEvent(new Event('pagehide'));
      expect(listeners.size).toBe(0);
      receive({ type: 'remote.changed' }); expect(delivered).not.toHaveBeenCalled();
    }
  } finally {
    window.dispatchEvent(new Event('pagehide')); window.__GRAYCODE_HOST = previousHost;
    vi.doUnmock('../../i18n'); vi.doUnmock('../../platform/appearance'); vi.doUnmock('../../components/common/markdown/markdownItCore');
    vi.doUnmock('../../platform/settingsDraft'); vi.doUnmock('../../main'); vi.resetModules();
  }
});
