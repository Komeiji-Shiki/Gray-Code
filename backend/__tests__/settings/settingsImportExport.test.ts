/**
 * Tests for settings import/export subsystem fixes:
 * - #15: VSCode settings merge strategy
 * - #16: Channel config id preservation
 * - #18: MACHINE_SCOPE_KEYS filtering
 * - #19: Built-in mode toolPolicy not force-rolled back
 * - #20: Skill id validation
 * - #21: defaultValue not exported
 * - #22: reloadAndNotify fires change events
 */

import { SettingsManager } from '../../../backend/modules/settings/SettingsManager';
import { createMemorySettingsStorage, createSettingsManager } from '../__fixtures__/settingsFixtures';
import {
    MACHINE_SCOPE_KEYS,
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
    CODE_PROMPT_MODE,
    DEFAULT_MODE_ID,
    type PromptMode,
    type SettingsChangeEvent,
} from '../../../backend/modules/settings/types';
import { SkillsManager } from '../../../backend/modules/skills/SkillsManager';
import { SettingsExporter, SETTINGS_EXPORT_KEYS } from '../../../backend/modules/settings/SettingsExporter';
import * as vscode from 'vscode';

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
// #20: SkillsManager.validateSkillId
// ---------------------------------------------------------------------------

describe('SkillsManager.validateSkillId (#20)', () => {
    test('accepts valid lowercase-hyphen ids', () => {
        expect(SkillsManager.validateSkillId('my-skill')).toBe(true);
        expect(SkillsManager.validateSkillId('a')).toBe(true);
        expect(SkillsManager.validateSkillId('abc123')).toBe(true);
        expect(SkillsManager.validateSkillId('a-b-c')).toBe(true);
        expect(SkillsManager.validateSkillId('a'.repeat(64))).toBe(true);
    });

    test('rejects empty or non-string input', () => {
        expect(SkillsManager.validateSkillId('')).toBe(false);
        expect(SkillsManager.validateSkillId(null as any)).toBe(false);
        expect(SkillsManager.validateSkillId(undefined as any)).toBe(false);
    });

    test('rejects ids that start or end with hyphen', () => {
        expect(SkillsManager.validateSkillId('-start')).toBe(false);
        expect(SkillsManager.validateSkillId('end-')).toBe(false);
    });

    test('rejects consecutive hyphens', () => {
        expect(SkillsManager.validateSkillId('a--b')).toBe(false);
    });

    test('rejects uppercase or special chars', () => {
        expect(SkillsManager.validateSkillId('MySkill')).toBe(false);
        expect(SkillsManager.validateSkillId('my_skill')).toBe(false);
        expect(SkillsManager.validateSkillId('my skill')).toBe(false);
        expect(SkillsManager.validateSkillId('../evil')).toBe(false);
        expect(SkillsManager.validateSkillId('a\\b')).toBe(false);
    });

    test('rejects ids longer than 64 chars', () => {
        expect(SkillsManager.validateSkillId('a'.repeat(65))).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// #18: MACHINE_SCOPE_KEYS definition
// ---------------------------------------------------------------------------

describe('MACHINE_SCOPE_KEYS (#18)', () => {
    it('contains proxy, storagePath and remoteControl', () => {
        expect(MACHINE_SCOPE_KEYS).toContain('proxy');
        expect(MACHINE_SCOPE_KEYS).toContain('storagePath');
        expect(MACHINE_SCOPE_KEYS).toContain('remoteControl');
    });

    it('is a readonly array of three entries', () => {
        expect(MACHINE_SCOPE_KEYS.length).toBe(3);
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
// #21: collectVSCodeSettings ignores defaultValue
// (Tested through internal logic — mock-dependent; covered by integration)
// This test validates the VSCode config inspection fallback chain principle.
// ---------------------------------------------------------------------------

describe('VSCode settings value resolution (#21)', () => {
    test('collectVSCodeSettings reads explicit scope values and excludes defaultValue', () => {
        const inspect = jest.fn((key: string) => {
            if (key === 'ui') {
                return {
                    globalValue: undefined,
                    workspaceValue: undefined,
                    workspaceFolderValue: { language: 'en' },
                    defaultValue: { language: 'zh-CN' },
                };
            }
            if (key === 'toolsEnabled') {
                return { defaultValue: ['read_file'] };
            }
            return undefined;
        });
        (vscode.workspace as any).getConfiguration = jest.fn(() => ({ inspect }));

        const exporter = Object.create(SettingsExporter.prototype) as SettingsExporter;
        const result = exporter.collectVSCodeSettings();

        expect(result.ui).toEqual({ language: 'en' });
        expect(result).not.toHaveProperty('toolsEnabled');
        expect(inspect).toHaveBeenCalledWith('ui');
    });
});

// ---------------------------------------------------------------------------
// #15 + #18 combined: import respects merge strategy + filters machine keys
// ---------------------------------------------------------------------------

describe('Import merge strategy (#15, #18)', () => {
    test('production export key list excludes all machine-scope keys', () => {
        for (const machineKey of MACHINE_SCOPE_KEYS) {
            expect(SETTINGS_EXPORT_KEYS).not.toContain(machineKey);
        }
        expect(SETTINGS_EXPORT_KEYS).toContain('toolsConfig');
        expect(SETTINGS_EXPORT_KEYS).toContain('checkForUpdates');
        // 回归保护：proxy 虽是 ALL_CONFIG_KEYS 成员（VSCodeSettingsStorage MACHINE_KEYS），
        // 但属于机器作用域，必须被 SETTINGS_EXPORT_KEYS 过滤掉。
        expect(SETTINGS_EXPORT_KEYS).not.toContain('proxy');
        expect(SETTINGS_EXPORT_KEYS).not.toContain('storagePath');
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
