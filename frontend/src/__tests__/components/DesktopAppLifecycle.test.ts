import { shallowMount, flushPromises } from '@vue/test-utils';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ref } from 'vue';
import App from '../../../../apps/client/src/App.vue';
import { state } from '../../../../apps/client/src/state';

const mocks = vi.hoisted(() => ({ call: vi.fn(), report: vi.fn(), initialize: vi.fn(), listener: undefined as ((event: any) => void) | undefined, unsubscribe: vi.fn() }));
vi.mock('../../../../apps/client/src/api', () => ({ call: mocks.call, subscribe: (listener: typeof mocks.listener) => { mocks.listener = listener; return mocks.unsubscribe; } }));
vi.mock('../../../../apps/client/src/state', async () => {
  const { reactive, ref } = await import('vue');
  return { state: reactive({ ready: false, mode: 'chat', chatFocused: false, settingsOpen: false, workspaceId: 'project', conversationId: 'conversation', snapshot: { settings: { workspaces: [] } } }),
    appearance: ref(undefined), initialize: mocks.initialize, loadSettings: vi.fn(), report: mocks.report,
    guard: (action: () => Promise<unknown>) => action().catch(mocks.report) };
});
vi.mock('../../../../apps/client/src/appearance', () => ({ appearancePalette: ref({}), resolvedTheme: ref('dark'), useSystemAppearance() {} }));
vi.mock('../../../../apps/client/src/webBridge', () => ({ webUi: { connection: 'connected' } }));
vi.mock('../../../../apps/client/src/components/Workbench.vue', () => ({ default: { template: '<div />' } }));
vi.mock('../../../../apps/client/src/components/ErrorBanner.vue', () => ({ default: { template: '<div />' } }));
vi.mock('../../../../apps/client/src/components/ContentPreview.vue', () => ({ default: { template: '<div />' } }));
vi.mock('../../../../apps/client/src/components/RunInspector.vue', () => ({ default: { template: '<div />' } }));
vi.mock('../../../../apps/client/src/components/AutomationsPanel.vue', () => ({ default: { template: '<div />' } }));
vi.mock('../../../../apps/client/src/components/ConversationSidebar.vue', () => ({ default: { template: '<div />' } }));
vi.mock('../../../../apps/client/src/components/WorkspaceSelector.vue', () => ({ default: { template: '<div />' } }));
vi.mock('../../../../apps/client/src/components/WebDialogs.vue', () => ({ default: { template: '<div />' } }));
vi.mock('../../../../apps/client/src/components/ComputerStatus.vue', () => ({ default: { template: '<div />' } }));
vi.mock('../../../../apps/client/src/components/PetSurface.vue', () => ({ default: { template: '<div />' } }));
vi.mock('../../../../apps/client/src/components/ScreenSenseStatus.vue', () => ({ default: { template: '<div />' } }));
let wrapper: ReturnType<typeof shallowMount> | undefined;
beforeEach(() => {
  mocks.call.mockReset().mockResolvedValue({}); mocks.initialize.mockReset(); mocks.report.mockReset(); mocks.unsubscribe.mockReset(); mocks.listener = undefined;
  Object.assign(state, { ready: false, mode: 'chat', chatFocused: false, settingsOpen: false, workspaceId: 'project' });
  localStorage.clear();
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  mocks.initialize.mockImplementation(async () => { state.ready = true; mocks.listener?.({ type: 'ui.ready' }); });
});
afterEach(() => { wrapper?.unmount(); wrapper = undefined; localStorage.clear(); vi.unstubAllGlobals(); });

test('初始化期间发出的聊天就绪事件仍可解除侧栏禁用', async () => {
  wrapper = shallowMount(App); await flushPromises();
  expect(wrapper.get('.conversation-navigation').attributes('aria-busy')).toBe('false');
  expect(wrapper.get('.conversation-navigation').attributes('inert')).toBeUndefined();
  expect(mocks.call).toHaveBeenCalledWith('desktop.files.ready');
});

test('初始化未完成就卸载，不再建立宿主上下文或读取待打开文件', async () => {
  let finish!: () => void;
  mocks.initialize.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
  wrapper = shallowMount(App); wrapper.unmount(); wrapper = undefined;
  finish(); await flushPromises();
  expect(mocks.unsubscribe).toHaveBeenCalledTimes(1);
  expect(mocks.call).not.toHaveBeenCalledWith('desktop.files.ready');
  expect(mocks.call).not.toHaveBeenCalledWith('ui.context.set', expect.anything());
});

test('损坏的分栏设置恢复默认值，重复点击模式只发起一次切换', async () => {
  localStorage.setItem('graycode.chatWidth', 'Infinity');
  wrapper = shallowMount(App); await flushPromises();
  expect(wrapper.get('.desktop-workspace').attributes('style')).toContain('--chat-width: 48%');
  let finish!: (result: unknown) => void;
  mocks.call.mockImplementation(async method => method === 'ui.request' ? new Promise(resolve => { finish = resolve; }) : {});
  await wrapper.get('.mode-trigger').trigger('click');
  const code = wrapper.findAll('.mode-menu button')[1];
  await code.trigger('click'); await code.trigger('click');
  expect(mocks.call.mock.calls.filter(([method]) => method === 'ui.request')).toHaveLength(1);
  finish({ workspaceId: 'project' }); await flushPromises();
  expect(state.mode).toBe('code');
  expect(wrapper.find('.mode-menu').exists()).toBe(false);
});

test('打开设置失败时由现有错误提示处理，没有悬空的拒绝', async () => {
  wrapper = shallowMount(App); await flushPromises();
  mocks.call.mockRejectedValue(new Error('settings unavailable'));
  mocks.listener?.({ type: 'settings.open' }); await flushPromises();
  expect(mocks.report).toHaveBeenCalledWith(expect.objectContaining({ message: 'settings unavailable' }));
});
