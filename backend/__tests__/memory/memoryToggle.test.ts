import { MEMORY_TOOL_NAMES } from '../../modules/memory/types';
import { PromptAssembler, type PromptAssemblyHost } from '../../modules/prompt/PromptAssembler';
import { generateMemorySection } from '../../modules/prompt/commonSections';
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

function promptAssembler(settings: SettingsManager): PromptAssembler {
    const sections: PromptAssemblyHost['sections'] = {
        wrapSection: (name, text) => text ? `====\n\n${name}\n\n${text}` : '',
        cleanupEmptyLines: text => text.replace(/\n{3,}/g, '\n\n').trim(),
        getUserLanguage: () => 'zh-CN',
        generateStaticEnvironmentSection: () => '',
        generateContextBadgeFormatSection: () => '',
        generateMemorySection: () => generateMemorySection(settings),
        generateFileTreeSection: () => '',
        generateOpenTabsSection: () => '',
        generateActiveEditorSection: () => '',
        generateDiagnosticsSection: () => '',
        generatePinnedFilesSection: () => '',
        getContext: () => ({}),
    };
    return new PromptAssembler({ settings: () => settings, workspacePaths: () => [], sections });
}

describe('permanent memory toggle', () => {
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
        const promptManager = promptAssembler(manager);
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
        const promptManager = promptAssembler(manager);
        const prompt = promptManager.getSystemPrompt(legacyMode);

        expect(prompt).toContain('Successful pendingCompression is deferred maintenance');
        expect(prompt).toContain('finish the current deliverable before action=compress');
        expect(prompt).toContain('Only compress immediately when wake cannot finish without a missing summary');
        expect(prompt).not.toContain('before your next step');
    });
});
