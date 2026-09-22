import { mount, flushPromises } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PetManager from '../../../../apps/client/src/components/PetManager.vue';
const { call } = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../../../../apps/client/src/api', () => ({ call }));
const resources = ['first', 'second'].map(id => ({ id, name: id, kind: 'sprite', sprite: { version: 2 }, files: [], actions: [], expressions: [] }));
const configuration = { resourceId: 'first', visible: false, surface: 'app', scale: 1, reducedMotion: false, stopped: false, taskAnimations: true, mappings: {} };
const wrappers: ReturnType<typeof mount>[] = [];
const button = (wrapper: ReturnType<typeof mount>, label: string) => wrapper.findAll('button').find(item => item.text() === label)!;
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(); call.mockReset();
  call.mockImplementation(async method => method === 'pets.list' ? resources : { configuration: structuredClone(configuration), revision: 1, floatingAvailable: true });
});
afterEach(() => { wrappers.splice(0).forEach(wrapper => wrapper.unmount()); });
async function open() { const wrapper = mount(PetManager, { global: { stubs: { PetPlayer: true } } }); wrappers.push(wrapper); await flushPromises(); return wrapper; }

describe('桌宠选择草稿', () => {
  it('未保存的新资源选择在关闭前要求处理', async () => {
    const wrapper = await open(); await wrapper.findAll('.pet-row')[1].trigger('click');
    await button(wrapper, '关闭').trigger('click');
    expect(wrapper.emitted('close')).toBeUndefined(); expect(wrapper.find('footer.confirm').exists()).toBe(true);
  });
  it('跳转屏幕感知也保留未保存确认，确认后进入原目标', async () => {
    const wrapper = await open(); await wrapper.findAll('.pet-row')[1].trigger('click');
    await button(wrapper, '屏幕感知设置').trigger('click'); expect(wrapper.emitted('screenSense')).toBeUndefined();
    await button(wrapper, '放弃更改并继续').trigger('click'); expect(wrapper.emitted('screenSense')).toHaveLength(1);
    expect(wrapper.emitted('close')).toHaveLength(1);
  });
  it('放弃更改恢复保存的资源选择，随后可直接关闭', async () => {
    const wrapper = await open(); await wrapper.findAll('.pet-row')[1].trigger('click');
    await button(wrapper, '放弃更改并读取已保存设置').trigger('click'); await flushPromises();
    expect(wrapper.findAll('.pet-row')[0].attributes('aria-pressed')).toBe('true');
    await button(wrapper, '关闭').trigger('click'); expect(wrapper.emitted('close')).toHaveLength(1);
  });
});
