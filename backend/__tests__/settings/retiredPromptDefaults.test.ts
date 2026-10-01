/**
 * 内置提示词默认值的升级与模板约定。
 *
 * - 设置里保存着旧版默认文本时，读取结果换成当前默认值；改过的内容保持原样。
 * - 当前默认值本身不在退役列表里（否则改了默认值却忘了登记旧哈希时，测试能及时发现）。
 * - 各模式模板只描述该模式实际拥有的工具能力。
 */

import { SettingsManager } from '../../modules/settings/SettingsManager';
import {
    CODE_MODE_TEMPLATE,
    DESIGN_MODE_TEMPLATE,
    PLAN_MODE_TEMPLATE,
    ASK_MODE_TEMPLATE,
    REVIEW_MODE_TEMPLATE,
    DEFAULT_DYNAMIC_CONTEXT_TEMPLATE,
    DEFAULT_SUMMARIZE_CONFIG
} from '../../modules/settings/types';
import { DEFAULT_MEMORY_PROMPT, DYNAMIC_CONTEXT_PREAMBLE } from '../../../shared/defaultPromptTemplates';
import { retiredPromptKind } from '../../modules/settings/retiredPromptDefaults';
import { createMemorySettingsStorage } from '../__fixtures__/settingsFixtures';
import { RETIRED_PROMPT_SAMPLES } from '../__fixtures__/retiredPromptSamples';

async function managerWith(toolsConfig: Record<string, unknown>) {
    const manager = new SettingsManager(createMemorySettingsStorage({ toolsConfig }));
    await manager.initialize();
    return manager;
}

describe('retired prompt defaults', () => {
    test('current defaults are not registered as retired', () => {
        for (const text of [CODE_MODE_TEMPLATE, DESIGN_MODE_TEMPLATE, PLAN_MODE_TEMPLATE, ASK_MODE_TEMPLATE, REVIEW_MODE_TEMPLATE,
            DEFAULT_DYNAMIC_CONTEXT_TEMPLATE, DEFAULT_MEMORY_PROMPT, DEFAULT_SUMMARIZE_CONFIG.summarizePrompt, DEFAULT_SUMMARIZE_CONFIG.autoSummarizePrompt]) {
            expect(retiredPromptKind(text)).toBeUndefined();
        }
    });

    test('recognizes the previous release defaults, including CRLF copies', () => {
        expect(retiredPromptKind(RETIRED_PROMPT_SAMPLES.code)).toBe('code');
        expect(retiredPromptKind(RETIRED_PROMPT_SAMPLES.code.replace(/\n/g, '\r\n') + '\n')).toBe('code');
        expect(retiredPromptKind(RETIRED_PROMPT_SAMPLES.design)).toBe('design');
        expect(retiredPromptKind(RETIRED_PROMPT_SAMPLES.dynamic)).toBe('dynamic');
        expect(retiredPromptKind(RETIRED_PROMPT_SAMPLES.code + '\nMy own rule.')).toBeUndefined();
    });

    test('untouched saved mode templates read back as the current defaults', async () => {
        const manager = await managerWith({ system_prompt: { currentModeId: 'code', modes: {
            code: { id: 'code', name: 'Code', template: RETIRED_PROMPT_SAMPLES.code, dynamicTemplateEnabled: true, dynamicTemplate: RETIRED_PROMPT_SAMPLES.dynamic },
            design: { id: 'design', name: 'Design', template: RETIRED_PROMPT_SAMPLES.design, dynamicTemplateEnabled: true, dynamicTemplate: RETIRED_PROMPT_SAMPLES.dynamic },
            // 用户复制出的自定义模式仍是旧 Code 默认值时同样升级；改过的模式保持原样。
            copy: { id: 'copy', name: 'Copy', template: RETIRED_PROMPT_SAMPLES.code, dynamicTemplateEnabled: true, dynamicTemplate: '' },
            custom: { id: 'custom', name: 'Custom', template: RETIRED_PROMPT_SAMPLES.code + '\nMy own rule.', dynamicTemplateEnabled: true, dynamicTemplate: 'Mine' }
        } } });
        const { modes } = manager.getSystemPromptConfig();
        const system = (id: string) => modes[id].promptEntries?.find(entry => entry.id === 'legacy-system-template')?.content;
        const dynamic = (id: string) => modes[id].promptEntries?.find(entry => entry.id === 'legacy-dynamic-context')?.content;

        expect(system('code')).toBe(CODE_MODE_TEMPLATE);
        expect(dynamic('code')).toBe(DEFAULT_DYNAMIC_CONTEXT_TEMPLATE);
        expect(system('design')).toBe(DESIGN_MODE_TEMPLATE);
        expect(system('copy')).toBe(CODE_MODE_TEMPLATE);
        expect(system('custom')).toBe(RETIRED_PROMPT_SAMPLES.code + '\nMy own rule.');
        expect(dynamic('custom')).toBe('Mine');
        // 转换前的原始内容仍完整保留，可以导出或恢复。
        expect(modes.code.legacyPrompt?.template).toBe(RETIRED_PROMPT_SAMPLES.code);
    });

    test('already converted entries with retired content are upgraded in place', async () => {
        const manager = await managerWith({ system_prompt: { currentModeId: 'code', modes: {
            code: { id: 'code', name: 'Code', template: '', promptAssemblyMode: 'entries', dynamicTemplateEnabled: false, dynamicTemplate: '', promptEntries: [
                { id: 'legacy-system-template', name: 'System', type: 'prompt', role: 'system', enabled: true, order: 0, content: RETIRED_PROMPT_SAMPLES.code },
                { id: 'chat-history', name: 'Chat History', type: 'chat_history', role: 'user', enabled: true, order: 1, content: '' },
                { id: 'mine', name: 'Mine', type: 'prompt', role: 'user', enabled: true, order: 2, content: 'Keep this.' }
            ] }
        } } });
        const entries = manager.getSystemPromptConfig().modes.code.promptEntries!;
        expect(entries.map(entry => entry.content)).toEqual([CODE_MODE_TEMPLATE, '', 'Keep this.']);
    });

    test('summary and memory prompts saved with old defaults follow the current defaults', async () => {
        const manager = await managerWith({
            summarize: { summarizePrompt: RETIRED_PROMPT_SAMPLES.summarize, autoSummarizePrompt: RETIRED_PROMPT_SAMPLES.autoSummarize },
            memory: { enabled: true, systemPrompt: RETIRED_PROMPT_SAMPLES.memory }
        });
        expect(manager.getSummarizeConfig()).toMatchObject({
            summarizePrompt: DEFAULT_SUMMARIZE_CONFIG.summarizePrompt,
            autoSummarizePrompt: DEFAULT_SUMMARIZE_CONFIG.autoSummarizePrompt
        });
        expect(manager.getMemoryConfig().systemPrompt).toBe('');

        const custom = await managerWith({ summarize: { summarizePrompt: 'Keep my wording.' }, memory: { systemPrompt: 'My memory rules.' } });
        expect(custom.getSummarizeConfig().summarizePrompt).toBe('Keep my wording.');
        expect(custom.getMemoryConfig().systemPrompt).toBe('My memory rules.');
    });
});

