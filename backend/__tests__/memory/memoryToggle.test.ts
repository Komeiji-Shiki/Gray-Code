import { SettingsManager, type SettingsStorage } from '../../modules/settings/SettingsManager';
import type { GlobalSettings } from '../../modules/settings/types';

const MEMORY_TOOL_NAMES = ['memory_topics', 'memory_search', 'memory_read'];

class TestSettingsStorage implements SettingsStorage {
    constructor(private value: GlobalSettings | null = null) {}

    async load(): Promise<GlobalSettings | null> {
        return this.value;
    }

    async save(settings: GlobalSettings): Promise<void> {
        this.value = structuredClone(settings);
    }
}

describe('permanent memory toggle', () => {
    test('defaults to enabled and disables every library tool as one group', async () => {
        const manager = new SettingsManager(new TestSettingsStorage());
        await manager.initialize();

        expect(manager.isMemoryEnabled()).toBe(true);
        for (const toolName of MEMORY_TOOL_NAMES) {
            expect(manager.isToolEnabled(toolName)).toBe(true);
        }

        await manager.updateMemoryConfig({ enabled: false });
        await expect(manager.setToolEnabled('memory_search', true)).rejects.toThrow('Permanent memory is disabled');

        expect(manager.isMemoryEnabled()).toBe(false);
        for (const toolName of MEMORY_TOOL_NAMES) {
            expect(manager.isToolEnabled(toolName)).toBe(false);
        }
        expect(manager.isToolEnabled('read_file')).toBe(true);

        await manager.updateMemoryConfig({ enabled: true });
        for (const toolName of MEMORY_TOOL_NAMES) {
            expect(manager.isToolEnabled(toolName)).toBe(true);
        }
    });

});
