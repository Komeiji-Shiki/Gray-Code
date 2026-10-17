import { shallowMount, flushPromises } from '@vue/test-utils';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import App from '../../../../apps/client/src/App.vue';
import { state } from '../../../../apps/client/src/state';
import { CHAT_INITIALIZATION_MESSAGE } from '../../../../shared/chatInitialization';
import { SHELL_SHORTCUT_MESSAGE } from '../../../../shared/shellShortcutBridge';
import WorkspaceSelector from '../../../../apps/client/src/components/WorkspaceSelector.vue';

const mocks = vi.hoisted(() => ({ call: vi.fn(), initialize: vi.fn(), report: vi.fn(), viewSequence: 0, listeners: new Set<(event: any) => void>() }));
vi.mock('../../../../apps/client/src/api', () => ({ call: mocks.call, rpc: mocks.call,
  uiRequest: (type: string, data?: unknown) => mocks.call('ui.request', { type, data: data ?? {} }),
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
// 调试订阅由渲染器单例维护，这里只检查外壳重试自身的订阅生命周期。
vi.mock('../../../../apps/client/src/debugging', () => ({ connectDebugging: vi.fn(), debugControl: vi.fn(),
  debugState: { activeId: undefined, sessions: [] } }));
vi.mock('../../../../apps/client/src/components/PetSurface.vue', () => ({ default: { name: 'PetSurface', template: '<div />' } }));
const wrappers: ReturnType<typeof shallowMount>[] = [];
beforeEach(() => {
  vi.useFakeTimers(); mocks.listeners.clear(); mocks.viewSequence = 0;
  mocks.call.mockReset().mockImplementation(async (method: string) => method === 'ui.view.prepare' ? preparedView() : undefined);
  mocks.report.mockReset().mockImplementation(error => { state.error = error instanceof Error ? error.message : String(error); });
  Object.assign(state, { ready: false, initializing: false, initializationError: '', error: '', notice: null, workspaceId: '', mode: 'code', snapshot: null, chatFocused: true, settingsOpen: false });
  mocks.initialize.mockReset().mockImplementation(async () => { state.initializationError = ''; state.ready = true; return () => {}; });
  Object.defineProperty(window, 'graycode', { configurable: true, value: { kind: 'web' } });
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
});
afterEach(() => { wrappers.splice(0).forEach(wrapper => wrapper.unmount()); mocks.listeners.clear(); vi.useRealTimers(); document.body.innerHTML = ''; });
function shell() { const wrapper = shallowMount(App, { attachTo: document.body }); wrappers.push(wrapper); return wrapper; }
function preparedView() { return { accepted: true, viewId: `main-view-${++mocks.viewSequence}` }; }
function currentView(wrapper: ReturnType<typeof shallowMount>) {
  const viewId = new URL(wrapper.get<HTMLIFrameElement>('iframe.product-chat').element.src).searchParams.get('viewId');
  if (!viewId) throw new Error('聊天 iframe 缺少主视图身份');
  return viewId;
}
function ready(wrapper: ReturnType<typeof shallowMount>) {
  for (const listener of mocks.listeners) listener({ type: 'ui.ready', viewId: currentView(wrapper) });
}

test('外壳先登记主聊天身份，再挂载对应 iframe', async () => {
  let finish!: (value: { accepted: boolean; viewId: string }) => void;
  const preparation = new Promise<{ accepted: boolean; viewId: string }>(resolve => { finish = resolve; });
  mocks.call.mockImplementation((method: string) => method === 'ui.view.prepare' ? preparation : Promise.resolve({}));
  const wrapper = shell(); await flushPromises();
  try {
    expect(wrapper.find('iframe.product-chat').exists()).toBe(false);
    expect(mocks.call).toHaveBeenCalledWith('ui.view.prepare');
  } finally { finish({ accepted: true, viewId: 'prepared-main-view' }); await flushPromises(); }
  expect(wrapper.get('iframe.product-chat').attributes('src')).toContain('viewId=prepared-main-view');
});

test('重载后的旧 ui.ready 不能提前启用新聊天入口', async () => {
  const wrapper = shell(); await flushPromises();
  const oldFrame = wrapper.get<HTMLIFrameElement>('iframe.product-chat');
  const oldViewId = currentView(wrapper);
  for (const listener of mocks.listeners) listener({ type: 'ui.ready', viewId: oldViewId });
  await oldFrame.trigger('error');
  await wrapper.get('.notice-banner[role="alert"] button').trigger('click'); await flushPromises();
  for (const listener of mocks.listeners) listener({ type: 'ui.ready', viewId: oldViewId });
  await flushPromises();
  expect(wrapper.get('.conversation-navigation').attributes('inert')).toBeDefined();
});

test.each(['外壳快捷键', '聊天内快捷键', '宿主快捷键', '项目选择', '添加项目', '模式选择'])(
  '%s 在聊天订阅就绪后启用，重载期间重新等待', async action => {
    mocks.call.mockImplementation(async (method: string, params?: { type?: string }) => {
      if (method === 'ui.view.prepare') return preparedView();
      if (method === 'ui.request' && params?.type === 'conversation.navigation') {
        return { items: [{ id: 'project-conversation', workspaceId: 'project', updatedAt: 1 }], pinned: [] };
      }
      if (method === 'desktop.chooseWorkspace') return null;
      return {};
    });
    const wrapper = shell(); await flushPromises();
    const attempt = async () => {
      if (action === '外壳快捷键') window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', ctrlKey: true }));
      else if (action === '聊天内快捷键') window.dispatchEvent(new MessageEvent('message', {
        source: wrapper.get<HTMLIFrameElement>('iframe.product-chat').element.contentWindow!, origin: window.location.origin,
        data: { type: SHELL_SHORTCUT_MESSAGE, command: 'newConversation' },
      }));
      else if (action === '宿主快捷键') {
        for (const listener of mocks.listeners) listener({ type: 'desktop.shortcut', command: 'newConversation' });
      } else if (action === '项目选择') wrapper.getComponent(WorkspaceSelector).vm.$emit('update:modelValue', 'project');
      else if (action === '添加项目') await wrapper.get('.workspace-add').trigger('click');
      else {
        await wrapper.get('.mode-trigger').trigger('click');
        const choice = wrapper.find('.mode-menu [role="menuitemradio"]');
        if (choice.exists()) await choice.trigger('click');
      }
      await flushPromises();
    };
    for (let round = 0; round < 2; round++) {
      mocks.call.mockClear();
      await attempt();
      expect(mocks.call).not.toHaveBeenCalled();
      ready(wrapper);
      await flushPromises();
      await attempt();
      if (action === '项目选择') {
        expect(mocks.call).toHaveBeenCalledWith('ui.command', {
          command: 'platform.openModeConversation', data: { conversationId: 'project-conversation' },
        });
      } else if (action === '添加项目') expect(mocks.call).toHaveBeenCalledWith('desktop.chooseWorkspace');
      else if (action === '模式选择') expect(mocks.call).toHaveBeenCalledWith('ui.request', expect.objectContaining({ type: 'ui.mode.select' }));
      else expect(mocks.call).toHaveBeenCalledWith('ui.command', { command: 'newChat', data: undefined });
      if (round === 0) {
        await wrapper.get('iframe.product-chat').trigger('error');
        await wrapper.get('.notice-banner[role="alert"] button').trigger('click');
        await flushPromises();
      }
    }
  },
);

test.each(['宿主目录事件', '已受理的目录选择'])('%s 继续完成项目导航，不再经过新操作门禁', async action => {
  let chooseWorkspace!: (value: { directory: string; name: string }) => void;
  const selection = new Promise<{ directory: string; name: string }>(resolve => { chooseWorkspace = resolve; });
  mocks.call.mockImplementation(async (method: string, params?: { type?: string }) => {
    if (method === 'ui.view.prepare') return preparedView();
    if (method === 'desktop.chooseWorkspace') return selection;
    if (method === 'workspaces.add') return { id: 'project' };
    if (method === 'ui.request' && params?.type === 'conversation.navigation') {
      return { items: [{ id: 'project-conversation', workspaceId: 'project', updatedAt: 1 }], pinned: [] };
    }
    return {};
  });
  const wrapper = shell(); await flushPromises();
  mocks.call.mockClear();
  if (action === '宿主目录事件') {
    for (const listener of mocks.listeners) listener({ type: 'workspace.selected', source: 'desktop', workspaceId: 'project' });
  } else {
    ready(wrapper);
    await flushPromises();
    await wrapper.get('.workspace-add').trigger('click');
    expect(mocks.call).toHaveBeenCalledWith('desktop.chooseWorkspace');
    await wrapper.get('iframe.product-chat').trigger('error');
    await wrapper.get('.notice-banner[role="alert"] button').trigger('click');
    chooseWorkspace({ directory: 'selected-project-directory', name: '项目' });
  }
  await flushPromises();
  expect(mocks.call).toHaveBeenCalledWith('ui.command', {
    command: 'platform.openModeConversation', data: { conversationId: 'project-conversation' },
  });
});

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
  ready(wrapper);
  await vi.advanceTimersByTimeAsync(20_001); await flushPromises();
  const banner = wrapper.get('.notice-banner[role="alert"]'); expect(banner.text()).toBeTruthy();
  await banner.get('button').trigger('click'); await flushPromises();
  expect(wrapper.get('iframe.product-chat').element).not.toBe(original); expect(mocks.initialize).toHaveBeenCalledTimes(1);
  expect(wrapper.find('.notice-banner[role="alert"]').exists()).toBe(false);
  ready(wrapper);
  window.dispatchEvent(new MessageEvent('message', { source: wrapper.get<HTMLIFrameElement>('iframe.product-chat').element.contentWindow!,
    origin: window.location.origin, data: { type: CHAT_INITIALIZATION_MESSAGE, status: 'ready', viewId: currentView(wrapper) } }));
  await vi.advanceTimersByTimeAsync(20_001); await flushPromises();
  expect(wrapper.find('.notice-banner[role="alert"]').exists()).toBe(false);
  expect(wrapper.get('.conversation-navigation').attributes('inert')).toBeUndefined();
});

test('聊天初始化失败立即显示原因，旧 iframe 的就绪消息不能清除新页面失败', async () => {
  const wrapper = shell(); await flushPromises();
  const original = wrapper.get<HTMLIFrameElement>('iframe.product-chat').element.contentWindow!;
  const originalViewId = currentView(wrapper);
  const notify = (source: Window, status: string, error?: string) => window.dispatchEvent(new MessageEvent('message', {
    source, origin: window.location.origin,
    data: { type: CHAT_INITIALIZATION_MESSAGE, status, error, viewId: source === original ? originalViewId : currentView(wrapper) },
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
  ready(wrapper);
  await flushPromises();
  const trigger = wrapper.get('.mode-trigger'); await trigger.trigger('click'); await flushPromises();
  const menu = wrapper.get('.mode-menu'), items = menu.findAll('button');
  expect(document.activeElement).toBe(items[1].element);
  await items[1].trigger('keydown', { key: 'End' }); expect(document.activeElement).toBe(items[2].element);
  await items[2].trigger('keydown', { key: 'Tab' }); expect(document.activeElement).toBe(items[0].element);
  await items[0].trigger('keydown', { key: 'Escape' }); await flushPromises();
  expect(wrapper.find('.mode-menu').exists()).toBe(false); expect(document.activeElement).toBe(trigger.element);
});

test.each([
  { monitor: false, missingInitially: false },
  { monitor: false, missingInitially: true },
  { monitor: true, missingInitially: false },
])('聊天宿主按当前文档恢复命令握手并释放旧订阅：%j', async ({ monitor, missingInitially }) => {
  const previousHost = window.__GRAYCODE_HOST;
  const previousMode = window.__GRAYCODE_VIEW_MODE;
  const previousUrl = window.location.href;
  window.history.replaceState(null, '', monitor ? '?view=subagents' : '?viewId=current-main-view');
  vi.doMock('../../i18n', () => ({ getLanguage: () => 'zh-CN', setLanguage: vi.fn().mockResolvedValue(undefined),
    SUPPORTED_LANGUAGES: [{ value: 'zh-CN' }] }));
  vi.doMock('../../platform/appearance', () => ({ applyDesktopAppearance() {} }));
  vi.doMock('../../components/common/markdown/markdownItCore', () => ({ invalidateWorkspaceAssets() {} }));
  vi.doMock('../../platform/settingsDraft', () => ({ desktopSettingsDraft: {}, saveDesktopSettings: vi.fn(),
    trackPreferenceRequest: (_type: string, _data: unknown, request: Promise<unknown>) => request }));
  vi.doMock('../../main', () => ({}));
  const listeners = new Set<(event: any) => void>();
  let missingView = false;
  const bridgeCall = vi.fn(async (method: string, params?: { type?: string; data?: unknown; resumeViewId?: string }) => {
    if (method === 'ui.startup') return {
      state: {}, appearance: {}, settings: { success: true, settings: { ui: { language: 'zh-CN' } } },
      promptModes: { modes: [], currentModeId: 'code' }, activeChannel: {}, checkpoint: { config: {} }, workspaceUri: null,
    };
    if (method === 'ui.view.prepare') { missingView = false; return { accepted: true, viewId: params?.resumeViewId }; }
    if (method === 'ui.request' && params?.type === 'webviewReady') return missingView ? { success: false, reason: 'missing' } : { success: true };
    return {};
  });
  Object.defineProperty(window, 'graycode', { configurable: true, value: { kind: 'web',
    call: bridgeCall,
    subscribe: (listener: (event: any) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
  } });
  try {
    for (let round = 0; round < 2; round++) {
      bridgeCall.mockClear();
      vi.resetModules(); await import('../../platform/main');
      expect(listeners.size).toBe(1);
      const receive = [...listeners][0], delivered = vi.fn();
      window.__GRAYCODE_HOST!.subscribe!(delivered);
      receive({ type: 'transport.resumed' }); await flushPromises();
      expect(bridgeCall).not.toHaveBeenCalledWith('ui.request', expect.objectContaining({ type: 'webviewReady' }));
      if (!monitor) {
        const host = window.__GRAYCODE_HOST!;
        missingView = missingInitially;
        host.postMessage({ type: 'webviewReady', data: {}, requestId: `ready-${round}` }); await flushPromises();
        expect(bridgeCall).toHaveBeenCalledWith('ui.request', { type: 'webviewReady', data: { viewId: 'current-main-view' } });
        if (missingInitially) expect(bridgeCall).toHaveBeenCalledWith('ui.view.prepare', { resumeViewId: 'current-main-view' });
        delivered.mockClear();
        const message = { type: 'command', command: 'newChat' };
        receive({ type: 'ui.message', viewId: 'replaced-view', message });
        expect(delivered).not.toHaveBeenCalled();
        receive({ type: 'ui.message', viewId: 'current-main-view', message });
        expect(delivered).toHaveBeenCalledWith(message);
        host.setState({ input: '重连期间保留的草稿' });
        missingView = true;
        receive({ type: 'transport.resumed' }); await flushPromises();
        expect(bridgeCall).toHaveBeenCalledWith('ui.view.prepare', { resumeViewId: 'current-main-view' });
        expect(window.__GRAYCODE_HOST).toBe(host);
        expect(host.getState()).toEqual({ input: '重连期间保留的草稿' });
        expect(bridgeCall.mock.calls.filter(([method, params]) => method === 'ui.request' && params?.type === 'webviewReady'))
          .toHaveLength(missingInitially ? 4 : 3);
        delivered.mockClear();
      }
      window.dispatchEvent(new Event('pagehide'));
      expect(listeners.size).toBe(0);
      receive({ type: 'remote.changed' }); expect(delivered).not.toHaveBeenCalled();
    }
  } finally {
    window.dispatchEvent(new Event('pagehide')); window.__GRAYCODE_HOST = previousHost;
    window.__GRAYCODE_VIEW_MODE = previousMode;
    window.history.replaceState(null, '', previousUrl);
    vi.doUnmock('../../i18n'); vi.doUnmock('../../platform/appearance'); vi.doUnmock('../../components/common/markdown/markdownItCore');
    vi.doUnmock('../../platform/settingsDraft'); vi.doUnmock('../../main'); vi.resetModules();
  }
});
