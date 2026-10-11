/**
 * 测试共享 fixture：mock 系列 builder（createPromptManagerMock）。
 *
 * 这是测试共享 fixture，禁止在测试内复制。
 *
 * 收敛说明（模块化重构第六批）：
 * - createPromptManagerMock 原在 4 个测试中重复定义（完全同构：空 bundle + 3 个 jest.fn）。
 * - 注：createSettingsManagerMock 因首参语义（mode / pinnedFiles 数组）、
 *   dynamicContextStrategy 默认值（single / preserve）与方法集各不相同，属形状各异的 builder，
 *   按重构纪律不收敛，保留在各自测试内。
 */
import path from 'node:path';
import type { ReadFileHost } from '../../tools/file/readFileRuntime';
import type { FileDiscoveryOptions, FileLocation, FileWorkspace, SearchFileHost } from '../../tools/search/fileHost';
import { parseNamedWorkspacePath } from '../../tools/shared/workspacePathParsing';
import { DEFAULT_SEARCH_IN_FILES_CONFIG } from '../../modules/settings/types';

export function createPromptManagerMock() {
    const emptyBundle = {
        beforeHistoryMessages: [],
        afterHistoryMessages: [],
        dynamicSnapshotBeforeHistoryMessages: [],
        dynamicSnapshotAfterHistoryMessages: [],
        messages: [],
        dynamicSnapshotMessages: [],
        text: '',
        dynamicSnapshotText: '',
        historyPlacement: 'legacy' as const
    };
    return {
        getPromptContextBundle: jest.fn().mockReturnValue(emptyBundle),
        refreshAndGetPrompt: jest.fn().mockReturnValue('sys'),
        getSystemPrompt: jest.fn().mockReturnValue('sys')
    };
}

/** 文件工具测试直接注入运行时端口，路径前缀解析复用正式实现。 */
export function createFileToolHostMock() {
    let workspaces: FileWorkspace[] = [];
    const file = (fsPath: string): FileLocation => ({ fsPath: fsPath.replaceAll('\\', '/'), scheme: 'file' });
    const host = {
        getAllWorkspaces: () => workspaces,
        getWorkspaceRoot: () => workspaces[0]?.uri,
        parseWorkspacePath: (value: string) => parseNamedWorkspacePath(value, workspaces),
        resolveUriWithInfo: (value: string) => {
            const parsed = parseNamedWorkspacePath(value, workspaces);
            return parsed.workspace
                ? { uri: file(path.posix.join(parsed.workspace.uri.fsPath, parsed.relativePath)), workspace: parsed.workspace }
                : { error: parsed.error };
        },
        resolveFileToolPathWithInfo: () => ({ isOutsideWorkspace: false }),
        ensureOutsideWorkspaceAccessApproved: () => null,
        toRelativePath: (location: FileLocation, prefix = false) => {
            const workspace = workspaces.find(root => location.fsPath.startsWith(`${root.uri.fsPath}/`));
            if (!workspace) return location.fsPath;
            const relative = location.fsPath.slice(workspace.uri.fsPath.length + 1);
            return prefix ? `@${workspace.name}/${relative}` : relative;
        },
        joinPath: (root: FileLocation, relative: string) => file(path.posix.join(root.fsPath, relative)),
        file,
        stat: jest.fn(async (_file: unknown) => ({ size: 100, type: 1 })),
        readFile: jest.fn(async (_file: unknown): Promise<Uint8Array> => new Uint8Array()),
        findFiles: jest.fn(async (_root: FileLocation, _pattern: string, _exclude: string, _limit: number,
            _options?: FileDiscoveryOptions): Promise<FileLocation[]> => []),
        countLines: async () => undefined,
        findExcludePatterns: () => undefined,
        searchConfig: () => DEFAULT_SEARCH_IN_FILES_CONFIG,
        checkAccess: () => null,
        review: jest.fn(async (_input: Parameters<SearchFileHost['review']>[0]) => ({
            wasAccepted: true, wasInterrupted: false, pendingDiffId: 'test-diff'
        }))
    } satisfies SearchFileHost & ReadFileHost;
    return {
        host,
        setWorkspaces: (folders: Array<{ name: string; fsPath: string }>) => {
            workspaces = folders.map(folder => ({ name: folder.name, uri: file(folder.fsPath) }));
        }
    };
}
