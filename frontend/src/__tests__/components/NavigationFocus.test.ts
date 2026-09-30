import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import ConversationSidebar from '../../../../apps/client/src/components/ConversationSidebar.vue';
import { state } from '../../../../apps/client/src/state';
import { setShellLanguage } from '../../../../apps/client/src/i18n';

const mocks = vi.hoisted(() => ({ call: vi.fn(), state: {
  conversationId: 'conversation-a', conversationViews: [] as any[], workspaceId: '',
  chatFocused: false, settingsOpen: false, navigationDialogOpen: false,
} }));
vi.mock('../../../../apps/client/src/api', () => ({ call: mocks.call, subscribe: () => () => {} }));
vi.mock('../../../../apps/client/src/state', async () => {
  const { reactive } = await import('vue');
  return { state: reactive(mocks.state), guard: (action: () => unknown) => action() };
});

const wrappers: ReturnType<typeof mount>[] = [];
let navigation: any;
beforeEach(() => {
  document.body.innerHTML = '<div class="application"></div>';
  Object.assign(state, { conversationViews: [], settingsOpen: false, navigationDialogOpen: false });
  setShellLanguage('zh-CN');
  navigation = { items: [{ id: 'conversation-a', title: '测试对话', createdAt: 1, updatedAt: 1 }], pinned: [], workspaces: [], runs: [] };
  mocks.call.mockReset();
  mocks.call.mockImplementation(async (method, params) => {
    if (method === 'ui.request' && params.type === 'conversation.navigation') return structuredClone(navigation);
    if (method === 'ui.request' && params.type === 'conversation.deleteConversation') navigation.items = [];
    if (method === 'ui.command' && params.command === 'showSettings') state.settingsOpen = true;
    return { success: true };
  });
});
afterEach(() => { wrappers.splice(0).forEach(wrapper => wrapper.unmount()); document.body.innerHTML = ''; });

async function openSidebar() {
  const wrapper = mount(ConversationSidebar, { props: { collapsed: false }, attachTo: '.application' });
  wrappers.push(wrapper); await flushPromises(); return wrapper;
}
function key(key: string, shiftKey = false) {
  document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true }));
}
function menuButtons() { return Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menu"] button')); }
async function openMenu(wrapper: ReturnType<typeof mount>) {
  const trigger = wrapper.get<HTMLButtonElement>('.navigation-more');
  trigger.element.focus(); await trigger.trigger('click'); await flushPromises(); return trigger.element;
}

test('导航菜单进入焦点、方向键与 Tab 循环，Escape 还原操作按钮', async () => {
  const wrapper = await openSidebar(); const trigger = await openMenu(wrapper);
  const buttons = menuButtons();
  expect(document.activeElement).toBe(buttons[0]);
  key('ArrowUp'); expect(document.activeElement).toBe(buttons.at(-1));
  key('Tab'); expect(document.activeElement).toBe(buttons[0]);
  key('Tab', true); expect(document.activeElement).toBe(buttons.at(-1));
  key('Home'); expect(document.activeElement).toBe(buttons[0]);
  key('End'); expect(document.activeElement).toBe(buttons.at(-1));
  key('Escape'); await flushPromises();
  expect(document.querySelector('[role="menu"]')).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

test('重命名选中现有标题，确认表单取消后回到原始菜单入口', async () => {
  const wrapper = await openSidebar(); const trigger = await openMenu(wrapper);
  menuButtons().find(button => button.textContent === '重命名')!.click(); await flushPromises();
  const input = document.querySelector<HTMLInputElement>('.navigation-dialog input')!;
  expect(document.activeElement).toBe(input);
  expect(input.value.slice(input.selectionStart!, input.selectionEnd!)).toBe('测试对话');
  const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('.navigation-dialog button'));
  buttons.at(-1)!.focus(); key('Tab'); expect(document.activeElement).toBe(input);
  key('Tab', true); expect(document.activeElement).toBe(buttons.at(-1));
  key('Escape'); await flushPromises();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

test('删除确认默认选择取消，完成后入口消失时把焦点放回导航搜索', async () => {
  const wrapper = await openSidebar(); await openMenu(wrapper);
  menuButtons().find(button => button.textContent === '删除对话')!.click(); await flushPromises();
  expect(document.activeElement).toBe(document.querySelector('[data-navigation-cancel]'));
  const confirm = document.querySelector<HTMLButtonElement>('.navigation-dialog button:last-child')!;
  confirm.click(); await flushPromises();
  expect(wrapper.find('.navigation-row').exists()).toBe(false);
  expect(document.activeElement).toBe(wrapper.get('.navigation-search input').element);
});

test('导航请求处理期间 Tab 留在表单，Escape 不取消已提交的操作', async () => {
  let finish!: () => void;
  const normalCall = mocks.call.getMockImplementation()!;
  mocks.call.mockImplementation((method, params) => method === 'ui.request' && params.type === 'conversation.rename'
    ? new Promise(resolve => { finish = () => resolve({ success: true }); }) : normalCall(method, params));
  const wrapper = await openSidebar(); const trigger = await openMenu(wrapper);
  menuButtons().find(button => button.textContent === '重命名')!.click(); await flushPromises();
  document.querySelector<HTMLFormElement>('.navigation-dialog')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await flushPromises(); key('Tab');
  expect(document.activeElement).toBe(document.querySelector('.navigation-dialog'));
  key('Escape'); await flushPromises(); expect(document.querySelector('.navigation-dialog')).not.toBeNull();
  finish(); await flushPromises(); expect(document.activeElement).toBe(trigger);
});

test('普通对话创建菜单的 Escape 返回加号，设置 iframe 关闭返回唯一设置按钮', async () => {
  const wrapper = await openSidebar();
  const add = wrapper.get<HTMLButtonElement>('[data-navigation-group="general"] .navigation-project-add');
  add.element.focus(); await add.trigger('click'); await flushPromises();
  expect(document.activeElement).toBe(menuButtons()[0]);
  key('Escape'); await flushPromises(); expect(document.activeElement).toBe(add.element);
  const settings = wrapper.get<HTMLButtonElement>('[title="设置"]');
  settings.element.focus(); await settings.trigger('click'); await flushPromises();
  wrapper.get<HTMLInputElement>('.navigation-search input').element.focus();
  state.settingsOpen = false; await flushPromises(); expect(document.activeElement).toBe(settings.element);
});

test('等待回答与等待确认都有不同的可见状态文字', async () => {
  navigation.items.push({ id: 'conversation-b', title: '另一对话', createdAt: 1, updatedAt: 1 });
  navigation.runs = [{ conversationId: 'conversation-a', status: 'awaiting_input' }, { conversationId: 'conversation-b', status: 'awaiting_approval' }];
  const wrapper = await openSidebar();
  expect(wrapper.get('[data-conversation-id="conversation-a"] .navigation-waiting-status').text()).toBe('等待回答');
  expect(wrapper.get('[data-conversation-id="conversation-b"] .navigation-waiting-status').text()).toBe('等待确认');
});
