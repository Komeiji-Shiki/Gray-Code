import { ContextSettingsService } from '../../modules/settings/ContextSettingsService';
import { SettingsCore } from '../../modules/settings/SettingsCore';
import { MemorySettingsStorage } from '../../modules/settings/storage';

test('上下文数量只接受 -1 或非负整数，失败时整份修改不生效', async () => {
  const service = new ContextSettingsService(new SettingsCore(new MemorySettingsStorage()));
  await service.updateContextAwarenessConfig({ maxFileDepth: 0, maxOpenTabs: -1 });
  expect(service.getMaxFileDepth()).toBe(0); expect(service.getMaxOpenTabs()).toBe(-1);
  await expect(service.updateContextAwarenessConfig({ includeWorkspaceFiles: false, maxFileDepth: 2.5 })).rejects.toThrow('非负整数');
  expect(service.shouldIncludeWorkspaceFiles()).toBe(true); expect(service.getMaxFileDepth()).toBe(0);
  await expect(service.updateContextAwarenessConfig({ maxOpenTabs: -2 })).rejects.toThrow('非负整数');
  await expect(service.updateDiagnosticsConfig({ maxDiagnosticsPerFile: 1.5 })).rejects.toThrow('非负整数');
  await expect(service.updateDiagnosticsConfig({ maxFiles: Infinity })).rejects.toThrow('非负整数');
  await service.updateDiagnosticsConfig({ maxFiles: 0, maxDiagnosticsPerFile: -1 });
  expect(service.getDiagnosticsConfig()).toMatchObject({ maxFiles: 0, maxDiagnosticsPerFile: -1 });
});
