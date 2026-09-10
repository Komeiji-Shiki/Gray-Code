import { migratePromptPreset } from '../../../shared/promptPresetMigration';
import { PromptAssembler, type PromptAssemblyHost } from '../../../backend/modules/prompt/PromptAssembler';
import { SettingsManager } from '../../../backend/modules/settings/SettingsManager';
import { deserializePromptContextCache } from '../../../backend/modules/prompt/promptContextCache';
import type { PromptMode } from '../../../backend/modules/settings/types';
import type { ModelInput } from '@graycode/contracts';
import { PlatformApplication } from '../../../apps/server/src/application';
import { ApplicationRouter } from '../../../apps/server/src/transport/router';
import { fixture } from './fixtures';

const legacy: PromptMode = { id: 'legacy', name: 'Legacy', template: 'Rules\n{{$WORKSPACE_FILES}}\n{{$ENVIRONMENT}}',
  dynamicTemplate: 'Turn\n{{$TODO_LIST}}', dynamicTemplateEnabled: true,
  promptEntries: [{ id: 'inactive', name: 'Inactive', content: 'MUST NOT APPEAR', role: 'system', enabled: true, order: 0 }] };

test('legacy conversion is idempotent, keeps original configuration, and ignores inactive entries', () => {
  const converted = migratePromptPreset(legacy);
  expect(converted.promptEntries?.map(entry => entry.content)).toEqual(['Rules\n\n{{$ENVIRONMENT}}', '', 'Turn\n{{$TODO_LIST}}']);
  expect(converted.legacyPrompt?.promptEntries).toEqual(legacy.promptEntries);
  expect(migratePromptPreset(converted)).toEqual(converted);
  expect(migratePromptPreset({ ...legacy, dynamicTemplateEnabled: false }).promptEntries?.at(-1)?.enabled).toBe(false);
  expect(legacy.promptAssemblyMode).toBeUndefined();
});

test('converted templates produce the same system and dynamic text with a host-independent assembler', async () => {
  const settings = new SettingsManager({ load: async () => null, save: async () => {} });
  await settings.initialize();
  const sections: PromptAssemblyHost['sections'] = {
    wrapSection: (name, text) => text ? `====\n\n${name}\n\n${text}` : '', cleanupEmptyLines: text => text.replace(/\n{3,}/g, '\n\n').trim(),
    getUserLanguage: () => 'zh-CN', generateStaticEnvironmentSection: () => 'Environment', generateContextBadgeFormatSection: () => '',
    generateMemorySection: () => '', generateFileTreeSection: () => '', generateOpenTabsSection: () => '', generateActiveEditorSection: () => '',
    generateDiagnosticsSection: () => '', generatePinnedFilesSection: () => '', getContext: () => ({}),
  };
  const assembler = new PromptAssembler({ settings: () => settings, workspacePaths: () => [], sections });
  const runtime = { todoList: [{ id: 'a', content: 'Existing task', status: 'pending' }] };
  const converted = migratePromptPreset(legacy);
  expect(assembler.getSystemPrompt(converted, true, runtime)).toBe(assembler.getSystemPrompt(legacy, true, runtime));
  const before = assembler.getPromptContextBundle(legacy, runtime);
  const after = assembler.getPromptContextBundle(converted, runtime);
  expect(after.text).toBe(before.text);
  expect(after.beforeHistoryMessages).toEqual([]);
  expect(after.afterHistoryMessages).toEqual(before.beforeHistoryMessages);
});

test('real application requests use selected presets and retain earlier turn snapshots', async () => {
  const f = await fixture(); await f.store.close();
  const inputs: ModelInput[] = [];
  const app = await PlatformApplication.open({ dataDirectory: f.data, models: { generate: async input => {
    inputs.push(input);
    return { role: 'model', parts: [{ text: 'Done' }] };
  } } });
  try {
    const draft = await app.product.draft();
    await draft.settings.savePromptMode(legacy);
    await app.product.save(draft);
    const router = new ApplicationRouter(app);
    const owner = { actorId: 'owner', clientId: 'presets' };
    const chat = await router.call(owner, 'conversations.create', { title: 'Presets' }) as { id: string };
    for (let turn = 0; turn < 2; turn++) {
      const run = await app.runtime.start({ actorId: 'owner', agentId: 'default', requestKey: `turn-${turn}`, conversationId: chat.id,
        promptModeId: 'legacy', message: { role: 'user', parts: [{ text: `Question ${turn}` }] } });
      expect((await app.runtime.wait(run.id))?.status).toBe('completed');
    }
    expect(inputs[0].systemPrompt).toContain('Rules');
    expect(inputs[0].systemPrompt).not.toContain('MUST NOT APPEAR');
    const snapshot = deserializePromptContextCache(inputs[1].messages[0].turnDynamicContext as string);
    expect(snapshot.afterHistoryMessages[0].parts[0].text).toBe('Turn');
    expect(inputs[1].messages[0].turnDynamicContextStrategy).toBe('preserve');
    expect(inputs[1].promptContext?.historyPlacement).toBe('entry');
  } finally { await app.close(); await f.cleanup(); }
});
