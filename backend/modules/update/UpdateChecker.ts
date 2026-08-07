/**
 * GrayCode - 更新检查模块
 *
 * 启动时检测 GitHub Releases 上的最新版本，与当前扩展版本对比：
 * - 有新版本：前端弹窗提示，用户确认后自动下载 vsix 并安装
 *   （workbench.extensions.installExtension，安装后需 reload 窗口生效）
 * - 24 小时内不重复检查（启动检查一次，跨天再查；手动检查 force 忽略节流）
 * - 用户可在设置中关闭（checkForUpdates = false）
 * - 请求经 createProxyFetch 走用户配置的代理（与渠道 API 请求一致），
 *   超时 10s（下载 120s），失败静默（不打扰用户，状态记录为 error 供前端展示）
 *
 * 核心逻辑（版本比较 / 节流判断 / API 响应解析）为纯函数，便于单元测试；
 * UpdateChecker 只做依赖注入与流程胶水。
 */

import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { createProxyFetch } from '../channel/proxyFetch';

/** GitHub 仓库（owner/repo） */
export const UPDATE_REPO = 'Komeiji-Shiki/Gray-Code';
/** 检查节流间隔：24 小时 */
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** 版本检查请求超时：10s（启动路径，不能拖慢激活） */
export const UPDATE_FETCH_TIMEOUT_MS = 10_000;
/** vsix 下载超时：120s */
export const UPDATE_DOWNLOAD_TIMEOUT_MS = 120_000;

/** 最新版本信息（来自 GitHub Releases API） */
export interface UpdateInfo {
    /** 版本号（已剥离 v 前缀，如 1.4.5） */
    version: string;
    /** 原始 tag 名（如 v1.4.5） */
    tagName: string;
    /** Release 标题 */
    name: string;
    /** Release 说明（markdown） */
    body: string;
    /** vsix 资产下载地址（release 未附 vsix 时为 undefined） */
    vsixAssetUrl?: string;
    /** 发布时间（ISO） */
    publishedAt: string;
}

/** 更新检查状态机（前端按 state 渲染） */
export type UpdateCheckStatus =
    | { state: 'disabled' }
    | { state: 'idle' }
    | { state: 'checking' }
    | { state: 'upToDate'; checkedAt: number }
    | { state: 'updateAvailable'; checkedAt: number; update: UpdateInfo }
    | { state: 'error'; checkedAt: number; message: string };

// ─── 纯函数（可独立测试） ─────────────────────────────

/** 剥离版本号前缀 v/V（GitHub tag 常见 v1.2.3） */
export function stripVersionPrefix(version: string): string {
    return String(version).replace(/^v/i, '');
}

/**
 * 语义版本比较（支持任意段数，缺段按 0；非数字段按 0）。
 * 返回 -1（a < b）/ 0（相等）/ 1（a > b）。
 */
export function compareVersions(a: string, b: string): number {
    const ap = stripVersionPrefix(a).split('.').map(n => parseInt(n, 10) || 0);
    const bp = stripVersionPrefix(b).split('.').map(n => parseInt(n, 10) || 0);
    const len = Math.max(ap.length, bp.length);
    for (let i = 0; i < len; i++) {
        const x = ap[i] ?? 0;
        const y = bp[i] ?? 0;
        if (x !== y) return x < y ? -1 : 1;
    }
    return 0;
}

/** 是否应执行检查：force 或无上次记录，或距上次检查已超过间隔 */
export function shouldCheck(lastCheckAt: number | undefined, now: number, force: boolean): boolean {
    if (force) return true;
    if (lastCheckAt === undefined) return true;
    return now - lastCheckAt >= UPDATE_CHECK_INTERVAL_MS;
}

/**
 * 解析 GitHub Releases API 响应为 UpdateInfo。
 * 响应格式异常时返回 null（调用方按错误处理）。
 */
export function parseReleaseResponse(data: unknown): UpdateInfo | null {
    if (!data || typeof data !== 'object') return null;
    const raw = data as Record<string, unknown>;
    if (typeof raw.tag_name !== 'string' || !raw.tag_name) return null;
    const assets: Array<Record<string, unknown>> = Array.isArray(raw.assets) ? raw.assets as Array<Record<string, unknown>> : [];
    const vsix = assets.find(a => typeof a?.name === 'string' && a.name.endsWith('.vsix'));
    return {
        version: stripVersionPrefix(raw.tag_name),
        tagName: raw.tag_name,
        name: typeof raw.name === 'string' && raw.name ? raw.name : raw.tag_name,
        body: typeof raw.body === 'string' ? raw.body : '',
        vsixAssetUrl: typeof vsix?.browser_download_url === 'string' && vsix.browser_download_url
            ? vsix.browser_download_url
            : undefined,
        publishedAt: typeof raw.published_at === 'string' ? raw.published_at : '',
    };
}

// ─── UpdateChecker ──────────────────────────────────

