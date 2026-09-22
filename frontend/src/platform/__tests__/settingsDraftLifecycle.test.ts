import { beforeEach, expect, test, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent, h } from 'vue';
import { sendToExtension } from '../../utils/vscode';
import { desktopSettingsDraft, trackPreferenceRequest, useDesktopSettingsDraft, markDesktopSettingsDirty, prepareDesktopSettingsNavigation } from '../settingsDraft';
vi.mock('@/utils/vscode', () => ({ sendToExtension: vi.fn(async () => ({})) }));
beforeEach(async () => { await trackPreferenceRequest('ui.settings.end', {}, Promise.resolve({ success: true })); });

test('聊天配置切换不产生设置草稿，进入与结束设置同步真实状态', async () => {
  await trackPreferenceRequest('settings.setActiveChannelId', {}, Promise.resolve({ success: true })); expect(desktopSettingsDraft.dirty).toBe(false);
  await trackPreferenceRequest('ui.settings.begin', {}, Promise.resolve({ dirty: false })); expect(desktopSettingsDraft.dirty).toBe(false);
  await trackPreferenceRequest('platform.settings.update', {}, Promise.resolve({ success: true })); expect(desktopSettingsDraft.dirty).toBe(true);
  await trackPreferenceRequest('ui.settings.end', {}, Promise.resolve({ success: true })); expect(desktopSettingsDraft.dirty).toBe(false);
});

test('设置初始化较慢时，返回的干净状态不会覆盖已经修改的表单', async () => {
  let resolve!: (value: { dirty: boolean }) => void;
  const opening = trackPreferenceRequest('ui.settings.begin', {}, new Promise<{ dirty: boolean }>(done => { resolve = done; }));
  await trackPreferenceRequest('platform.settings.update', {}, Promise.resolve({ success: true }));
  resolve({ dirty: false }); await opening; expect(desktopSettingsDraft.dirty).toBe(true);
});


test('分类跳转先验证草稿，失败保留原表单，修正后只暂存而不提交设置', async () => {
  const original = window.__GRAYCODE_HOST;
  window.__GRAYCODE_HOST = { kind: 'web' } as typeof original;
  await trackPreferenceRequest('ui.settings.begin', {}, Promise.resolve({ dirty: false }));
  let text = '{"LANG":'; const staged: unknown[] = [];
  const wrapper = mount(defineComponent({ setup() {
    useDesktopSettingsDraft(async () => {
      try { staged.push(JSON.parse(text)); } catch { throw new Error('环境变量 JSON 格式不正确'); }
    });
    return () => h('textarea', { value: text });
  } }));
  try {
    markDesktopSettingsDirty();
    expect(await prepareDesktopSettingsNavigation()).toBe(false);
    expect(desktopSettingsDraft.error).toContain('JSON 格式不正确');
    expect(wrapper.get('textarea').element.value).toBe('{"LANG":');
    expect(desktopSettingsDraft.dirty).toBe(true);
    text = '{"LANG":"zh_CN.UTF-8"}'; markDesktopSettingsDirty();
    expect(await prepareDesktopSettingsNavigation()).toBe(true);
    expect(staged).toEqual([{ LANG: 'zh_CN.UTF-8' }]);
    expect(desktopSettingsDraft.error).toBe('');
    expect(desktopSettingsDraft.busy).toBe(false);
    expect(desktopSettingsDraft.dirty).toBe(true);
    expect(vi.mocked(sendToExtension).mock.calls.some(([type]) => type === 'ui.settings.save')).toBe(false);
  } finally { wrapper.unmount(); window.__GRAYCODE_HOST = original; }
});

test('暂存未结束时拒绝第二次分类跳转，避免并发写入同一份草稿', async () => {
  const original = window.__GRAYCODE_HOST;
  window.__GRAYCODE_HOST = { kind: 'web' } as typeof original;
  await trackPreferenceRequest('ui.settings.begin', {}, Promise.resolve({ dirty: false }));
  let finish!: () => void;
  const stage = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  const wrapper = mount(defineComponent({ setup() { useDesktopSettingsDraft(stage); return () => h('div'); } }));
  try {
    markDesktopSettingsDirty(); const first = prepareDesktopSettingsNavigation();
    expect(desktopSettingsDraft.busy).toBe(true);
    expect(await prepareDesktopSettingsNavigation()).toBe(false);
    expect(stage).toHaveBeenCalledOnce(); finish();
    expect(await first).toBe(true); expect(desktopSettingsDraft.busy).toBe(false);
  } finally { finish?.(); wrapper.unmount(); window.__GRAYCODE_HOST = original; }
});
