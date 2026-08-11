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
import { createProxyFetch } from '../channel';

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
 * 版本号归一化：dash 形式的构建号并入版本段，与点号形式等价比较。
 *
 * 同一个版本在仓库内有两种写法：
 * - 点号（tag / 根 package.json）：v1.7.5.2dev、1.7.5.2dev；
 * - dash（electron-builder 只接受合法 semver，四段版本被塞进 prerelease）：
 *   1.7.5-2dev、1.7.6-1。
 * 两者语义相同，比较前必须统一为同一形态，否则
 * compareVersions('1.7.5-3dev', '1.7.5-2dev') 会把构建号丢弃判为相等，
 * dev 用户永远收不到同主版本的后续构建更新提示。
 */
export function normalizeVersion(version: string): string {
    const s = stripVersionPrefix(version);
    const dash = s.indexOf('-');
    if (dash === -1) return s;
    const prerelease = s.slice(dash + 1);
    // electron-builder 构建号以数字开头（1.7.5-2dev / 1.7.6-1）：并入版本段成为第四段。
    if (/^\d/.test(prerelease)) {
        return `${s.slice(0, dash)}.${prerelease}`;
    }
    // 语义预发布（-beta / -alpha 等）：不并入，保持 dash 形态参与 prerelease 判定。
    return s;
}

/**
 * 语义版本比较（支持任意段数，缺段按 0；非数字段按 0）。
 * 主版本段相等时，预发布（-beta 等）判为更旧（同号预发布 < 正式）。
 * 返回 -1（a < b）/ 0（相等）/ 1（a > b）。
 */