export interface UpdateCheckerOptions {
    /** 是否启用自动检查（用户设置 checkForUpdates !== false） */
    isCheckEnabled: () => boolean;
    /** 代理 URL（未启用代理时返回 undefined） */
    getProxyUrl?: () => string | undefined;
    /** 持久化存储（扩展 globalState 适配） */
    storage: {
        get: (key: string) => number | undefined;
        update: (key: string, value: number) => Promise<void>;
    };
    /** vsix 下载目录的父目录（扩展 globalStorageUri.fsPath） */
    globalStoragePath: string;
    /** 当前扩展版本（缺省从 vscode.extensions 读取） */
    getCurrentVersion?: () => string;
    /** fetch 实现（缺省按代理配置创建；测试注入） */
    fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
    /** 当前时间戳（测试注入） */
    now?: () => number;
}

export class UpdateChecker {
    private readonly lastCheckKey = 'lastUpdateCheckAt';
    private readonly options: UpdateCheckerOptions;
    private status: UpdateCheckStatus = { state: 'idle' };

    constructor(options: UpdateCheckerOptions) {
        this.options = options;
    }

    /** 当前检查状态（前端 getUpdateStatus 查询用） */
    getStatus(): UpdateCheckStatus {
        return this.status;
    }

    /**
     * 检查更新（幂等：进行中的检查返回同一结果，不会并发重复请求）。
     * force=true 忽略 24h 节流（手动检查）。
     */
    async check(force = false): Promise<UpdateCheckStatus> {
        if (!this.options.isCheckEnabled()) {
            this.status = { state: 'disabled' };
            return this.status;
        }
        if (this.status.state === 'checking') {
            return this.status;
        }

        const now = this.options.now ? this.options.now() : Date.now();
        const lastCheckAt = this.options.storage.get(this.lastCheckKey);
        if (!shouldCheck(lastCheckAt, now, force)) {
            // 节流窗口内：返回内存状态（可能是本会话已查过的结果，或 idle）
            return this.status;
        }

        this.status = { state: 'checking' };
        try {
            const info = await this.fetchLatestRelease();
            const current = this.getCurrentVersion();
            if (current && compareVersions(info.version, current) > 0) {
                this.status = { state: 'updateAvailable', checkedAt: now, update: info };
            } else {
                this.status = { state: 'upToDate', checkedAt: now };
            }
        } catch (e: any) {
            this.status = { state: 'error', checkedAt: now, message: e?.message || String(e) };
        } finally {
            // 无论成功失败都记录检查时间：失败也进入节流窗口，避免网络异常时每次启动都重试
            try {
                await this.options.storage.update(this.lastCheckKey, now);
            } catch {
                // 存储失败不影响检查状态
            }
        }
        return this.status;
    }

    /**
     * 下载 vsix 并安装（workbench.extensions.installExtension）。
     * 安装成功后返回本地 vsix 文件路径；失败抛错（调用方提示用户打开 Release 页兜底）。
     */
    async downloadAndInstall(update: UpdateInfo): Promise<string> {
        if (!update.vsixAssetUrl) {
            throw new Error('该 Release 未附带 vsix 安装包，请前往 GitHub Releases 手动下载。');
        }
        const dir = path.join(this.options.globalStoragePath, 'update');
        await fs.mkdir(dir, { recursive: true });
        const target = path.join(dir, `graycode-${update.version}.vsix`);

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), UPDATE_DOWNLOAD_TIMEOUT_MS);
        try {
            const res = await this.getFetch()(update.vsixAssetUrl, { signal: controller.signal });
            if (!res.ok) {
                throw new Error(`下载失败：HTTP ${res.status} ${res.statusText}`);
            }
            const buf = Buffer.from(await res.arrayBuffer());
            if (buf.length === 0) {
                throw new Error('下载内容为空，vsix 可能已损坏。');
            }
            await fs.writeFile(target, buf);
        } finally {
            clearTimeout(timer);
        }

        await vscode.commands.executeCommand('workbench.extensions.installExtension', vscode.Uri.file(target));
        return target;
    }

    /** 打开 GitHub Releases 页面（安装失败/无 vsix 资产时的兜底入口） */
    static openReleasePage(): Thenable<boolean> {
        return vscode.env.openExternal(vscode.Uri.parse(`https://github.com/${UPDATE_REPO}/releases/latest`));
    }

    // ─── 私有 ──────────────────────────────────────

    private getCurrentVersion(): string {
        if (this.options.getCurrentVersion) {
            return this.options.getCurrentVersion();
        }
        const ext = vscode.extensions.getExtension('Komeiji-Shiki.graycode');
        return ext?.packageJSON?.version || '';
    }

    private getFetch(): (url: string, init?: RequestInit) => Promise<Response> {
        if (this.options.fetchImpl) {
            return this.options.fetchImpl;
        }
        const proxyUrl = this.options.getProxyUrl?.();
        return createProxyFetch(proxyUrl) as (url: string, init?: RequestInit) => Promise<Response>;
    }

    private async fetchLatestRelease(): Promise<UpdateInfo> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), UPDATE_FETCH_TIMEOUT_MS);
        try {
            const res = await this.getFetch()(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, {
                headers: { 'Accept': 'application/vnd.github+json' },
                signal: controller.signal,
            });
            if (!res.ok) {
                throw new Error(`GitHub Releases API 返回 ${res.status} ${res.statusText}`);
            }
            const info = parseReleaseResponse(await res.json());
            if (!info) {
                throw new Error('GitHub Releases API 响应格式异常');
            }
            return info;
        } finally {
            clearTimeout(timer);
        }
    }
}
