/**
 * 工作区管理器（多工作区支持核心）
 *
 * 职责：
 * 1. 维护当前打开的全部工作区文件夹列表
 * 2. 维护"当前激活工作区"：
 *    - 默认跟随活动编辑器所在工作区（无活动编辑器时回退最近记录/第一个文件夹）
 *    - 用户可通过 workspace.setActive 显式固定（pinned），固定后不再跟随编辑器
 *    - 被固定的工作区被移除时自动解除固定，回退自动跟随
 * 3. 工作区列表或激活工作区变化时通知监听者（由宿主广播给前端）
 *
 * 同时被 VS Code 扩展与 Electron 桌面版使用（Electron shim 的 activeTextEditor 恒为
 * undefined，自动跟随退化为"最近编辑器不可用 → 第一个文件夹"，行为等价于旧实现）。
 */

import * as vscode from 'vscode';
import { getFsCaseSensitivity } from './fsCaseSensitivity';

export interface WorkspaceFolderInfo {
    /** 文件夹名称 */
    name: string;
    /** URI（string 形式，如 file:///...） */
    uri: string;
    /** 文件系统路径 */
    fsPath: string;
    /** 在 workspaceFolders 中的索引 */
    index: number;
}

export interface WorkspaceManagerOptions {
    /** 激活工作区变化（含变化为 null） */
    onActiveWorkspaceChanged?: (uri: string | null) => void;
    /** 工作区列表变化（新增/移除文件夹） */
    onWorkspaceListChanged?: (list: WorkspaceFolderInfo[]) => void;
}

/**
 * 大小写匹配口径说明：文件系统大小写敏感性由运行时探测决定（fsCaseSensitivity.ts），
 * 而非只看平台——macOS APFS 默认不敏感、Linux 上 WSL drvfs 挂载不敏感，
 * 仅按 process.platform 判断会把 macOS 误判为大小写敏感，导致同一目录以不同
 * 大小写路径打开/收藏时固定匹配静默失败。探测不到时回退平台默认值。
 */
export class WorkspaceManager {
    private pinnedWorkspaceUri: string | null = null;
    private lastEditorWorkspaceUri: string | null = null;
    private lastActiveWorkspaceUri: string | null = null;
    private lastWorkspaceListKey: string | null = null;
    private disposables: vscode.Disposable[] = [];
    private options: WorkspaceManagerOptions;

    /**
     * 文件系统大小写敏感性（进程级共享口径，见 fsCaseSensitivity.getFsCaseSensitivity）。
     * 样本取当前列表首个文件夹；列表为空时返回平台默认且不缓存，
     * 列表就绪后首次调用会完成探测并固定口径（惰性、单次 stat）。
     */
    getFsCaseSensitivity(): boolean {
        return getFsCaseSensitivity(this.getWorkspaceList()[0]?.fsPath);
    }

    private normalizeWorkspaceUri(uri: string): string {
        return this.getFsCaseSensitivity() ? uri : uri.toLowerCase();
    }

    constructor(options: WorkspaceManagerOptions = {}) {
        this.options = options;
        this.disposables.push(
            vscode.workspace.onDidChangeWorkspaceFolders(() => this.handleChange()),
            vscode.window.onDidChangeActiveTextEditor((editor) => {
                // 记录最近一次活动编辑器的工作区：编辑器失焦（例如聚焦聊天面板）时
                // activeTextEditor 会变为 undefined，若直接回退 folder[0] 会造成
                // 多工作区下"当前工作区"在两个项目间反复横跳。
                const folder = editor?.document.uri
                    ? vscode.workspace.getWorkspaceFolder(editor.document.uri)
                    : undefined;
                if (folder) {
                    this.lastEditorWorkspaceUri = folder.uri.toString();
                }
                this.handleChange();
            })
        );
    }

