import type { PromptMode, PromptEntry } from '../backend/modules/settings/types/promptTypes';

/** Convert only the active legacy templates. Original fields remain available for export/recovery. */
export function migratePromptPreset<T extends PromptMode>(mode: T, fallbackDynamicTemplate = ''): T {
    if (mode.promptAssemblyMode === 'entries') {
        return { ...mode, dynamicContextStrategy: 'preserve' };
    }
    // The legacy static renderer removed these placeholders; activating them during migration
    // would duplicate workspace context in the system prompt and change the cached prefix.
    const template = mode.template.replace(/\{\{\$(?:WORKSPACE_FILES|OPEN_TABS|ACTIVE_EDITOR|DIAGNOSTICS|PINNED_FILES)\}\}/g, '');
    const dynamicTemplate = mode.dynamicTemplate || fallbackDynamicTemplate;
    const entries: PromptEntry[] = [
        { id: 'legacy-system-template', name: '系统提示词', type: 'prompt', role: 'system', enabled: true, content: template, order: 0 },
        { id: 'chat-history', name: 'Chat History', type: 'chat_history', role: 'user', enabled: true, content: '', order: 1 },
        { id: 'legacy-dynamic-context', name: '动态上下文', type: 'prompt', role: 'user', enabled: mode.dynamicTemplateEnabled !== false,
          content: dynamicTemplate.trim() ? dynamicTemplate : LEGACY_DEFAULT_DYNAMIC_TEMPLATE, order: 2 },
    ];
    return { ...mode, promptAssemblyMode: 'entries', dynamicContextStrategy: 'preserve', promptEntries: entries,
        legacyPrompt: mode.legacyPrompt ?? { template: mode.template, dynamicTemplate: mode.dynamicTemplate,
            dynamicTemplateEnabled: mode.dynamicTemplateEnabled, promptEntries: mode.promptEntries } };
}

const LEGACY_DEFAULT_DYNAMIC_TEMPLATE = `This is the current turn's dynamic context information you can use. It may change between turns. Continue with the previous task if the information is not needed and ignore it.

Current Time: {{$CURRENT_TIME}}

{{$TODO_LIST}}

{{$WORKSPACE_FILES}}

{{$OPEN_TABS}}

{{$ACTIVE_EDITOR}}

{{$DIAGNOSTICS}}

{{$PINNED_FILES}}`;
