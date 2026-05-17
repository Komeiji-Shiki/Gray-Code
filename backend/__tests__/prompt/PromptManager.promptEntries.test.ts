import { clearGlobalContext, setGlobalSettingsManager } from '../../core/settingsContext';
import { PromptManager } from '../../modules/prompt';
import type { ResolvedPromptModeSnapshot, SystemPromptConfig } from '../../modules/settings/types';

const mode: ResolvedPromptModeSnapshot = {
    id: 'entry-mode',
    name: 'Entry Mode',
    template: 'legacy system',
    promptAssemblyMode: 'entries',
    dynamicTemplateEnabled: true,
    dynamicTemplate: 'legacy dynamic',
    promptEntries: [
        {
            id: 'system',
            name: 'System',
            type: 'prompt',
            enabled: true,
            role: 'system',
            order: 0,
            content: 'System {{$TODO_LIST}} {{$TOOLS}}'
        },
        {
            id: 'few-shot-user',
            name: 'Few shot user',
            type: 'prompt',
            enabled: true,
            role: 'user',
            order: 10,
            content: 'Static user context'
        },
        {
            id: 'assistant',
            name: 'Assistant prelude',
            type: 'prompt',
            enabled: true,
            role: 'assistant',
            order: 20,
            content: 'Assistant prelude'
        },
        {
            id: 'chat-history',
            name: 'Chat History',
            type: 'chat_history',
            enabled: true,
            role: 'user',
            order: 25,
            content: ''
        },
        {
            id: 'dynamic-user',
            name: 'Dynamic user',
            type: 'prompt',
            enabled: true,
            role: 'user',
            order: 30,
            content: 'Dynamic {{$TODO_LIST}}'
        },
        {
            id: 'disabled',
            name: 'Disabled',
            type: 'prompt',
            enabled: false,
            role: 'user',
            order: 40,
            content: 'should not appear'
        }
    ]
};

function createSettingsManagerMock(resolvedMode: ResolvedPromptModeSnapshot = mode) {
    const config: Partial<SystemPromptConfig> = {
        customPrefix: '',
        customSuffix: '',
        dynamicTemplateEnabled: true,
        dynamicTemplate: '',
        dynamicContextStrategy: 'single',
        template: '',
        currentModeId: resolvedMode.id,
        modes: { [resolvedMode.id]: resolvedMode }
    };

    return {
        resolvePromptMode: jest.fn(() => resolvedMode),
        getSystemPromptConfig: jest.fn(() => config),
        getContextAwarenessConfig: jest.fn(() => ({
            includeWorkspaceFiles: false,
            includeOpenTabs: false,
            includeActiveEditor: false,
            ignorePatterns: []
        })),
        getPinnedFilesConfig: jest.fn(() => ({ sectionTitle: 'PINNED FILES CONTENT' })),
        getUISettings: jest.fn(() => ({ language: 'zh-CN' }))
    } as any;
}

describe('PromptManager prompt entries', () => {
    afterEach(() => {
        clearGlobalContext();
    });

    it('builds system prompt and splits non-system prompt context around chat history entry', () => {
        setGlobalSettingsManager(createSettingsManagerMock());
        const manager = new PromptManager({ includeWorkspaceFiles: false });
        const runtime = {
            todoList: [
                { id: 'a', content: 'Do the thing', status: 'pending' }
            ]
        };

        const systemPrompt = manager.getSystemPrompt(mode, true, runtime);
        const bundle = manager.getPromptContextBundle(mode, runtime);

        expect(systemPrompt).toContain('System');
        expect(systemPrompt).toContain('TODO LIST');
        expect(systemPrompt).toContain('Do the thing');
        expect(systemPrompt).toContain('{{$TOOLS}}');
        expect(systemPrompt).not.toContain('should not appear');

        expect(bundle.historyPlacement).toBe('entry');
        expect(bundle.beforeHistoryMessages.map(message => message.role)).toEqual(['user', 'model']);
        expect(bundle.beforeHistoryMessages.map(message => message.parts?.[0]?.text)).toEqual([
            'Static user context',
            'Assistant prelude'
        ]);
        expect(bundle.afterHistoryMessages.map(message => message.role)).toEqual(['user']);
        expect(bundle.afterHistoryMessages.map(message => message.parts?.[0]?.text)).toEqual([
            expect.stringContaining('Dynamic')
        ]);
        expect(bundle.messages.map(message => message.role)).toEqual(['user', 'model', 'user']);
        expect(bundle.dynamicSnapshotBeforeHistoryMessages).toEqual([]);
        expect(bundle.dynamicSnapshotAfterHistoryMessages.map(message => message.parts?.[0]?.text)).toEqual([
            expect.stringContaining('Dynamic')
        ]);
        expect(bundle.dynamicSnapshotText).toContain('Do the thing');
        expect(bundle.dynamicSnapshotText).not.toContain('Static user context');
    });

    it('keeps legacy mode on traditional templates even when promptEntries exists', () => {
        const legacyMode: ResolvedPromptModeSnapshot = {
            ...mode,
            promptAssemblyMode: 'legacy',
            template: 'Legacy {{$ENVIRONMENT}}',
            dynamicTemplateEnabled: true,
            dynamicTemplate: 'Legacy dynamic {{$TODO_LIST}}'
        };
        setGlobalSettingsManager(createSettingsManagerMock(legacyMode));
        const manager = new PromptManager({ includeWorkspaceFiles: false });

        const systemPrompt = manager.getSystemPrompt(legacyMode, true, { todoList: [] });
        const bundle = manager.getPromptContextBundle(legacyMode, { todoList: [{ id: 'a', content: 'Legacy todo', status: 'pending' }] });

        expect(systemPrompt).toContain('Legacy');
        expect(systemPrompt).not.toContain('System {{$TODO_LIST}}');
        expect(bundle.historyPlacement).toBe('legacy');
        expect(bundle.beforeHistoryMessages).toHaveLength(1);
        expect(bundle.afterHistoryMessages).toHaveLength(0);
        expect(bundle.text).toContain('Legacy dynamic');
        expect(bundle.text).toContain('Legacy todo');
    });
});