describe('built-in mode templates', () => {
    test('read-only modes do not offer edits or commands', () => {
        for (const template of [DESIGN_MODE_TEMPLATE, PLAN_MODE_TEMPLATE, ASK_MODE_TEMPLATE, REVIEW_MODE_TEMPLATE]) {
            expect(template).not.toMatch(/apply_diff|write_file|execute commands/);
            expect(template).toContain('Do not repeat a failed call with identical arguments');
        }
        expect(DESIGN_MODE_TEMPLATE).toContain('you cannot edit code or run commands');
        expect(ASK_MODE_TEMPLATE).toContain('you cannot edit files or run commands');
    });

    test('templates avoid shouting and keep the continuation protocol out of the code mode', () => {
        for (const template of [CODE_MODE_TEMPLATE, DESIGN_MODE_TEMPLATE, PLAN_MODE_TEMPLATE, ASK_MODE_TEMPLATE, REVIEW_MODE_TEMPLATE]) {
            expect(template).not.toMatch(/\*\*|IMPORTANT|MANDATORY|NEVER|\bSTOP\b/);
        }
        // progress_sync 的禁传字段清单只在 update_plan 说明和续接提示中维护。
        expect(CODE_MODE_TEMPLATE).not.toContain('sourceArtifactType, sourcePath, sourceContent');
        expect(CODE_MODE_TEMPLATE).toContain('continuationPrompt');
    });

    test('the dynamic context template starts with the shared preamble', () => {
        expect(DEFAULT_DYNAMIC_CONTEXT_TEMPLATE.startsWith(DYNAMIC_CONTEXT_PREAMBLE)).toBe(true);
    });
});
