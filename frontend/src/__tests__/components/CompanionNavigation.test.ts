import { mount, flushPromises } from '@vue/test-utils';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import CompanionSetup from '../../../../apps/client/src/components/CompanionSetup.vue';
import CharacterSetup from '../../../../apps/client/src/components/CharacterSetup.vue';
const mocks = vi.hoisted(() => ({ call: vi.fn(), state: { conversationId: 'original', mode: 'character', chatFocused: false } }));
vi.mock('../../../../apps/client/src/api', () => ({ call: mocks.call }));
vi.mock('../../../../apps/client/src/state', () => ({ state: mocks.state }));
const wrappers: ReturnType<typeof mount>[] = [];
const button = (wrapper: ReturnType<typeof mount>, label: string) => wrapper.findAll('button').find(item => item.text() === label)!;
beforeEach(() => {
  mocks.call.mockReset(); mocks.state.conversationId = 'original'; HTMLDialogElement.prototype.showModal = vi.fn();
  mocks.call.mockImplementation(async (method, params) => {
    if (method === 'companion.get') return { configuration: { enabled: true, name: '伙伴', userName: '', tone: '' }, defaultsRevision: null, hasDefaults: false, characters: [] };
    if (method === 'ui.request' && params.type === 'characters.list') return [];
    if (method === 'ui.request' && params.type === 'characters.conversation.get') return { config: { kind: 'character', userName: '用户', persona: '', worldbookIds: [], regexIds: [], scanDepth: 2 }, mode: 'character', metadataToken: 'original-revision' };
    return {};
  });
});
afterEach(() => { wrappers.splice(0).forEach(wrapper => wrapper.unmount()); });
async function open(component: typeof CompanionSetup | typeof CharacterSetup) { const wrapper = mount(component); wrappers.push(wrapper); await flushPromises(); return wrapper; }

test('陪伴配置打开记忆前先关闭原模态窗口', async () => {
  const wrapper = await open(CompanionSetup); await button(wrapper, '查看与纠正长期记忆').trigger('click');
  expect(wrapper.emitted('close')).toHaveLength(1); expect(wrapper.emitted('memory')).toHaveLength(1);
});
test('陪伴配置跳转时保护草稿，并记住原来的跳转目标', async () => {
  const wrapper = await open(CompanionSetup); await wrapper.find('textarea').setValue('新的交流偏好');
  await button(wrapper, '定时提醒与自动任务').trigger('click'); expect(wrapper.emitted('reminders')).toBeUndefined();
  await button(wrapper, '保留编辑').trigger('click'); expect(wrapper.find('textarea').element.value).toBe('新的交流偏好');
  await button(wrapper, '定时提醒与自动任务').trigger('click'); await button(wrapper, '放弃更改并继续').trigger('click');
  expect(wrapper.emitted('close')).toHaveLength(1); expect(wrapper.emitted('reminders')).toHaveLength(1);
});
test('角色配置关闭和 Escape 都保护未保存内容', async () => {
  const wrapper = await open(CharacterSetup); expect(HTMLDialogElement.prototype.showModal).toHaveBeenCalled();
  await wrapper.find('textarea').setValue('还未保存的人设'); await wrapper.find('dialog').trigger('cancel');
  expect(wrapper.emitted('close')).toBeUndefined(); expect(wrapper.text()).toContain('角色配置还没有保存');
  await button(wrapper, '继续编辑').trigger('click'); await button(wrapper, '关闭').trigger('click');
  expect(wrapper.emitted('close')).toBeUndefined(); await button(wrapper, '放弃并关闭').trigger('click');
  expect(wrapper.emitted('close')).toHaveLength(1);
});
test('角色配置保存始终绑定打开时的对话', async () => {
  const wrapper = await open(CharacterSetup); mocks.state.conversationId = 'another';
  await button(wrapper, '保存到当前角色对话').trigger('click'); await flushPromises();
  expect(mocks.call).toHaveBeenCalledWith('ui.request', { type: 'characters.conversation.save', data: expect.objectContaining({ conversationId: 'original', metadataToken: 'original-revision' }) });
});
