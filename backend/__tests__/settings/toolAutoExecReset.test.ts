import { SettingsManager, MemorySettingsStorage } from '../../modules/settings';

describe('ToolsSettingsService.resetToolAutoExec', () => {
    test('默认配置里的工具写回默认值，其他工具移除单独设置，重新加载后结果不变', async () => {
        const storage = new MemorySettingsStorage();
        const settings = new SettingsManager(storage);
        await settings.initialize();
        await settings.setToolAutoExec('execute_command', true);
        await settings.setToolAutoExec('subagent_requests', true);

        await settings.resetToolAutoExec('execute_command');
        await settings.resetToolAutoExec('subagent_requests');

        const stored = settings.getScalarSettings('toolAutoExec').toolAutoExec ?? {};
        expect(stored.execute_command).toBe(false);
        expect(Object.prototype.hasOwnProperty.call(stored, 'subagent_requests')).toBe(false);
        expect(settings.isToolAutoExec('execute_command')).toBe(false);

        const reloaded = new SettingsManager(storage);
        await reloaded.initialize();
        expect(reloaded.getScalarSettings('toolAutoExec').toolAutoExec).toEqual(stored);
    });
});
