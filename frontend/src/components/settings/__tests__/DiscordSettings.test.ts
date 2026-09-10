import { describe, expect, test, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import DiscordSettings from '../DiscordSettings.vue';
const mock = vi.hoisted(() => ({ send: vi.fn(), markDirty: vi.fn(), register: vi.fn() }));
vi.mock('@/utils/vscode', () => ({ sendToExtension: mock.send }));
vi.mock('@/platform/settingsDraft', () => ({ useDesktopSettingsDraft: mock.register, markDesktopSettingsDirty: mock.markDirty, desktopSettingsDraft: { dirty: false } }));
const settings = () => ({ version: 1, appearance: {}, providers: [], agents: [{ id: 'default', name: 'GrayCode', providerId: '' }], workspaces: [],
  accounts: [{ id: 'owner', role: 'owner', displayName: '主人' }, { id: 'member', role: 'member', displayName: '群聊成员' }], bindings: [],
  discord: { enabled: false, agentId: 'default', allowedChannelIds: ['123'], mentionOnly: true, credentialRef: 'saved-token',
    channels: { '123': { name: '现有频道', profile: { idleMinutes: 90 } } }, defaultProfile: { character: { kind: 'character', userName: '主人', persona: '', scanDepth: 2, worldbookIds: [], regexIds: [], recursiveScan: true } } },
});
beforeEach(() => {
  vi.clearAllMocks(); mock.send.mockImplementation(async (type: string) => {
    if (type === 'platform.settings.get') return settings();
    if (type === 'platform.discord.status') return { status: 'stopped' };
    if (type === 'getPromptModes') return { modes: [] };
    if (type === 'characters.list') return [];
    return { success: true };
  });
});
const button = (wrapper: ReturnType<typeof mount>, name: string) => wrapper.findAll('button').find(item => item.text() === name)!;

describe('Discord 设置共享草稿', () => {
  test('自动连接对旧配置默认勾选，关闭时写入共享草稿', async () => {
    const wrapper = mount(DiscordSettings); await flushPromises();
    const checkbox = wrapper.findAll('label').find(item => item.text().includes('启动时自动连接'))!.get('input');
    expect((checkbox.element as HTMLInputElement).checked).toBe(true); await checkbox.setValue(false); await flushPromises();
    const saved = mock.send.mock.calls.filter(call => call[0] === 'platform.settings.update').at(-1)![1];
    expect(saved.settings.discord.autoConnect).toBe(false); wrapper.unmount();
  });
  test('切换分类和搜索不改配置，频道添加保留原覆盖字段，私聊文案和身份选择明确', async () => {
    const wrapper = mount(DiscordSettings); await flushPromises();
    await button(wrapper, '主人私聊').trigger('click'); expect(wrapper.text()).toContain('其他已授权账号也不能使用');
    await button(wrapper, '频道').trigger('click'); await wrapper.get('input[type=search]').setValue('测试'); await flushPromises();
    expect(mock.send.mock.calls.filter(call => call[0] === 'platform.settings.update')).toHaveLength(0);
    await wrapper.get('[aria-label="手动添加频道 ID"]').setValue('456'); await button(wrapper, '添加频道').trigger('click'); await flushPromises();
    const saved = mock.send.mock.calls.filter(call => call[0] === 'platform.settings.update').at(-1)![1];
    expect(saved.settings.discord.allowedChannelIds).toEqual(['123', '456']); expect(saved.settings.discord.channels['123'].profile.idleMinutes).toBe(90);
    expect(saved.settings.discord.defaultProfile.character.recursiveScan).toBe(true);
    await button(wrapper, '身份绑定').trigger('click'); await button(wrapper, '添加身份绑定').trigger('click');
    expect((wrapper.get('.discord-binding select').element as HTMLSelectElement).value).toBe(''); expect(wrapper.text()).toContain('复制用户 ID');
    wrapper.unmount();
  });

  test('清空刚输入的 Token 撤销草稿替换，并保留原凭据引用', async () => {
    const wrapper = mount(DiscordSettings); await flushPromises();
    const token = wrapper.get('input[type=password]'); await token.setValue('new-fixture-token'); await flushPromises();
    await token.setValue(''); await flushPromises();
    const saved = mock.send.mock.calls.filter(call => call[0] === 'platform.settings.update').at(-1)![1];
    expect(saved.credentials).toEqual({}); expect(saved.clearCredentialChanges).toEqual(['saved-token']); expect(saved.settings.discord.credentialRef).toBe('saved-token');
    wrapper.unmount();
  });
});
