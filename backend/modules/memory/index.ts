/**
 * GrayCode - Memory 模块
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

/** 记忆作用域：全局（跨工作区共享）或当前工作区 */
export type MemoryScope = 'global' | 'workspace';

// ─── 单例访问器 ──────────────────────────────────

let _instance: import('./MemoryManager').MemoryManager | null = null;

/** 设置全局 MemoryManager 实例 */
export function setGlobalMemoryManager(manager: import('./MemoryManager').MemoryManager | null): void {
    _instance = manager;
}

/** 获取全局 MemoryManager 实例 */
export function getGlobalMemoryManager(): import('./MemoryManager').MemoryManager | null {
    return _instance;
}

/**
 * 初始化全局 MemoryManager（永久记忆系统）。
 *
 * 在 <dataPath>/memory 下创建 LOG/TREE 存储、加载运行时配置并注册全局单例，
 * 同时设置工作区记忆存储根目录（<dataPath>/memory-workspaces）。
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

/** scopeKey -> 只读 MemoryManager 实例（createIfMissing=false 时复用，含已加载 config） */
const _workspaceReadonlyInstances = new Map<string, import('./MemoryManager').MemoryManager>();

/** scopeKey -> 只读初始化中的 Promise（createIfMissing=false 并发去重，防同一目录双实例） */
const _workspaceReadonlyInitPromises = new Map<string, Promise<import('./MemoryManager').MemoryManager | null>>();

