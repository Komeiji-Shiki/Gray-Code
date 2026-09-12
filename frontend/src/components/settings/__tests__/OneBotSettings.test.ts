import { beforeEach, describe, expect, test, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import PlatformIntegrationSettings from '../PlatformIntegrationSettings.vue';

const mock = vi.hoisted(() => ({ send: vi.fn(), listen: vi.fn(), unsubscribe: vi.fn(), markDirty: vi.fn(), register: vi.fn(), draft: { dirty: false } }));
vi.mock('@/utils/vscode', () => ({ sendToExtension: mock.send, onExtensionCommand: mock.listen }));
vi.mock('@/platform/settingsDraft', () => ({ useDesktopSettingsDraft: mock.register, markDesktopSettingsDirty: mock.markDirty, desktopSettingsDraft: mock.draft }));
const settings = () => ({ version: 1, appearance: {}, providers: [], agents: [{ id: 'default', name: 'GrayCode' }], workspaces: [],
  accounts: [{ id: 'owner', role: 'owner', displayName: '主人' }], bindings: [], discord: {},
  onebot: { enabled: false, endpoint: '', protocolVersion: 11, self: { platform: 'qq', userId: '' }, agentId: 'default', allowedChannelIds: [], mentionOnly: true },
});
beforeEach(() => {
  vi.clearAllMocks(); mock.draft.dirty = false;
  mock.listen.mockImplementation(() => mock.unsubscribe);
  mock.send.mockImplementation(async (type: string) => {
    if (type === 'platform.settings.get') return settings();
    if (type === 'platform.onebot.status') return { status: 'stopped' };
    if (type === 'ui.settings.status') return { dirty: false };
    if (type === 'platform.onebot.start') return { status: 'connected', name: '验证机器人', botId: '900' };
    return { success: true };
  });
});
const open = () => mount(PlatformIntegrationSettings, { props: { section: 'onebot' }, attachTo: document.body });
const button = (wrapper: ReturnType<typeof open>, name: string) => wrapper.findAll('button').find(item => item.text() === name)!;

describe('OneBot 连接反馈与草稿', () => {
  test('断线重连通知更新身份和错误，迟到的初始化状态不能覆盖通知', async () => {
    let resolveStatus!: (value: unknown) => void;
    const fallback = mock.send.getMockImplementation()!;
    mock.send.mockImplementation((type: string) => type === 'platform.onebot.status' ? new Promise(resolve => { resolveStatus = resolve; }) : fallback(type));
    const wrapper = open(); await flushPromises();
    try {
      const changed = mock.listen.mock.calls[0][1];
      changed({ platform: 'discord', status: { status: 'failed', error: '另一平台错误' } });
      changed({ platform: 'onebot', status: { status: 'reconnecting', error: '连接中断' } }); await flushPromises();
      resolveStatus({ status: 'stopped' }); await flushPromises();
      expect(wrapper.get('.integration-status').text()).toBe('正在重连');
      expect(wrapper.text()).toContain('连接中断'); expect(wrapper.text()).not.toContain('另一平台错误');
      changed({ platform: 'onebot', status: { status: 'connected', botId: '900', name: '验证机器人' } }); await flushPromises();
      expect(wrapper.get('.integration-status').text()).toBe('已连接');
      expect(wrapper.get('.integration-identity').text()).toContain('验证机器人');
      expect(wrapper.text()).not.toContain('连接中断');
    } finally { wrapper.unmount(); }
    expect(mock.unsubscribe).toHaveBeenCalledOnce();
  });

  test('新增绑定聚焦用户 ID，标记未保存且不默认授予主人权限', async () => {
    const wrapper = open(); await flushPromises();
    try {
      await button(wrapper, '添加绑定').trigger('click'); await flushPromises();
      expect(mock.markDirty).toHaveBeenCalledOnce();
      expect(document.activeElement).toBe(wrapper.get('[id^=binding-user-]').element);
      expect((wrapper.get('.integration-entry select').element as HTMLSelectElement).value).toBe('');
      mock.draft.dirty = true;
      await button(wrapper, '连接 / 重连').trigger('click'); await flushPromises();
      expect(wrapper.get('[role=alert]').text()).toContain('保存全部');
      expect(mock.send.mock.calls.some(call => call[0] === 'platform.onebot.start')).toBe(false);
      mock.draft.dirty = false;
      await button(wrapper, '连接 / 重连').trigger('click'); await flushPromises();
      expect(wrapper.get('.integration-status').text()).toBe('已连接');
      expect(wrapper.find('[role=alert]').exists()).toBe(false);
    } finally { wrapper.unmount(); }
  });
});
