/**
 * LimCode - Memory 模块
 *
 * OptMem 风格永久记忆系统。
 *
 * 记忆作用域：
 * - 全局记忆（<dataPath>/memory）：无工作区时的默认记忆，行为与旧版本一致。
 * - 工作区记忆（<dataPath>/memory-workspaces/<hash>/）：每个工作区一套独立
 *   的 LOG/TREE/config 存储，按工作区隔离；工具调用时经 ToolContext 注入的
 *   activeWorkspaceUri 路由，无工作区时回退全局记忆。
 */

import * as path from 'path';
import { createHash } from 'crypto';
import * as fs from 'fs';

import { MemoryManager } from './MemoryManager';

export {
    MemoryManager,
} from './MemoryManager';

export type {
    LogEntry,
    WakeBlock,
    WakeResult,
    NoteResult,
    RecallResult,
    CompressResult,
    ZoomResult,
    NapPrompt,
    MemoryConfig,
} from './types';

export {
    DEFAULT_MEMORY_CONFIG,
    LOG_REC,
    TREE_REC,
    RAW_MAX,
    MEMORY_TOOL_NAMES,
    isMemoryToolName,
} from './types';

// ─── 单例访问器 ──────────────────────────────────

let _instance: import('./MemoryManager').MemoryManager | null = null;

/** 设置全局 MemoryManager 实例 */
export function setGlobalMemoryManager(manager: import('./MemoryManager').MemoryManager): void {
    _instance = manager;
}

/** 获取全局 MemoryManager 实例 */
export function getGlobalMemoryManager(): import('./MemoryManager').MemoryManager | null {
    return _instance;
}

/**
 * 初始化全局 MemoryManager（永久记忆系统）。
 *
 * VS Code 扩展（ChatViewProvider）与 Electron 桌面版（BackendHost）共用同一套
 * 初始化流程：在 <dataPath>/memory 下创建 LOG/TREE 存储、加载运行时配置并注册
 * 全局单例。提取为共享助手避免两宿主复制粘贴漂移。
 */
export async function initMemoryManager(dataPath: string): Promise<import('./MemoryManager').MemoryManager> {
    const memoryPath = path.join(dataPath, 'memory');
    const manager = new MemoryManager(memoryPath);
    await manager.init();
    await manager.loadConfig();
    setGlobalMemoryManager(manager);
    setWorkspaceMemoryBaseDir(path.join(dataPath, 'memory-workspaces'));
    return manager;
}

// ─── 工作区绑定记忆注册表 ──────────────────────────────

const WIN32 = process.platform === 'win32';

/** 工作区记忆存储根目录（<dataPath>/memory-workspaces） */
let _workspaceBaseDir: string | null = null;

/** scopeKey -> MemoryManager 实例（含未就绪的初始化 Promise 兜底） */
const _workspaceInstances = new Map<string, import('./MemoryManager').MemoryManager>();
const _workspaceInitPromises = new Map<string, Promise<import('./MemoryManager').MemoryManager | null>>();

/** 设置工作区记忆存储根目录（由 initMemoryManager 调用） */
export function setWorkspaceMemoryBaseDir(dir: string): void {
    _workspaceBaseDir = dir;
}

/** 规范化工作区 key：Windows 大小写不敏感 + 统一正斜杠 */
export function normalizeWorkspaceKey(fsPath: string): string {
    let p = fsPath.replace(/\\/g, '/');
    if (WIN32) p = p.toLowerCase();
    return p;
}

/**
 * 把工作区 URI（file:///... 或 file:///C%3A/... 编码形式）解析为 scope key。
 * 解析失败时返回 null（调用方回退全局记忆）。
 */
