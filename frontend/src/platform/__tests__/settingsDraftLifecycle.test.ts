import { beforeEach, expect, test, vi } from 'vitest';
import { desktopSettingsDraft, trackPreferenceRequest } from '../settingsDraft';
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
