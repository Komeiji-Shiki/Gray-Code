import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { WorkspaceDefinition, ToolDeclaration } from '@graycode/contracts';
import type { RuntimeTool, ToolContext, MemoryScopeDefinition } from '@graycode/core';
import { MemoryEngine } from '../../../../backend/modules/memory/MemoryEngine';
import { DEFAULT_MEMORY_CONFIG, type MemoryConfig } from '../../../../backend/modules/memory/types';
import { AsyncLock } from '../../../../backend/modules/memory/AsyncLock';
import type { MemoryToolHost } from '../../../../backend/tools/memory/host';
import {
  createEngineeringLogTool,
  engineeringLogMutation,
  engineeringLogValidationSchema,
  ENGINEERING_LOG_LEGACY_NAMES,
  type EngineeringLogAction,
} from '../../../../backend/tools/memory/engineeringLog';
import type { PlatformApplication } from '../application';
import { mergedOperationEnabled } from '../settings/agent';
import { DatabaseMemoryStore } from './store';

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
    if (!actor || actor.role === 'guest') throw new Error('此账号不能使用工程日志。');
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
    return [{
      declaration: createEngineeringLogTool(emptyHost).declaration as ToolDeclaration,
      validationSchema: engineeringLogValidationSchema(emptyHost),
      approvalName: args => ENGINEERING_LOG_LEGACY_NAMES[args.action as EngineeringLogAction],
      effects: args => engineeringLogMutation(args) ? ['workspace_write'] : ['workspace_read'],
      execute: (args, context) => this.execute(args, context),
    }];
  }
  private execute(args: Record<string, unknown>, context: ToolContext) {
    const execute = async () => {
      context.signal.throwIfAborted();
      // 按操作的 deny 由运行器统一拒绝；这里只核对旧工具关闭后合并入口不能重新开放该操作。
      const legacyName = ENGINEERING_LOG_LEGACY_NAMES[args.action as EngineeringLogAction];
      if (!mergedOperationEnabled(this.app.product.runtimeSettings(), 'engineering_log', legacyName)) {
        return { success: false, code: 'PERMISSION_DENIED', error: `工程日志操作 ${args.action} 已禁用。` };
      }
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
      const result = await createEngineeringLogTool(host).handler(args, { activeWorkspaceUri: uri });
      return { success: result.success, data: result.data, error: result.error };
    };
    if (!engineeringLogMutation(args)) return execute();
    const target = args.action === 'config' || args.scope === 'global' ? undefined : context.workspace;
    return this.serialized(context.actorId, execute, this.scope(context.actorId, target).id);
  }
}