export function workspaceUriToScopeKey(uri: string): string | null {
    if (!uri || typeof uri !== 'string') return null;
    try {
        let fsPath = uri;
        if (uri.startsWith('file://')) {
            // file:///C%3A/Users/... -> /C:/Users/... -> C:/Users/...
            let p = decodeURIComponent(uri.slice('file://'.length));
            if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
            fsPath = p.replace(/\//g, path.sep);
        }
        if (!fsPath) return null;
        return normalizeWorkspaceKey(fsPath);
    } catch {
        return null;
    }
}

/** 由 scope key 生成目录名（哈希，避免路径中非法字符/过长） */
function scopeKeyToDirName(scopeKey: string): string {
    return createHash('sha256').update(scopeKey).digest('hex').slice(0, 16);
}

/** 工作区记忆目录路径（不存在时返回 null） */
function workspaceMemoryDir(scopeKey: string): string | null {
    if (!_workspaceBaseDir) return null;
    return path.join(_workspaceBaseDir, scopeKeyToDirName(scopeKey));
}

/**
 * 获取指定工作区的 MemoryManager 实例（惰性创建并持久化 scope 元信息）。
 * 工作区 URI 缺失/不可解析时返回 null，由调用方回退全局记忆。
 */
export async function getMemoryManagerForWorkspace(workspaceUri: string): Promise<import('./MemoryManager').MemoryManager | null> {
    const scopeKey = workspaceUriToScopeKey(workspaceUri);
    if (!scopeKey) return null;
    const existing = _workspaceInstances.get(scopeKey);
    if (existing) return existing;
    const pending = _workspaceInitPromises.get(scopeKey);
    if (pending) return pending;

    const initPromise = (async () => {
        const dir = workspaceMemoryDir(scopeKey);
        if (!dir) return null;
        await fs.promises.mkdir(dir, { recursive: true });
        // 持久化 scope 元信息：供设置页枚举工作区记忆时展示名称
        const metaPath = path.join(dir, 'scope.json');
        try {
            const raw = await fs.promises.readFile(metaPath, 'utf-8');
            const meta = JSON.parse(raw);
            if (meta.fsPath !== uriToFsPathForMeta(scopeKey)) {
                await fs.promises.writeFile(metaPath, JSON.stringify({ fsPath: uriToFsPathForMeta(scopeKey), name: path.basename(uriToFsPathForMeta(scopeKey)) }, null, 2), 'utf-8');
            }
        } catch {
            await fs.promises.writeFile(metaPath, JSON.stringify({ fsPath: uriToFsPathForMeta(scopeKey), name: path.basename(uriToFsPathForMeta(scopeKey)) }, null, 2), 'utf-8');
        }
        const manager = new MemoryManager(dir);
        await manager.init();
        await manager.loadConfig();
        _workspaceInstances.set(scopeKey, manager);
        return manager;
    })();

    _workspaceInitPromises.set(scopeKey, initPromise);
    try {
        return await initPromise;
    } finally {
        _workspaceInitPromises.delete(scopeKey);
    }
}

/** 由 scope key 反解展示用 fsPath（仅用于元信息，大小写不保证与原始输入一致） */
function uriToFsPathForMeta(scopeKey: string): string {
    return scopeKey.replace(/\//g, path.sep);
}

/**
 * 获取工作区文件夹名（basename，供工具输出标注用，如 wake 的工作区段头）。
 * 工作区 URI 缺失/不可解析时返回 null，由调用方回退为不带名字的标注。
 */
export function getWorkspaceFolderName(workspaceUri: string): string | null {
    const scopeKey = workspaceUriToScopeKey(workspaceUri);
    if (!scopeKey) return null;
    return path.basename(scopeKey.replace(/\//g, path.sep));
}

/**
 * 工具层取实例入口：按工具上下文注入的工作区路由到对应记忆实例，
 * 无工作区（或解析失败）时回退全局记忆（旧行为）。
 */
export async function getMemoryManagerForTool(workspaceUri?: string | null): Promise<import('./MemoryManager').MemoryManager | null> {
    if (workspaceUri) {
        const scoped = await getMemoryManagerForWorkspace(workspaceUri);
        if (scoped) return scoped;
    }
    return getGlobalMemoryManager();
}

export interface WorkspaceMemoryScope {
    /** 工作区 URI（file:/// 形式，可被前端直接使用） */
    uri: string;
    /** 文件夹名 */
    name: string;
    /** 文件系统路径 */
    fsPath: string;
    /** 是否已有记忆数据（存在 LOG.txt 或 TREE 目录） */
    hasData: boolean;
}

/** 枚举全部已存在的工作区记忆 scope（设置页分区展示用） */
export async function listWorkspaceMemoryScopes(): Promise<WorkspaceMemoryScope[]> {
    if (!_workspaceBaseDir) return [];
    const out: WorkspaceMemoryScope[] = [];
    try {
        const entries = await fs.promises.readdir(_workspaceBaseDir, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const dir = path.join(_workspaceBaseDir, entry.name);
            let fsPath = '';
            let name = entry.name;
            try {
                const meta = JSON.parse(await fs.promises.readFile(path.join(dir, 'scope.json'), 'utf-8'));
                if (typeof meta?.fsPath === 'string' && meta.fsPath) {
                    fsPath = meta.fsPath;
                    name = meta.name || path.basename(fsPath);
                }
            } catch {
                continue; // 无元信息的目录不是工作区记忆 scope
            }
            if (!fsPath) continue;
            const hasLog = await fs.promises.stat(path.join(dir, 'LOG.txt')).then(() => true).catch(() => false);
            const hasTree = await fs.promises.stat(path.join(dir, 'TREE')).then(() => true).catch(() => false);
            out.push({
                uri: uriFromFsPath(fsPath),
                name,
                fsPath,
                hasData: hasLog || hasTree
            });
        }
    } catch (e: any) {
        if (e?.code !== 'ENOENT') console.error('[memory] listWorkspaceMemoryScopes failed:', e);
    }
    return out;
}

/** 由 fsPath 构造 file:/// URI（与 vscode.Uri.file().toString() 同构） */
function uriFromFsPath(fsPath: string): string {
    const withSlashes = fsPath.replace(/\\/g, '/');
    const encoded = withSlashes.split('/').map(seg => encodeURIComponent(seg)).join('/');
    return `file://${encoded.startsWith('/') ? encoded : '/' + encoded}`;
}
