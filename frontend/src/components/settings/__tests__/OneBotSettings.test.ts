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
    if (type === 'getPromptModes') return { modes: [] };
    if (type === 'characters.list') return [];
    return { success: true };
  });
});
const open = () => mount(PlatformIntegrationSettings, { props: { section: 'onebot' }, attachTo: document.body });
const button = (wrapper: ReturnType<typeof open>, name: string) => wrapper.findAll('button').find(item => item.text() === name)!;

describe('OneBot 连接反馈与草稿', () => {
  test('待发送确认只影响重试，不写入设置草稿', async () => {
    const fallback = mock.send.getMockImplementation()!;
    mock.send.mockImplementation((type: string) => type === 'platform.onebot.outbox'
      ? Promise.resolve({ messages: [{ id: 'pending', phase: 'unknown', channelId: 'group:30', preview: '待确认', completedParts: 0, totalParts: 1 }] }) : fallback(type));
    const wrapper = open(); await flushPromises();
    try {
      await wrapper.get('.outbox-toggle').trigger('click'); await flushPromises();
      await wrapper.get('.bot-outbox input[type=checkbox]').setValue(true); await flushPromises();
      expect(mock.send.mock.calls.some(call => call[0] === 'platform.settings.update')).toBe(false);
      expect(mock.markDirty).not.toHaveBeenCalled();
    } finally { wrapper.unmount(); }
  });
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

  test('处理中提示只对新建配置默认开启，已有配置缺少字段时保持关闭', async () => {
    const hint = (wrapper: ReturnType<typeof open>) => wrapper.findAll('label').find(item => item.text().startsWith('开始处理时提示'))!
      .get('input').element as HTMLInputElement;
    const existing = open(); await flushPromises();
    try { expect(hint(existing).checked).toBe(false); } finally { existing.unmount(); }
    const fallback = mock.send.getMockImplementation()!;
    mock.send.mockImplementation(async (type: string) => type === 'platform.settings.get' ? { ...settings(), onebot: undefined } : fallback(type));
    const created = open(); await flushPromises();
    try { expect(hint(created).checked).toBe(true); } finally { created.unmount(); }
  });

  test('默认回复可以选择模型渠道与模型', async () => {
    const fallback = mock.send.getMockImplementation()!;
    const configured = settings();
    (configured as any).providers = [
      { id: 'p1', name: '渠道一', models: [{ id: 'm1', name: '模型一' }] },
      { id: 'p2', name: '渠道二', models: [{ id: 'm2', name: '模型二' }] },
    ];
    mock.send.mockImplementation(async (type: string) => type === 'platform.settings.get' ? configured : fallback(type));
    const wrapper = open(); await flushPromises();
    try {
      await button(wrapper, '默认回复').trigger('click'); await flushPromises();
      const provider = wrapper.findAll('label').find(item => item.text().startsWith('模型渠道'))!;
      await provider.get('select').setValue('p2'); await flushPromises();
      expect((configured as any).onebot.defaultProfile.providerId).toBe('p2');
      expect((configured as any).onebot.defaultProfile.modelId).toBeUndefined();
      const model = wrapper.findAll('label').find(item => item.findAll('option').some(option => option.attributes('value') === 'm2'))!;
      await model.get('select').setValue('m2'); await flushPromises();
      expect((configured as any).onebot.defaultProfile.modelId).toBe('m2');
    } finally { wrapper.unmount(); }
  });

  test('旧配置的默认输出迁移到平台默认输出，默认回复不再重复显示输出项', async () => {
    const fallback = mock.send.getMockImplementation()!;
    const configured = settings();
    (configured as any).onebot.defaultProfile = { modelId: 'm1', output: { streaming: false, updateIntervalMs: 1000, showThoughts: true, showToolStatus: true, longReplies: 'forward' } };
    mock.send.mockImplementation(async (type: string) => type === 'platform.settings.get' ? configured : fallback(type));
    const wrapper = open(); await flushPromises();
    try {
      expect((configured as any).onebot.output).toMatchObject({ showThoughts: true, showToolStatus: true, longReplies: 'forward', streaming: false });
      expect((configured as any).onebot.defaultProfile).toEqual({ modelId: 'm1' });
      await button(wrapper, '默认回复').trigger('click'); await flushPromises();
      expect(wrapper.findAll('label').some(item => item.text().startsWith('单独配置回复显示'))).toBe(false);
    } finally { wrapper.unmount(); }
  });

  test('QQ 页面继承的默认环境条目使用 QQ 说话习惯', async () => {
    const wrapper = open(); await flushPromises();
    try {
      await button(wrapper, '默认回复').trigger('click'); await flushPromises();
      const environment = wrapper.findAll('textarea').map(item => (item.element as HTMLTextAreaElement).value).find(value => value.includes('当前交流环境'));
      expect(environment).toContain('QQ 不显示 Markdown');
      expect(environment).toContain('[表情包:名称]');
    } finally { wrapper.unmount(); }
  });

  test('新增绑定聚焦用户 ID，标记未保存且不默认授予主人权限', async () => {
    const wrapper = open(); await flushPromises();
    try {
      await button(wrapper, '身份绑定').trigger('click'); await flushPromises();
      await button(wrapper, '添加绑定').trigger('click'); await flushPromises();
      expect(mock.markDirty).toHaveBeenCalledOnce();
      expect(document.activeElement).toBe(wrapper.get('[id^=binding-user-]').element);
      expect((wrapper.get('.integration-entry select').element as HTMLSelectElement).value).toBe('');
      await button(wrapper, '连接').trigger('click'); await flushPromises();
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