/** 设置工作区记忆存储根目录（由 initMemoryManager 调用） */
export function setWorkspaceMemoryBaseDir(dir: string | null): void {
    _workspaceBaseDir = dir;
    // 存储根目录变更后旧实例仍指向旧路径：全部失效，下次访问按新路径重建
    _workspaceInstances.clear();
    _workspaceInitPromises.clear();
    _workspaceReadonlyInstances.clear();
    _workspaceReadonlyInitPromises.clear();
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

/** 由 scope key 反解展示用 fsPath（仅用于元信息，大小写不保证与原始输入一致） */
function uriToFsPathForMeta(scopeKey: string): string {
    return scopeKey.replace(/\//g, path.sep);
}

/**
 * 获取指定工作区的 MemoryManager 实例（惰性创建并持久化 scope 元信息）。
 *
 * createIfMissing 为 false 时（只读工具 wake/recall/zoom 使用）：工作区目录不存在
 * 则直接返回 null，不创建目录、不写 scope.json，避免只读访问产生磁盘副作用。
 * 工作区 URI 缺失/不可解析时返回 null，由调用方回退全局记忆。
 */
export async function getMemoryManagerForWorkspace(
    workspaceUri: string,
    createIfMissing = true
): Promise<import('./MemoryManager').MemoryManager | null> {
    const scopeKey = workspaceUriToScopeKey(workspaceUri);
    if (!scopeKey) return null;
    const existing = _workspaceInstances.get(scopeKey);
    if (existing) return existing;
    const pending = _workspaceInitPromises.get(scopeKey);
    if (pending) return pending;

    if (!createIfMissing) {
        // 只读访问：目录不存在时不创建、不写 scope.json
        const dir = workspaceMemoryDir(scopeKey);
        if (!dir) return null;
        try {
            await fs.promises.stat(dir);
        } catch {
            return null;
        }
        // 复用已缓存的只读实例（含已加载 config）：避免每次只读访问都新建实例 + loadConfig
        const readonly = _workspaceReadonlyInstances.get(scopeKey);
        if (readonly) return readonly;
        // 并发只读访问共享同一个初始化 promise：否则两个只读调用会各自
        // new MemoryManager + loadConfig，产生同一目录两个实例（各自独立 AsyncLock）
        const readonlyPending = _workspaceReadonlyInitPromises.get(scopeKey);
        if (readonlyPending) return readonlyPending;
    }

    const initPromise = (async () => {
        const dir = workspaceMemoryDir(scopeKey);
        if (!dir) return null;
        // B-8: 只读访问（createIfMissing=false）跳过全部写副作用——mkdir / scope.json /
        // manager.init()（会创建 TREE/LOG.txt/config）都不执行，只读 loadConfig；
        // 只读实例不写入 _workspaceInstances 缓存：后续写路径（createIfMissing=true）
        // 会走完整初始化分支，避免缓存未初始化实例供写工具使用。
        if (!createIfMissing) {
            const manager = new MemoryManager(dir);
            await manager.loadConfig();
            // 并发写路径（createIfMissing=true）已完成完整初始化时直接复用其结果：
            // 避免只读实例与写实例并存（各自独立 AsyncLock 并发读写同一 LOG）
            const writeInstance = _workspaceInstances.get(scopeKey);
            if (writeInstance) return writeInstance;
            // 写路径正在初始化中（_workspaceInitPromises 已在途、尚未落 _workspaceInstances）：
            // 等待其完成并复用其结果，关闭「只读先缓存、写后完成」的窄窗口——该窗口下
            // 只读完成路径检查写实例（上面的 get）与写路径 _workspaceInstances.set 之间
            // 存在间隙，只读实例先缓存、写路径随后完成，同一目录双实例并存。
            const writePending = _workspaceInitPromises.get(scopeKey);
            if (writePending) {
                try {
                    const adopted = await writePending;
                    if (adopted) return adopted;
                } catch {
                    // 写初始化失败：回退缓存只读实例，本次只读访问仍可用
                }
            }
            // 缓存只读实例（含 config）：后续只读访问直接复用；
            // 不写入 _workspaceInstances——写路径（createIfMissing=true）仍走完整初始化分支
            _workspaceReadonlyInstances.set(scopeKey, manager);
            return manager;
        }
        // 写路径优先复用已缓存的只读实例（同一目录只保留一个实例）：只读实例与写实例
        // 各自持有独立 AsyncLock 会并发读写同一 LOG（deleteRange/deleteEntries 的
        // tmp+rename 与只读扫描互斥缺失），且只读实例未 repairLog，320B 降级模式下
        // logRecMode 不同步、按 1024 错位读旧文件。复用后单实例 = 单锁 + 单一文件视图。
        const cachedReadonly = _workspaceReadonlyInstances.get(scopeKey);
        if (cachedReadonly) {
            _workspaceReadonlyInstances.delete(scopeKey);
            await cachedReadonly.init();
            await cachedReadonly.loadConfig();
            _workspaceInstances.set(scopeKey, cachedReadonly);
            return cachedReadonly;
        }
        await fs.promises.mkdir(dir, { recursive: true });
        // 持久化 scope 元信息：供设置页枚举工作区记忆时展示名称。
        const metaPath = path.join(dir, 'scope.json');
        // uri 存原始 workspaceUri：非 file:// 形态（如 vscode-remote://）时
        // 无法从 fsPath 无损还原 URI（file:// 重建会损坏），故原样持久化
        const meta = {
            fsPath: uriToFsPathForMeta(scopeKey),
            name: path.basename(uriToFsPathForMeta(scopeKey)),
            uri: workspaceUri,
        };
        try {
            const raw = await fs.promises.readFile(metaPath, 'utf-8');
            const existingMeta = JSON.parse(raw);
            if (existingMeta.fsPath !== meta.fsPath || existingMeta.uri !== meta.uri) {
                await fs.promises.writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf-8');
            }
        } catch {
            await fs.promises.writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf-8');
        }
        const manager = new MemoryManager(dir);
        await manager.init();
        await manager.loadConfig();
        _workspaceInstances.set(scopeKey, manager);
        return manager;
    })();

    // 只读路径（createIfMissing=false）不注册到共享写初始化池：否则并发写路径
    // （createIfMissing=true）会复用只读 promise，拿到「只 loadConfig、未 init()」
    // 的实例（无 TREE/LOG.txt），写工具随后会在 appendFile 处 ENOENT 失败。
    // 只读路径之间仍需共享 promise 池（_workspaceReadonlyInitPromises），
    // 否则并发只读访问会各自 new MemoryManager 产生同一目录双实例。
    if (createIfMissing) {
        _workspaceInitPromises.set(scopeKey, initPromise);
    } else {
        _workspaceReadonlyInitPromises.set(scopeKey, initPromise);
    }
    try {
        return await initPromise;
    } finally {
        if (createIfMissing) {
            _workspaceInitPromises.delete(scopeKey);
        } else {
            _workspaceReadonlyInitPromises.delete(scopeKey);
        }
    }
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
 * 工具层取实例入口：按工具上下文注入的工作区路由到对应记忆实例。
 *
 * scope 规则：
 * - 'global'：直接返回全局实例，不依赖 workspaceUri。
 * - 'workspace'：必须能解析出工作区实例（有 workspaceUri 且目录可访问），否则返回 null（由调用方报错）。
 * - 未传：有 workspaceUri 用工作区，否则全局（向后兼容）。
 *
 * 注意：调用方传了 workspaceUri 说明意图是工作区——即使未显式传 scope，工作区解析失败
 * 也返回 null（不再静默回退全局）；只有 workspaceUri 为 null/undefined 时才回退全局。
 */
export async function getMemoryManagerForTool(
    workspaceUri?: string | null,
    scope?: MemoryScope,
    createIfMissing = true
): Promise<import('./MemoryManager').MemoryManager | null> {
    // 显式要求全局作用域：不依赖 workspaceUri
    if (scope === 'global') {
        return getGlobalMemoryManager();
    }
    if (workspaceUri) {
        const scoped = await getMemoryManagerForWorkspace(workspaceUri, createIfMissing);
        if (scoped) return scoped;
        // 传了 workspaceUri 说明意图是工作区：解析失败不再静默回退全局，由调用方报错
        return null;
    }
    if (scope === 'workspace') {
        // 显式要求工作区作用域但缺少工作区上下文
        return null;
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
            // meta 里的原始 URI 需在 try 外使用（只读 path 用，非 file 形态时优先）
            let metaUri: string | undefined;
            try {
                const meta = JSON.parse(await fs.promises.readFile(path.join(dir, 'scope.json'), 'utf-8'));
                if (typeof meta?.fsPath === 'string' && meta.fsPath) {
                    fsPath = meta.fsPath;
                    name = meta.name || path.basename(fsPath);
                }
                if (typeof meta?.uri === 'string' && meta.uri) metaUri = meta.uri;
            } catch {
                continue; // 无元信息的目录不是工作区记忆 scope
            }
            if (!fsPath) continue;
            const hasLog = await fs.promises.stat(path.join(dir, 'LOG.txt')).then(() => true).catch(() => false);
            const hasTree = await fs.promises.stat(path.join(dir, 'TREE')).then(() => true).catch(() => false);
            out.push({
                // 优先用持久化的原始 URI（无损）；老目录无 uri 字段时回退 fsPath 重建
                uri: metaUri ?? uriFromFsPath(fsPath),
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

/** 由 fsPath 构造 file:/// URI（与 vscode.Uri.file().toString() 同构）；非 file 形态原样返回 */
function uriFromFsPath(fsPath: string): string {
    // 非 file 形态的 scope key（如 vscode-remote://ssh-remote+host/a/b）：
    // 直接作为 URI 返回，不做 file:// 重建——重建会产生损坏的
    // file:///vscode-remote%3A/... URI，导致设置页与工具层解析出不同的 scope key
    const isFileLike = fsPath.startsWith('/') || /^[a-z]:[\\/]/i.test(fsPath);
    if (!isFileLike) return fsPath;
    const withSlashes = fsPath.replace(/\\/g, '/');
    const encoded = withSlashes.split('/').map(seg => encodeURIComponent(seg)).join('/');
    return `file://${encoded.startsWith('/') ? encoded : '/' + encoded}`;
}

