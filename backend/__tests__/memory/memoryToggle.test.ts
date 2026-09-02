import { clearGlobalContext, setGlobalSettingsManager } from '../../core/settingsContext';
import { MEMORY_TOOL_NAMES } from '../../modules/memory';
import { PromptManager } from '../../modules/prompt';
import { SettingsManager, type SettingsStorage } from '../../modules/settings/SettingsManager';
import type { GlobalSettings, ResolvedPromptModeSnapshot } from '../../modules/settings/types';

class TestSettingsStorage implements SettingsStorage {
    constructor(private value: GlobalSettings | null = null) {}

    async load(): Promise<GlobalSettings | null> {
        return this.value;
    }

    async save(settings: GlobalSettings): Promise<void> {
        this.value = structuredClone(settings);
    }
}

const legacyMode: ResolvedPromptModeSnapshot = {
    id: 'memory-test',
    name: 'Memory Test',
    template: 'Before\n{{$MEMORY}}\nAfter',
    promptAssemblyMode: 'legacy',
    dynamicTemplateEnabled: false,
    dynamicTemplate: '',
};

const entriesMode: ResolvedPromptModeSnapshot = {
    ...legacyMode,
    id: 'memory-entries-test',
    promptAssemblyMode: 'entries',
    promptEntries: [
        {
            id: 'system',
            name: 'System',
            type: 'prompt',
            enabled: true,
            role: 'system',
            order: 0,
            content: 'Before\n{{$MEMORY}}\nAfter',
        },
    ],
};

describe('permanent memory toggle', () => {
    afterEach(() => {
        clearGlobalContext();
    });

    test('defaults to enabled and disables every memory tool as one group', async () => {
        const manager = new SettingsManager(new TestSettingsStorage());
        await manager.initialize();

        expect(manager.isMemoryEnabled()).toBe(true);
        for (const toolName of MEMORY_TOOL_NAMES) {
            expect(manager.isToolEnabled(toolName)).toBe(true);
        }

        await manager.updateMemoryConfig({ enabled: false });
        await expect(manager.setToolEnabled('memory_wake', true)).rejects.toThrow('Permanent memory is disabled');

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

    test.each([legacyMode, entriesMode])('removes the memory prompt when disabled in $promptAssemblyMode mode', async mode => {
        const manager = new SettingsManager(new TestSettingsStorage());
        await manager.initialize();
        await manager.updateMemoryConfig({ enabled: true, systemPrompt: 'CUSTOM MEMORY INSTRUCTIONS' });
        setGlobalSettingsManager(manager);

        const promptManager = new PromptManager({ includeWorkspaceFiles: false });
        const enabledPrompt = promptManager.getSystemPrompt(mode);
        expect(enabledPrompt).toContain('CUSTOM MEMORY INSTRUCTIONS');

        await manager.updateMemoryConfig({ enabled: false });
        const disabledPrompt = promptManager.getSystemPrompt(mode);
        expect(disabledPrompt).toContain('Before');
        expect(disabledPrompt).toContain('After');
        expect(disabledPrompt).not.toContain('CUSTOM MEMORY INSTRUCTIONS');
        expect(disabledPrompt).not.toContain('{{$MEMORY}}');
    });

    test('default guidance defers routine compression without hiding wake blockers', async () => {
        const manager = new SettingsManager(new TestSettingsStorage());
        await manager.initialize();
        setGlobalSettingsManager(manager);

        const promptManager = new PromptManager({ includeWorkspaceFiles: false });
        const prompt = promptManager.getSystemPrompt(legacyMode);

        expect(prompt).toContain('压缩不得打断当前用户任务');
        expect(prompt).toContain('它只是可延后的维护提示');
        expect(prompt).toContain('只有 memory_wake 明确因缺少必要摘要而失败时');
        expect(prompt).not.toContain('在你进行下一步操作之前执行 memory_compress');
    });
});
