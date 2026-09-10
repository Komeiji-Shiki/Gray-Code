import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { WorkspaceDefinition, ToolDeclaration } from '@graycode/contracts';
import type { RuntimeTool, ToolContext, MemoryScopeDefinition } from '@graycode/core';
import { MemoryEngine } from '../../../../backend/modules/memory/MemoryEngine';
import { DEFAULT_MEMORY_CONFIG, type MemoryConfig } from '../../../../backend/modules/memory/types';
import { AsyncLock } from '../../../../backend/modules/memory/AsyncLock';
import type { MemoryToolHost } from '../../../../backend/tools/memory/host';
import { createMemoryWakeRuntime } from '../../../../backend/tools/memory/memory_wakeRuntime';
import { createMemoryNoteRuntime } from '../../../../backend/tools/memory/memory_noteRuntime';
import { createMemoryRecallRuntime } from '../../../../backend/tools/memory/memory_recallRuntime';
import { createMemoryCompressRuntime } from '../../../../backend/tools/memory/memory_compressRuntime';
import { createMemoryZoomRuntime } from '../../../../backend/tools/memory/memory_zoomRuntime';
import { createMemoryForgetRuntime } from '../../../../backend/tools/memory/memory_forgetRuntime';
import { createMemoryConfigRuntime } from '../../../../backend/tools/memory/memory_configRuntime';
import type { PlatformApplication } from '../application';
import { DatabaseMemoryStore } from './store';

function tools(host: MemoryToolHost) {
  return [createMemoryWakeRuntime(host).createMemoryWakeTool(), createMemoryNoteRuntime(host).createMemoryNoteTool(),
    createMemoryRecallRuntime(host).createMemoryRecallTool(), createMemoryCompressRuntime(host).createMemoryCompressTool(),
    createMemoryZoomRuntime(host).createMemoryZoomTool(), createMemoryForgetRuntime(host).createMemoryForgetTool(),
    createMemoryConfigRuntime(host).createMemoryConfigTool()];
}
const emptyHost: MemoryToolHost = { getGlobalMemoryManager: () => null, getMemoryManagerForWorkspace: async () => null,
  getMemoryManagerForTool: async () => null, getWorkspaceFolderName: () => null, workspaceUriToScopeKey: () => null };

/** 写入按作用域排队，读取依靠修订号保持一致；账号之间不共享内容或格式配置。 */
export class PlatformMemory {
  private readonly locks = new Map<string, AsyncLock>();
  constructor(private readonly app: PlatformApplication) {}
  async serialized<T>(actorId: string, action: () => Promise<T>, scopeId = this.scope(actorId).id): Promise<T> {
    let lock = this.locks.get(scopeId);
    if (!lock) { lock = new AsyncLock(); this.locks.set(scopeId, lock); }
    const release = await lock.acquire();
    try { return await action(); } finally { release(); }
  }
  scope(actorId: string, workspace?: WorkspaceDefinition): MemoryScopeDefinition {
    let workspaceKey = workspace?.directory.replaceAll('\\', '/');
    if (process.platform === 'win32') workspaceKey = workspaceKey?.toLowerCase();
    const id = createHash('sha256').update(JSON.stringify([actorId, workspaceKey ?? null])).digest('hex');
    return { id, actorId, ...(workspaceKey ? { workspaceKey } : {}) };
  }
  async engine(actorId: string, workspace?: WorkspaceDefinition, source?: Record<string, unknown>, storedScope?: MemoryScopeDefinition) {
    const actor = this.app.actor(actorId);
    if (!actor || actor.role === 'guest') throw new Error('此账号不能使用私人长期记忆。');
    if (storedScope && storedScope.actorId !== actorId) throw new Error('记忆作用域不属于当前账号。');
    if (workspace) this.app.workspace(actorId, workspace.id, ['workspace_read']);
    const configId = this.scope(actorId).id;
    const record = await this.app.storage.getVersionedRecord('memory-config', configId);
    let revision = record.revision;
    let config = { ...DEFAULT_MEMORY_CONFIG, ...(record.value as Partial<MemoryConfig> ?? {}) };
    const state = await this.app.storage.memoryState(storedScope ?? this.scope(actorId, workspace));
    let store!: DatabaseMemoryStore;
    const engine = new MemoryEngine({ store: getConfig => {
      store = new DatabaseMemoryStore(this.app.storage, storedScope ?? this.scope(actorId, workspace), getConfig, source, state.revision); return store;
    }, config: {
      initialize: async () => {},
      load: async () => ({ ...config }),
      save: async value => {
        const result = await this.app.storage.commitRecords([{ namespace: 'memory-config', id: configId,
          value, expectedRevision: revision }]);
        revision = result[0].revision; config = { ...value };
      },
    } }, config);
    return { engine, store };
  }
  declarations(): RuntimeTool[] {
    return tools(emptyHost).map(tool => ({ declaration: tool.declaration as ToolDeclaration,
      effects: args => tool.declaration.name === 'memory_note' || tool.declaration.name === 'memory_forget' ||
        tool.declaration.name === 'memory_compress' && args.summary !== undefined ||
        tool.declaration.name === 'memory_config' && ['wakeLines', 'entryChars', 'partChars', 'partLines'].some(key => Object.hasOwn(args, key))
        ? ['workspace_write'] : ['workspace_read'],
      execute: (args, context) => this.execute(tool.declaration.name, args, context),
    }));
  }
  private execute(name: string, args: Record<string, unknown>, context: ToolContext) {
    const execute = async () => {
      context.signal.throwIfAborted();
      const source = { origin: 'model_tool', runId: context.runId, conversationId: context.conversationId, toolCallId: context.toolCallId };
      const global = (await this.engine(context.actorId, undefined, source)).engine;
      const workspace = context.workspace;
      const uri = workspace ? pathToFileURL(workspace.directory).toString() : undefined;
      let local: MemoryEngine | undefined;
      const localEngine = async (requested: string, create = true) => {
        if (!workspace || requested !== uri) return null;
        if (!create && (await this.app.storage.memoryState(this.scope(context.actorId, workspace))).revision === 0) return null;
        local ??= (await this.engine(context.actorId, workspace, source)).engine;
        return local;
      };
      const host: MemoryToolHost = {
        getGlobalMemoryManager: () => global,
        getMemoryManagerForWorkspace: localEngine,
        getMemoryManagerForTool: async (requested, scope, create = true) => scope === 'global' || !requested && scope !== 'workspace'
          ? global : requested ? localEngine(requested, create) : null,
        getWorkspaceFolderName: requested => workspace && requested === uri ? workspace.name || path.basename(workspace.directory) : null,
        workspaceUriToScopeKey: requested => requested === uri ? this.scope(context.actorId, workspace).workspaceKey ?? null : null,
      };
      const tool = tools(host).find(tool => tool.declaration.name === name)!;
      const result = await tool.handler(args, { activeWorkspaceUri: uri });
      return { success: result.success, data: result.data, error: result.error };
    };
    const mutation = name === 'memory_note' || name === 'memory_forget' || name === 'memory_compress' && args.summary !== undefined ||
      name === 'memory_config' && ['wakeLines', 'entryChars', 'partChars', 'partLines'].some(key => Object.hasOwn(args, key));
    if (!mutation) return execute();
    const target = name === 'memory_config' || args.scope === 'global' ? undefined : context.workspace;
    return this.serialized(context.actorId, execute, this.scope(context.actorId, target).id);
  }
}
