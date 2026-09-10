import type { MemoryEngine } from '../../modules/memory/MemoryEngine';

/** 各工具只选择已由宿主确认的记忆作用域，不从参数取得账号身份。 */
export interface MemoryToolHost {
    getGlobalMemoryManager(): MemoryEngine | null;
    getMemoryManagerForWorkspace(uri: string, createIfMissing?: boolean): Promise<MemoryEngine | null>;
    getMemoryManagerForTool(uri?: string, scope?: 'global' | 'workspace', createIfMissing?: boolean): Promise<MemoryEngine | null>;
    getWorkspaceFolderName(uri: string): string | null;
    workspaceUriToScopeKey(uri: string): string | null;
}
