import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fixture } from '../../../packages/core/tests/fixtures';
import { DatabaseMemoryStore } from '../../../apps/server/src/memory/store';
import { MemoryEngine } from '../../modules/memory/MemoryEngine';
import { DEFAULT_MEMORY_CONFIG, type MemoryConfig } from '../../modules/memory/types';
import type { MemoryToolHost } from '../../tools/memory/host';

/** 使用正式数据库存储，只把旧全局注册器替换为显式的测试宿主。 */
export async function memoryEngineFixture(config: Partial<MemoryConfig> = {}) {
    const storage = await fixture();
    let sharedConfig = { ...DEFAULT_MEMORY_CONFIG, ...config };
    let globalAvailable = true;
    let workspace: MemoryEngine | undefined;
    const workspaceUri = pathToFileURL(path.join(storage.root, 'workspace')).toString();
    const create = (id: string) => new MemoryEngine({
        store: getConfig => new DatabaseMemoryStore(storage.store, { id, actorId: 'owner' }, getConfig),
        config: {
            initialize: async () => {},
            load: async () => ({ ...sharedConfig }),
            save: async value => { sharedConfig = { ...value }; },
        },
    }, sharedConfig);
    const engine = create('memory-global');
    const workspaceEngine = async (uri: string, createIfMissing = true) => {
        if (uri !== workspaceUri) return null;
        if (!workspace && createIfMissing) {
            workspace = create('memory-workspace');
            await workspace.init();
        }
        return workspace ?? null;
    };
    const host: MemoryToolHost = {
        getGlobalMemoryManager: () => globalAvailable ? engine : null,
        getMemoryManagerForWorkspace: workspaceEngine,
        getMemoryManagerForTool: async (uri, scope, createIfMissing = true) =>
            scope === 'global' || !uri && scope !== 'workspace'
                ? globalAvailable ? engine : null
                : uri ? workspaceEngine(uri, createIfMissing) : null,
        getWorkspaceFolderName: uri => uri === workspaceUri ? 'workspace' : null,
        workspaceUriToScopeKey: uri => uri === workspaceUri ? 'memory-workspace' : null,
    };
    return {
        engine,
        host,
        workspaceUri,
        hasWorkspace: () => workspace !== undefined,
        setGlobalAvailable: (available: boolean) => { globalAvailable = available; },
        cleanup: storage.cleanup,
    };
}
