/** 共享设置的策略迁移、重载通知与技能标识校验。 */

import { SettingsManager } from '../../../backend/modules/settings/SettingsManager';
import { createMemorySettingsStorage, createSettingsManager } from '../__fixtures__/settingsFixtures';
import {
    BUILTIN_MODE_TOOL_POLICIES,
    DEFAULT_SYSTEM_PROMPT_CONFIG,
    DESIGN_MODE_ID,
    PLAN_MODE_ID,
    ASK_MODE_ID,
    REVIEW_MODE_ID,
    DESIGN_PROMPT_MODE,
    PLAN_PROMPT_MODE,
    ASK_PROMPT_MODE,
    REVIEW_PROMPT_MODE,
    DEFAULT_MODE_ID,
    type PromptMode,
    type SettingsChangeEvent,
} from '../../../backend/modules/settings/types';
import { SkillsRuntime } from '../../../backend/modules/skills/SkillsRuntime';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCodeModeConfig(): any {
    return {
        toolsConfig: {
            system_prompt: {
                ...DEFAULT_SYSTEM_PROMPT_CONFIG,
            },
        },
    };
}

// ---------------------------------------------------------------------------
// #20: SkillsRuntime.validateSkillId
// ---------------------------------------------------------------------------

describe('SkillsRuntime.validateSkillId (#20)', () => {
    test('accepts valid lowercase-hyphen ids', () => {
        expect(SkillsRuntime.validateSkillId('my-skill')).toBe(true);
        expect(SkillsRuntime.validateSkillId('a')).toBe(true);
        expect(SkillsRuntime.validateSkillId('abc123')).toBe(true);
        expect(SkillsRuntime.validateSkillId('a-b-c')).toBe(true);
        expect(SkillsRuntime.validateSkillId('a'.repeat(64))).toBe(true);
    });

    test('rejects empty or non-string input', () => {
        expect(SkillsRuntime.validateSkillId('')).toBe(false);
        expect(SkillsRuntime.validateSkillId(null as any)).toBe(false);
        expect(SkillsRuntime.validateSkillId(undefined as any)).toBe(false);
    });

    test('rejects ids that start or end with hyphen', () => {
        expect(SkillsRuntime.validateSkillId('-start')).toBe(false);
        expect(SkillsRuntime.validateSkillId('end-')).toBe(false);
    });

    test('rejects consecutive hyphens', () => {
        expect(SkillsRuntime.validateSkillId('a--b')).toBe(false);
    });

    test('rejects uppercase or special chars', () => {
        expect(SkillsRuntime.validateSkillId('MySkill')).toBe(false);
        expect(SkillsRuntime.validateSkillId('my_skill')).toBe(false);
        expect(SkillsRuntime.validateSkillId('my skill')).toBe(false);
        expect(SkillsRuntime.validateSkillId('../evil')).toBe(false);
        expect(SkillsRuntime.validateSkillId('a\\b')).toBe(false);
    });

    test('rejects ids longer than 64 chars', () => {
        expect(SkillsRuntime.validateSkillId('a'.repeat(65))).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// #19: Built-in mode toolPolicy not force-rolled back
// ---------------------------------------------------------------------------

describe('Built-in mode toolPolicy customization (#19)', () => {
    test('preserves user-customized toolPolicy across getter reads', async () => {
        const manager = createSettingsManager(makeCodeModeConfig());
        await manager.initialize();

        // Customize design mode toolPolicy
        const customPolicy = ['read_file', 'list_files'];
        const customizedMode: PromptMode = {
            ...DESIGN_PROMPT_MODE,
            toolPolicy: customPolicy,
        };
        await manager.savePromptMode(customizedMode);

        // Multiple reads should preserve customized toolPolicy
        for (let i = 0; i < 3; i++) {
            const config = manager.getSystemPromptConfig();
            const designMode = config.modes?.[DESIGN_MODE_ID];
            expect(designMode?.toolPolicy).toEqual(customPolicy);
            expect(designMode?.toolPolicyCustomized).toBe(true);
        }
    });

    test('fills built-in default for non-customized modes via normalize', async () => {
        const manager = createSettingsManager(makeCodeModeConfig());
        await manager.initialize();

        // Read design mode — should get built-in default via normalize
        const config = manager.getSystemPromptConfig();
        const designMode = config.modes?.[DESIGN_MODE_ID];

        // The getter doesn't mutate, but resolvePromptMode uses built-in default
        const resolved = manager.resolvePromptMode(DESIGN_MODE_ID);
        expect(resolved.toolPolicy).toEqual(BUILTIN_MODE_TOOL_POLICIES[DESIGN_MODE_ID]);
    });

    test('migration sets toolPolicy for non-customized built-in modes', async () => {
        // Create a config with built-in modes but no toolPolicyCustomized flag
        const stored = {
            toolsConfig: {
                system_prompt: {
                    currentModeId: DEFAULT_MODE_ID,
                    modes: {
                        [DESIGN_MODE_ID]: {
                            ...DESIGN_PROMPT_MODE,
                            toolPolicy: undefined,
                            toolPolicyCustomized: undefined,
                        },
                    },
                },
            },
        };
        const manager = createSettingsManager(stored);
        await manager.initialize();

        // After migration, built-in mode should have default toolPolicy and be marked
        const settings = manager.getSettings();
        const designMode = settings.toolsConfig?.system_prompt?.modes?.[DESIGN_MODE_ID];
        expect(designMode?.toolPolicy).toEqual(BUILTIN_MODE_TOOL_POLICIES[DESIGN_MODE_ID]);
        expect(designMode?.toolPolicyCustomized).toBe(false);
    });

    test('migration does not overwrite customized modes', async () => {
        const customPolicy = ['read_file'];
        const stored = {
            toolsConfig: {
                system_prompt: {
                    currentModeId: DEFAULT_MODE_ID,
                    modes: {
                        [DESIGN_MODE_ID]: {
                            ...DESIGN_PROMPT_MODE,
                            toolPolicy: customPolicy,
                            toolPolicyCustomized: true,
                        },
                    },
                },
            },
        };
        const manager = createSettingsManager(stored);
        await manager.initialize();

        const settings = manager.getSettings();
        const designMode = settings.toolsConfig?.system_prompt?.modes?.[DESIGN_MODE_ID];
        expect(designMode?.toolPolicy).toEqual(customPolicy);
        expect(designMode?.toolPolicyCustomized).toBe(true);
    });

    test('runtime resolves built-in default when toolPolicy is not customized', async () => {
        const manager = createSettingsManager(makeCodeModeConfig());
        await manager.initialize();

        // Resolve ask mode — should fall back to built-in default
        const resolved = manager.resolvePromptMode(ASK_MODE_ID);
        expect(resolved.toolPolicy).toEqual(BUILTIN_MODE_TOOL_POLICIES[ASK_MODE_ID]);
    });
});

// ---------------------------------------------------------------------------
// #22: reloadAndNotify fires change events
// ---------------------------------------------------------------------------

describe('reloadAndNotify (#22)', () => {
    test('fires SettingsChangeEvent of type full after reload', async () => {
        const manager = createSettingsManager(makeCodeModeConfig());
        await manager.initialize();

        const events: SettingsChangeEvent[] = [];
        manager.addChangeListener((event) => {
            events.push(event);
        });

        await manager.reloadAndNotify();

        expect(events.length).toBe(1);
        expect(events[0].type).toBe('full');
        expect(events[0].settings).toBeDefined();
        expect(events[0].oldValue).toBeDefined();
        expect(events[0].newValue).toBeDefined();
    });

    test('reloads settings from storage', async () => {
        const storage = createMemorySettingsStorage(makeCodeModeConfig());
        const manager = new SettingsManager(storage);
        await manager.initialize();

        // Modify storage directly
        storage.value.toolsConfig.system_prompt.currentModeId = 'design';
        await manager.reloadAndNotify();

        const config = manager.getSystemPromptConfig();
        expect(config.currentModeId).toBe('design');
    });
});

// ---------------------------------------------------------------------------
// BUILTIN_MODE_TOOL_POLICIES constant mapping
// ---------------------------------------------------------------------------

describe('BUILTIN_MODE_TOOL_POLICIES', () => {
    test('maps all four built-in modes (code excluded)', () => {
        expect(BUILTIN_MODE_TOOL_POLICIES[DESIGN_MODE_ID]).toBeDefined();
        expect(BUILTIN_MODE_TOOL_POLICIES[PLAN_MODE_ID]).toBeDefined();
        expect(BUILTIN_MODE_TOOL_POLICIES[ASK_MODE_ID]).toBeDefined();
        expect(BUILTIN_MODE_TOOL_POLICIES[REVIEW_MODE_ID]).toBeDefined();
        // Code mode is not in the map (no built-in toolPolicy restriction)
        expect(BUILTIN_MODE_TOOL_POLICIES[DEFAULT_MODE_ID]).toBeUndefined();
    });

    test('matches the prompt mode definitions', () => {
        expect(BUILTIN_MODE_TOOL_POLICIES[DESIGN_MODE_ID]).toEqual(DESIGN_PROMPT_MODE.toolPolicy);
        expect(BUILTIN_MODE_TOOL_POLICIES[PLAN_MODE_ID]).toEqual(PLAN_PROMPT_MODE.toolPolicy);
        expect(BUILTIN_MODE_TOOL_POLICIES[ASK_MODE_ID]).toEqual(ASK_PROMPT_MODE.toolPolicy);
        expect(BUILTIN_MODE_TOOL_POLICIES[REVIEW_MODE_ID]).toEqual(REVIEW_PROMPT_MODE.toolPolicy);
    });
});
