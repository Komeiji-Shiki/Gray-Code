/**
 * GrayCode - 更新检查模块
 *
 * 启动时检测 GitHub Releases 上的最新版本，与当前版本对比（fork：桌面版随 Releases 发布 exe 安装包）：
 * - 有新版本：前端弹窗提示，用户确认后自动下载安装包并交给操作系统打开（用户完成安装）
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

/** GitHub 仓库（owner/repo）——fork 桌面版仓库 */
export const UPDATE_REPO = 'czocelot/Gray-Code-Desktop';
/** 检查节流间隔：24 小时 */
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** 版本检查请求超时：10s（启动路径，不能拖慢激活） */
export const UPDATE_FETCH_TIMEOUT_MS = 10_000;
/** 安装包下载超时：120s */
export const UPDATE_DOWNLOAD_TIMEOUT_MS = 120_000;

/** 最新版本信息（来自 GitHub Releases API） */
export interface UpdateInfo {
    /** 版本号（已剥离 v 前缀，如 1.6.9） */
    version: string;
    /** 原始 tag 名（如 v1.6.9） */
    tagName: string;
    /** Release 标题 */
    name: string;
    /** Release 说明（markdown） */
    body: string;
    /** 安装包资产下载地址（release 未附带安装包时为 undefined） */
    installerAssetUrl?: string;
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
 * 主版本段相等时，预发布（-beta 等）判为更旧（同号预发布 < 正式）。
 * 返回 -1（a < b）/ 0（相等）/ 1（a > b）。
 */
export function compareVersions(a: string, b: string): number {
    const parse = (v: string): { nums: number[]; prerelease: boolean } => {
        const main = stripVersionPrefix(v).split('-')[0];
        return {
            nums: main.split('.').map(n => parseInt(n, 10) || 0),
            prerelease: stripVersionPrefix(v).includes('-')
        };
    };
    const ap = parse(a);
    const bp = parse(b);
    const len = Math.max(ap.nums.length, bp.nums.length);
    for (let i = 0; i < len; i++) {
        const x = ap.nums[i] ?? 0;
        const y = bp.nums[i] ?? 0;
        if (x !== y) return x < y ? -1 : 1;
    }
    if (ap.prerelease !== bp.prerelease) {
        return ap.prerelease ? -1 : 1;
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
 * 当前运行形态（决定一键更新下载的安装包类型）：
 * - portable：便携版（自解压 exe，运行时注入 PORTABLE_EXECUTABLE_DIR）——只应下载
 *   GrayCode-Portable-*.exe，避免便携版用户被拉进安装版（污染系统环境）；
 * - installed：安装版（NSIS Setup）或免安装 zip——优先 GrayCode.Setup.*.exe。
 */
export type InstallerKind = 'portable' | 'installed';

/** 按运行形态挑选安装包资产（纯函数，可独立测试） */
export function pickInstallerAsset(
    assets: Array<Record<string, unknown>>,
    kind: InstallerKind,
): { name: string; browser_download_url: string } | undefined {
    const isNamed = (a: Record<string, unknown>): a is { name: string; browser_download_url: string } & Record<string, unknown> =>
        typeof a?.name === 'string' && !!a.name;
    const named = assets.filter(isNamed);
    const byName = (pattern: RegExp) => named.find(a => pattern.test(a.name));
    const anyExe = named.find(a => a.name.endsWith('.exe'));
    const zip = named.find(a => /GrayCode/i.test(a.name) && a.name.endsWith('.zip'));

    const setup = byName(/\.Setup\.[^/\\]+\.exe$/i);
    const portable = byName(/Portable/i);

    const asset = kind === 'portable' ? (portable ?? setup ?? anyExe) : (setup ?? anyExe);
    return asset ?? zip;
}

/**
 * 解析 GitHub Releases API 响应为 UpdateInfo。
 * 响应格式异常时返回 null（调用方按错误处理）。
 *
 * 资产匹配（fork 桌面版）：按当前运行形态匹配——
 * - portable：优先便携版 exe（GrayCode-Portable-*），避免便携用户被拉进安装版；
 * - installed：优先 NSIS 安装包（GrayCode.Setup.*.exe），其次任意 .exe，再次 .zip。
 */
export function parseReleaseResponse(data: unknown, installerKind: InstallerKind = 'installed'): UpdateInfo | null {
    if (!data || typeof data !== 'object') return null;
    const raw = data as Record<string, unknown>;
    if (typeof raw.tag_name !== 'string' || !raw.tag_name) return null;
    const assets: Array<Record<string, unknown>> = Array.isArray(raw.assets) ? raw.assets as Array<Record<string, unknown>> : [];
    const installer = pickInstallerAsset(assets, installerKind);
    return {
        version: stripVersionPrefix(raw.tag_name),
        tagName: raw.tag_name,
        name: typeof raw.name === 'string' && raw.name ? raw.name : raw.tag_name,
        body: typeof raw.body === 'string' ? raw.body : '',
        installerAssetUrl: typeof installer?.browser_download_url === 'string' && installer.browser_download_url
            ? installer.browser_download_url
            : undefined,
        publishedAt: typeof raw.published_at === 'string' ? raw.published_at : '',
    };
}

/**
 * 版本发布通道：dev 通道（tag/版本号含 dev 后缀，如 v1.7.5.2dev / 1.7.5.2dev / 1.7.5-2dev）
 * 与 stable 通道（正式版）。稳定版用户只应被提示升级到 stable release，dev 用户只应被
 * 提示升级到 dev release（dev 无候选时回退 stable）——避免 dev/stable 互相污染更新提示
 * （releases/latest 按创建时间返回，dev release 晚于 stable 创建时会把 stable 用户引到
 * dev 通道，反之亦然）。
 */
export type ReleaseChannel = 'stable' | 'dev';

export function resolveReleaseChannel(version: string): ReleaseChannel {
    return stripVersionPrefix(version).toLowerCase().includes('dev') ? 'dev' : 'stable';
}

// ─── UpdateChecker ──────────────────────────────────

export interface UpdateCheckerOptions {
    /** 是否启用自动检查（用户设置 checkForUpdates !== false）；仅约束非 force 的自动检查 */
    isCheckEnabled: () => boolean;
    /** 代理 URL（未启用代理时返回 undefined） */
    getProxyUrl?: () => string | undefined;
    /** 持久化存储（扩展 globalState 适配） */
    storage: {
        get: (key: string) => number | undefined;
        update: (key: string, value: number) => Promise<void>;
    };
    /** 安装包下载目录的父目录（数据目录） */
    globalStoragePath: string;
    /** 当前扩展版本（缺省从 vscode.extensions 读取） */
    getCurrentVersion?: () => string;
    /** 当前运行形态（缺省 installed）：便携版运行时注入 PORTABLE_EXECUTABLE_DIR */
    getInstallerKind?: () => InstallerKind;
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
     *
     * 注意：force 也绕过「自动检查」开关——该开关（checkForUpdates）只约束
     * 启动时的自动检查；设置页「立即检查 / 一键更新」在开关关闭时仍可手动触发，
     * 否则用户关掉自动检查后连手动检查也会被静默拒绝（修复）。
     */
    async check(force = false): Promise<UpdateCheckStatus> {
        if (!force && !this.options.isCheckEnabled()) {
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
            const current = this.getCurrentVersion();
            const info = await this.fetchLatestRelease(resolveReleaseChannel(current || ''));
            if (current && info && compareVersions(info.version, current) > 0) {
                this.status = { state: 'updateAvailable', checkedAt: now, update: info };
            } else {
                this.status = { state: 'upToDate', checkedAt: now };
            }
            // 成功：记录检查时间进入节流窗口
            try {
                await this.options.storage.update(this.lastCheckKey, now);
            } catch {
                // 存储失败不影响检查状态
            }
        } catch (e: any) {
            this.status = { state: 'error', checkedAt: now, message: e?.message || String(e) };
            // 非 force 的自动检查失败也记录（进入节流窗口，避免网络异常时每次启动都重试）；
            // force 手动检查失败不记录——不吞掉下一次自动检查的机会
            if (!force) {
                try {
                    await this.options.storage.update(this.lastCheckKey, now);
                } catch {
                    // 存储失败不影响检查状态
                }
            }
        }
        return this.status;
    }

    /**
     * 下载安装包并交给操作系统打开（fork 桌面版：exe/zip 安装包无法像 vsix 一样
     * 走扩展安装 API；下载完成后经 env.openExternal 打开文件，由系统启动安装器）。
     * 返回本地文件路径；失败抛错（调用方提示用户打开 Release 页兜底）。
     */
    async downloadAndInstall(update: UpdateInfo): Promise<string> {
        if (!update.installerAssetUrl) {
            throw new Error('该 Release 未附带安装包，请前往 GitHub Releases 手动下载。');
        }
        const dir = path.join(this.options.globalStoragePath, 'update');
        await fs.mkdir(dir, { recursive: true });
        // 安全校验：tag 名可能来自远端 Release（受仓库控制），净化后才允许拼入文件路径，
        // 防止路径穿越如 v1.0.0/../../evil）把安装包写到 update 目录之外。
        // 允许 semver 合法字符（含 + 构建元数据，如 v1.6.0+build5）。
        if (!/^[0-9A-Za-z._+-]+$/.test(update.version)) {
            throw new Error(`非法版本号格式：${update.version}`);
        }
        const ext = update.installerAssetUrl.endsWith('.zip') ? '.zip' : '.exe';
        const target = path.join(dir, `graycode-${update.version}-setup${ext}`);
        const tmpTarget = `${target}.tmp`;

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), UPDATE_DOWNLOAD_TIMEOUT_MS);
        try {
            const res = await this.getFetch()(update.installerAssetUrl, { signal: controller.signal });
            if (!res.ok) {
                throw new Error(`下载失败：HTTP ${res.status} ${res.statusText}`);
            }
            const buf = Buffer.from(await res.arrayBuffer());
            if (buf.length === 0) {
                throw new Error('下载内容为空，安装包可能已损坏。');
            }
            // 先写 .tmp 再 rename：中断/失败不残留半成品 .vsix（防旧版本文件被当成可用包）
            await fs.writeFile(tmpTarget, buf);
            await fs.rename(tmpTarget, target);
        } finally {
            clearTimeout(timer);
            await fs.rm(tmpTarget, { force: true }).catch(() => undefined);
        }

        await vscode.env.openExternal(vscode.Uri.file(target));
        return target;
    }

    /** 打开 GitHub Releases 页面（安装失败/无安装包资产时的兜底入口） */
    static openReleasePage(): Thenable<boolean> {
        return vscode.env.openExternal(vscode.Uri.parse(`https://github.com/${UPDATE_REPO}/releases/latest`));
    }

    // ─── 私有 ──────────────────────────────────────

    private getCurrentVersion(): string {
        if (this.options.getCurrentVersion) {
            return this.options.getCurrentVersion();
        }
        const ext = vscode.extensions.getExtension('czocelot.graycode');
        return ext?.packageJSON?.version || '';
    }

    private getInstallerKind(): InstallerKind {
        return this.options.getInstallerKind
            ? this.options.getInstallerKind()
            : 'installed';
    }

    private getFetch(): (url: string, init?: RequestInit) => Promise<Response> {
        if (this.options.fetchImpl) {
            return this.options.fetchImpl;
        }
        const proxyUrl = this.options.getProxyUrl?.();
        return createProxyFetch(proxyUrl) as (url: string, init?: RequestInit) => Promise<Response>;
    }

    /**
     * 拉取最新 release（按发布通道）。
     *
     * 一次请求取全部 releases（per_page=30 覆盖历史 dev/stable 序列），在通道内按
     * **版本号**取最高（而非创建时间）：
     * - stable 用户只看 stable release（dev release 无论何时创建都不影响正式版用户）；
     * - dev 用户只看 dev release（dev 通道无候选时回退全部 release，保证 dev 用户总能
     *   收到更新提示）；
     * - 上游/历史 tag（dev、dev-1.7.1 等无法按版本号解析的）版本恒为 0，天然不参与竞争。
     * 兼容单对象响应（测试/极端情况）。
     */
    private async fetchLatestRelease(channel: ReleaseChannel): Promise<UpdateInfo | null> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), UPDATE_FETCH_TIMEOUT_MS);
        try {
            const res = await this.getFetch()(`https://api.github.com/repos/${UPDATE_REPO}/releases?per_page=30`, {
                headers: { 'Accept': 'application/vnd.github+json' },
                signal: controller.signal,
            });
            if (!res.ok) {
                throw new Error(`GitHub Releases API 返回 ${res.status} ${res.statusText}`);
            }
            const body = await res.json();
            const rawReleases = Array.isArray(body) ? body : [body];
            const installerKind = this.getInstallerKind();
            const releases = rawReleases
                .map(r => parseReleaseResponse(r, installerKind))
                .filter((r): r is UpdateInfo => r !== null);
            if (releases.length === 0) {
                throw new Error('GitHub Releases API 响应格式异常');
            }
            const channelReleases = releases.filter(r => resolveReleaseChannel(r.version) === channel);
            const candidates = channelReleases.length > 0 ? channelReleases : releases;
            return candidates.reduce((best, cur) => (compareVersions(cur.version, best.version) > 0 ? cur : best));
        } finally {
            clearTimeout(timer);
        }
    }
}
