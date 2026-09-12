import { beforeEach, describe, expect, test, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import BotOutboxPanel from '../bots/BotOutboxPanel.vue';

const mock = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('@/utils/vscode', () => ({ sendToExtension: mock.send }));
const delivery = { id: 'pending', phase: 'unknown', channelId: 'group:30', conversationId: 'conversation', createdAt: 1,
  preview: '需要确认的回复', completedParts: 0, totalParts: 1, error: '连接中断，回执未知' };
beforeEach(() => { vi.clearAllMocks(); });

describe('Bot 待发送消息', () => {
  test.each(['discord', 'onebot'] as const)('%s 需要连接并明确确认才重试，成功后清除旧记录', async platform => {
    let retried = false;
    mock.send.mockImplementation(async (type: string) => {
      if (type.endsWith('.retryDelivery')) { retried = true; return { success: true }; }
      return { messages: retried ? [] : [delivery] };
    });
    const wrapper = mount(BotOutboxPanel, { props: { platform, connected: false } }); await flushPromises();
    try {
      const retry = () => wrapper.get('.outbox-delivery button');
      expect(retry().attributes('disabled')).toBeDefined();
      await wrapper.get('input[type=checkbox]').setValue(true);
      expect(retry().attributes('disabled')).toBeDefined();
      await wrapper.setProps({ connected: true }); await flushPromises();
      expect(retry().attributes('disabled')).toBeUndefined();
      await retry().trigger('click'); await flushPromises();
      expect(mock.send).toHaveBeenCalledWith(`platform.${platform}.retryDelivery`, { id: 'pending', acknowledgeDuplicateRisk: true });
      expect(wrapper.text()).toContain('目前没有待发送消息');
      expect(wrapper.find('.outbox-delivery').exists()).toBe(false);
      expect(wrapper.attributes()).toHaveProperty('data-preference-transient');
    } finally { wrapper.unmount(); }
  });

  test('读取失败显示原因并可重试，不会把失败显示为空队列', async () => {
    mock.send.mockRejectedValueOnce(new Error('暂时无法读取')).mockResolvedValue({ messages: [delivery] });
    const wrapper = mount(BotOutboxPanel, { props: { platform: 'onebot', connected: true } }); await flushPromises();
    try {
      expect(wrapper.get('[role=alert]').text()).toBe('暂时无法读取');
      expect(wrapper.text()).not.toContain('目前没有待发送消息');
      await wrapper.get('header button').trigger('click'); await flushPromises();
      expect(wrapper.find('[role=alert]').exists()).toBe(false);
      expect(wrapper.get('pre').text()).toBe('需要确认的回复');
      expect(wrapper.get('.outbox-delivery button').attributes('disabled')).toBeDefined();
    } finally { wrapper.unmount(); }
  });
});