export function compareVersions(a: string, b: string): number {
    const parse = (v: string): { nums: number[]; prerelease: boolean } => {
        const raw = stripVersionPrefix(v);
        return {
            nums: normalizeVersion(raw).split('.').map(n => parseInt(n, 10) || 0),
            prerelease: raw.includes('-') && !/^\d/.test(raw.split('-')[1] ?? '')
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
    if (ap.prerelease && bp.prerelease) {
        // 同为预发布：按标识字符串比较（alpha < beta < rc）
        const pa = stripVersionPrefix(a).split('-')[1] ?? '';
        const pb = stripVersionPrefix(b).split('-')[1] ?? '';
        if (pa !== pb) return pa < pb ? -1 : 1;
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

    // portable 优先便携版；该形态 release 未附便携资产时回退 Setup（保证用户仍有更新可装，
    // 而非卡在无更新状态）——正常发布流程会同时附齐两种形态。
    const asset = kind === 'portable' ? (portable ?? setup ?? anyExe) : (setup ?? anyExe);
    return asset ?? zip;
}

/**
 * nightly 版本号格式：<semver>-nightly.<YYYYMMDD>（如 1.4.6-nightly.20260809）。
 * 合法 semver（vsce 打包校验要求）；compareVersions 把 nightly 预发布视为
 * 「高于同主版本正式版」的最新构建，nightly 之间按日期比较。
 */
const NIGHTLY_VERSION_RE = /(?<![\d.])(\d+\.\d+\.\d+-nightly\.\d{8})\b/i;

/**
 * 从 nightly Release 名称中提取版本号。
 * 例如 "v1.4.6-nightly.20260809" → "1.4.6-nightly.20260809"；
 * 同时兼容旧的 "Gray Code Nightly v..." 名称。
 * 提取失败返回 null。
 */
export function extractNightlyVersionFromName(name: unknown): string | null {
    if (typeof name !== 'string' || !name) return null;
    const m = NIGHTLY_VERSION_RE.exec(name);
    return m ? m[1] : null;
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

/** 更新渠道（上游 stable/nightly 语义；本地流程保留该类型用于兼容面） */
export type UpdateChannel = 'stable' | 'nightly';

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
    /** 更新渠道（上游兼容面；本地 dev/stable 通道按版本号自动判定，不依赖本选项） */
    getUpdateChannel?: () => UpdateChannel;
    /** fetch 实现（缺省按代理配置创建；测试注入） */
    fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
    /** 当前时间戳（测试注入） */
    now?: () => number;
}

export class UpdateChecker {
    /** 上次成功检查时间戳：节流所有非 force 检查 */
    private readonly lastCheckKey = 'lastUpdateCheckAt';
    /** 上次自动检查尝试时间戳：失败也只节流自动检查，不影响用户显式检查（UI 重试） */
    private readonly lastAutoCheckKey = 'lastAutoCheckAt';
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
        const lastAutoCheckAt = this.options.storage.get(this.lastAutoCheckKey);
        // 节流：force（用户显式检查）无视节流；非 force 检查受「上次成功检查」与
        // 「上次自动检查尝试」两个时间戳共同节流——自动检查失败也只节流后续自动检查，
        // 避免网络异常时每次启动都重试，但不会拖住用户显式检查/UI 重试
        if (!shouldCheck(lastCheckAt, now, force) || (!force && !shouldCheck(lastAutoCheckAt, now, false))) {
            // 节流窗口内：返回内存状态（可能是本会话已查过的结果，或 idle）
            return this.status;
        }

        this.status = { state: 'checking' };
        try {
            const current = this.getCurrentVersion();
            const info = await this.fetchLatestRelease(resolveReleaseChannel(current || ''));
            if (!current) {
                // 当前扩展版本读取失败：置 error 而非静默 upToDate（否则会误导用户以为已是最新）
                throw new Error('无法读取当前扩展版本');
            }
            if (info && compareVersions(info.version, current) > 0) {
                this.status = { state: 'updateAvailable', checkedAt: now, update: info };
            } else {
                this.status = { state: 'upToDate', checkedAt: now };
            }
            // 成功：记录成功检查时间（节流后续所有非 force 检查）；自动检查另记录尝试时间
            try {
                await this.options.storage.update(this.lastCheckKey, now);
                if (!force) {
                    await this.options.storage.update(this.lastAutoCheckKey, now);
                }
            } catch {
                // 存储失败不影响检查状态
            }
        } catch (e: any) {
            this.status = { state: 'error', checkedAt: now, message: e?.message || String(e) };
            // 失败只节流「自动检查」：写 lastAutoCheckAt（避免网络异常时每次启动都重试），
            // 不写 lastCheckKey（成功检查时间戳）——否则用户显式检查/UI 重试会被失败的
            // 自动检查拖入 24h 节流窗口而无法重试。
            // force 手动检查失败不记录任何时间戳——不吞掉下一次自动检查的机会
            if (!force) {
                try {
                    await this.options.storage.update(this.lastAutoCheckKey, now);
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
            // 先写 .tmp 再 rename：中断/失败不残留半成品 .vsix（防旧版本文件被当成可用包）
            if (res.body) {
                // 流式写入 tmp：vsix 包可达数百 MB，避免整包载入内存
                // （Node 18+ 的 web ReadableStream 可直接 for-await 迭代）
                const fileHandle = await fs.open(tmpTarget, 'w');
                try {
                    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
                        await fileHandle.write(chunk);
                    }
                    if ((await fileHandle.stat()).size === 0) {
                        throw new Error('下载内容为空，vsix 可能已损坏。');
                    }
                } finally {
                    await fileHandle.close();
                }
            } else {
                // 无流式响应体（如代理路径）：回退整包读取
                const buf = Buffer.from(await res.arrayBuffer());
                if (buf.length === 0) {
                    throw new Error('下载内容为空，vsix 可能已损坏。');
                }
                await fs.writeFile(tmpTarget, buf);
            }
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

    /**
     * 渠道等影响检查结果的条件变化时调用：清除内存状态并重置节流时间戳，
     * 使下一次检查（含启动自动检查）按新条件重新拉取，
     * 避免旧渠道的缓存结果（如 Nightly 徽章/可安装项）残留到新渠道。
     */
    resetStatus(): void {
        this.status = { state: 'idle' };
        void this.options.storage.update(this.lastCheckKey, 0).catch(() => undefined);
        // 同步重置自动检查尝试时间戳：渠道切换后自动检查按新渠道立即重试
        void this.options.storage.update(this.lastAutoCheckKey, 0).catch(() => undefined);
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
                headers: {
                    'Accept': 'application/vnd.github+json',
                    // GitHub API 要求显式 User-Agent（缺失会被 403）；带版本便于服务端排障
                    'User-Agent': `graycode-updater/${this.getCurrentVersion() || 'unknown'}`
                },
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
