import { workspaceForRoot, workspaceRoots } from '../workspace/paths';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import type { PlatformApplication } from '../application';
import type { ProductSettingsDraft } from '../settings/product';
import { MemoryEngine } from '../../../../backend/modules/memory/MemoryEngine';
import { DEFAULT_MEMORY_CONFIG, type MemoryConfig } from '../../../../backend/modules/memory/types';

export function memoryUiHandlers(app: PlatformApplication, actorId: string, draft: ProductSettingsDraft) {
  const workspaces = () => app.settings.snapshot().settings.workspaces.flatMap(workspace => workspaceRoots(workspace).map(root => workspaceForRoot(workspace, root.directory)));
  const scope = async (data: Record<string, any>) => {
    if (!data.workspaceUri) return app.memory.scope(actorId);
    const directory = fileURLToPath(String(data.workspaceUri));
    const key = (process.platform === 'win32' ? directory.toLowerCase() : directory).replaceAll('\\', '/');
    const workspace = workspaces().find(item => app.memory.scope(actorId, item).workspaceKey === key);
    if (workspace) return app.memory.scope(actorId, workspace);
    const stored = (await app.storage.memoryScopes(actorId)).find(item => item.workspaceKey === key);
    if (!stored) throw new Error('未找到此工作区的记忆作用域。');
    return stored;
  };
  const runtimeConfig = async () => {
    if (!draft.memoryConfig || !draft.memoryConfig.dirty) {
      const scopeId = app.memory.scope(actorId).id;
      const record = await app.storage.getVersionedRecord('memory-config', scopeId);
      draft.memoryConfig = { scopeId, value: { ...DEFAULT_MEMORY_CONFIG, ...(record.value as Partial<MemoryConfig> ?? {}) },
        expectedRevision: record.revision, dirty: false };
    }
    return draft.memoryConfig;
  };
  const operation = (action: (data: Record<string, any>) => Promise<unknown>) => action;
  const mutation = (action: 'update' | 'delete' | 'undo') => operation(async data => {
    const target = await scope(data);
    return app.memory.serialized(actorId, async () => {
    const state = await app.storage.memoryState(target);
    if (!Number.isSafeInteger(data.expectedRevision) || state.revision !== data.expectedRevision)
      throw new Error('记忆已改变，请刷新列表后再操作。');
    const { engine, store } = await app.memory.engine(actorId, undefined, { origin: 'user_interface', action }, target);
    if (action === 'update') await engine.updateEntry(data.id, data.text);
    else if (action === 'undo') await store.write({ type: 'undo', revision: data.expectedRevision }, data.expectedRevision);
    else await engine.deleteEntries(Array.isArray(data.ids) ? data.ids : [data.id]);
    return { success: true, revision: (await app.storage.memoryState(target)).revision };
    }, target.id);
  });
  return {
    listMemoryScopes: operation(async () => {
      const stored = await app.storage.memoryScopes(actorId);
      const scopes = new Map<string, { uri: string; name: string; fsPath: string; hasData: boolean }>();
      for (const workspace of workspaces()) {
        const key = app.memory.scope(actorId, workspace).workspaceKey!;
        scopes.set(key, { uri: pathToFileURL(workspace.directory).toString(), name: workspace.name,
          fsPath: workspace.directory, hasData: stored.some(item => item.workspaceKey === key && item.length > 0) });
      }
      for (const item of stored) if (item.workspaceKey && !scopes.has(item.workspaceKey))
        scopes.set(item.workspaceKey, { uri: pathToFileURL(item.workspaceKey).toString(), name: path.basename(item.workspaceKey), fsPath: item.workspaceKey, hasData: item.length > 0 });
      return { scopes: [...scopes.values()] };
    }),
    getMemoryConfig: operation(async data => { await scope(data); return { ...draft.settings.getMemoryConfig(), ...(await runtimeConfig()).value }; }),
    updateMemoryConfig: operation(async data => {
      await scope(data); const pending = await runtimeConfig();
      const { store } = await app.memory.engine(actorId);
      const validator = new MemoryEngine({ store: () => store, config: { initialize: async () => {}, load: async () => pending.value,
        save: async value => { pending.value = value; pending.dirty = true; draft.dirty = true; } } }, pending.value);
      await validator.updateConfig(data.config ?? {});
      if (!data.workspaceUri) await draft.settings.updateMemoryConfig(data.config ?? {});
      return { success: true };
    }),
    getMemoryEntries: operation(async data => {
      const target = await scope(data);
      const limit = Math.min(Number.isInteger(data.limit) && data.limit > 0 ? data.limit : 5000, 10000);
      const { store } = await app.memory.engine(actorId, undefined, undefined, target);
      const state = await store.state();
      const entries = await store.logSlice(0, Math.min(limit, state.length));
      return { entries, total: state.length, truncated: entries.length < state.length, initialized: true, revision: state.revision };
    }),
    addMemoryEntry: operation(async data => {
      const target = await scope(data);
      return app.memory.serialized(actorId, async () => {
        const { engine } = await app.memory.engine(actorId, undefined, { origin: 'user_interface', action: 'append' }, target);
        const result = await engine.note(String(data.text ?? ''));
        return { success: true, id: result.id };
      }, target.id);
    }),
    updateMemoryEntry: mutation('update'), deleteMemoryEntry: mutation('delete'), deleteMemoryEntries: mutation('delete'),
    'memory.undo': mutation('undo'),
    'memory.revisions': operation(async data => ({ revisions: await app.storage.memoryRevisions(await scope(data), data.before) })),
  };
}