    /** 获取全部工作区文件夹 */
    getWorkspaceList(): WorkspaceFolderInfo[] {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) {
            return [];
        }
        return folders.map((folder, index) => ({
            name: folder.name,
            uri: folder.uri.toString(),
            fsPath: folder.uri.fsPath,
            index
        }));
    }

    /**
     * 获取当前激活工作区 URI
     *
     * 优先级：已固定（用户选择）> 最近活动编辑器所在工作区 > 第一个文件夹 > null
     */
    getActiveWorkspaceUri(): string | null {
        return this.computeActiveWorkspaceUri(this.getWorkspaceList());
    }

    private computeActiveWorkspaceUri(list: WorkspaceFolderInfo[]): string | null {
        if (this.pinnedWorkspaceUri) {
            const pinnedMatch = list.find(
                (w) => this.normalizeWorkspaceUri(w.uri) === this.normalizeWorkspaceUri(this.pinnedWorkspaceUri!)
            );
            if (pinnedMatch) {
                // 列表 URI 大小写漂移（同一目录以不同大小写路径重新打开）：
                // 采用列表里的规范 URI，保持广播与列表一致
                if (pinnedMatch.uri !== this.pinnedWorkspaceUri) {
                    this.pinnedWorkspaceUri = pinnedMatch.uri;
                }
                return this.pinnedWorkspaceUri;
            }
            // 被固定的工作区已关闭：解除固定，回退自动跟随
            this.pinnedWorkspaceUri = null;
        }
        // 最近活动编辑器所在的工作区也可能已从窗口中移除：失效则回退
        if (this.lastEditorWorkspaceUri && !list.some((w) => this.normalizeWorkspaceUri(w.uri) === this.normalizeWorkspaceUri(this.lastEditorWorkspaceUri!))) {
            this.lastEditorWorkspaceUri = null;
        }
        return this.lastEditorWorkspaceUri ?? list[0]?.uri ?? null;
    }

    /**
     * 设置/解除激活工作区固定
     *
     * @param uri 工作区 URI；传 null 解除固定并恢复"跟随活动编辑器"
     *
     * 说明：
     * - 大小写不敏感文件系统（按运行时探测）上按大小写不敏感匹配（同一目录以
     *   不同大小写路径视为同一工作区），命中时固定列表里的规范 URI，避免前端
     *   传来的大小写漂移 URI 静默失败；
     * - 请求的工作区未打开时不解除现有固定（对话锁定时绑定工作区可能已关闭，
     *   不应把用户当前的固定/跟随状态清掉），由调用方展示绑定状态。
     */
    setActiveWorkspaceUri(uri: string | null): void {
        if (!uri) {
            if (this.pinnedWorkspaceUri === null) {
                return;
            }
            this.pinnedWorkspaceUri = null;
            this.handleChange();
            return;
        }
        const normalized = this.normalizeWorkspaceUri(uri);
        const match = this.getWorkspaceList().find(
            (w) => this.normalizeWorkspaceUri(w.uri) === normalized
        );
        if (!match) {
            return;
        }
        if (this.pinnedWorkspaceUri === match.uri) {
            return;
        }
        this.pinnedWorkspaceUri = match.uri;
        this.handleChange();
    }

    /** 是否处于"跟随活动编辑器"模式（未固定） */
    isAutoFollow(): boolean {
        return this.pinnedWorkspaceUri === null;
    }

    private handleChange(): void {
        const list = this.getWorkspaceList();
        const listKey = list.map((w) => w.uri).join('\u0000');
        if (listKey !== this.lastWorkspaceListKey) {
            this.lastWorkspaceListKey = listKey;
            this.options.onWorkspaceListChanged?.(list);
        }

        const active = this.computeActiveWorkspaceUri(list);
        if (active !== this.lastActiveWorkspaceUri) {
            this.lastActiveWorkspaceUri = active;
            this.options.onActiveWorkspaceChanged?.(active);
        }
    }

    dispose(): void {
        for (const d of this.disposables) {
            d.dispose();
        }
        this.disposables = [];
    }
}

// ========== 全局注册（与 settingsContext / getDiffManager 相同的单例模式） ==========

let globalWorkspaceManager: WorkspaceManager | null = null;

/** 注册全局工作区管理器（ChatViewProvider / BackendHost 构造时调用） */
export function setWorkspaceManager(manager: WorkspaceManager | null): void {
    globalWorkspaceManager = manager;
}

/** 获取全局工作区管理器（处理器内使用；未初始化时返回 null 由调用方兜底） */
export function getWorkspaceManager(): WorkspaceManager | null {
    return globalWorkspaceManager;
}
