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
import { createProxyFetch } from '../channel';
import { t } from '../../i18n';

/** GitHub 仓库（owner/repo） */
export const UPDATE_REPO = 'Komeiji-Shiki/Gray-Code';

/** 更新渠道：stable=正式发布版，nightly=每日自动构建（预览） */
export type UpdateChannel = 'stable' | 'nightly';
/** 本扩展 ID（安装/版本读取用） */
export const EXTENSION_ID = 'Komeiji-Shiki.graycode';
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
    /** 所属更新渠道（stable / nightly） */
    channel?: UpdateChannel;
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
 * 主版本段相等时，预发布（-beta 等）判为更旧（同号预发布 < 正式）；
 * 同为预发布时按标识符逐段比较（数字段数值比较、字符串段字典序、段数多者更新、
 * 数字段 < 字母数字段），全部相等才判相等。
 * 特例：nightly 预发布（-nightly.<YYYYMMDD>）视为「高于同主版本正式版」的最新构建，
 * 两个 nightly 之间按日期段比较（1.4.6-nightly.20260810 > 1.4.6-nightly.20260809 > 1.4.6）。
 * 返回 -1（a < b）/ 0（相等）/ 1（a > b）。
 */
export function compareVersions(a: string, b: string): number {
    const parse = (v: string): {
        nums: number[];
        nightlyDate: string | null;
        prereleaseSegs: Array<string | number> | null;
        prerelease: boolean;
    } => {
        const cleaned = stripVersionPrefix(v);
        const dash = cleaned.indexOf('-');
        const main = dash >= 0 ? cleaned.slice(0, dash) : cleaned;
        const suffix = dash >= 0 ? cleaned.slice(dash + 1) : null;
        const nightlyDate = suffix && suffix.startsWith('nightly.') ? suffix.slice('nightly.'.length) : null;
        // 预发布标识符段：纯数字段转数值（按数值比较），其余保留字符串（按字典序比较）
        const prereleaseSegs = suffix !== null && nightlyDate === null
            ? suffix.split('.').map(seg => (/^\d+$/.test(seg) ? parseInt(seg, 10) : seg))
            : null;
        return {
            nums: main.split('.').map(n => parseInt(n, 10) || 0),
            nightlyDate,
            prereleaseSegs,
            prerelease: prereleaseSegs !== null
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
    // 主版本相同：nightly 构建视为更新（nightly > 正式版；nightly 之间按日期）
    if (ap.nightlyDate || bp.nightlyDate) {
        if (ap.nightlyDate && bp.nightlyDate) {
            if (ap.nightlyDate !== bp.nightlyDate) return ap.nightlyDate < bp.nightlyDate ? -1 : 1;
            return 0;
        }
        return ap.nightlyDate ? 1 : -1;
    }
    if (ap.prerelease !== bp.prerelease) {
        return ap.prerelease ? -1 : 1;
    }
    // 同为预发布：按标识符逐段比较（1.4.6-beta vs 1.4.6-alpha、1.4.6-beta.1 vs 1.4.6-beta.2）
    if (ap.prereleaseSegs && bp.prereleaseSegs) {
        const segLen = Math.max(ap.prereleaseSegs.length, bp.prereleaseSegs.length);
        for (let i = 0; i < segLen; i++) {
            const x = ap.prereleaseSegs[i];
            const y = bp.prereleaseSegs[i];
            // 某一段缺失：段数少者更旧（1.0.0-alpha < 1.0.0-alpha.1）
            if (x === undefined) return -1;
            if (y === undefined) return 1;
            if (x === y) continue;
            // 数字段与字母数字段相遇：数字段更旧（semver：numeric < alphanumeric）
            if (typeof x !== typeof y) {
                return typeof x === 'number' ? -1 : 1;
            }
            if (typeof x === 'number' && typeof y === 'number') {
                return x < y ? -1 : 1;
            }
            return String(x) < String(y) ? -1 : 1;
        }
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
 * nightly 版本号格式：<semver>-nightly.<YYYYMMDD>（如 1.4.6-nightly.20260809）。
 * 合法 semver（vsce 打包校验要求）；compareVersions 将 nightly 预发布视为
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
 */
export function parseReleaseResponse(data: unknown, channel: UpdateChannel = 'stable'): UpdateInfo | null {
    if (!data || typeof data !== 'object') return null;
    const raw = data as Record<string, unknown>;
    if (typeof raw.tag_name !== 'string' || !raw.tag_name) return null;
    const assets: Array<Record<string, unknown>> = Array.isArray(raw.assets) ? raw.assets as Array<Record<string, unknown>> : [];
    const vsix = assets
        .filter(a => typeof a?.name === 'string' && /\.vsix$/i.test(a.name))
        .sort((x, y) => {
            // 多平台资产时优先通用包（无平台后缀），其次按名称字典序稳定取一个
            const xPlatform = /-(win32|darwin|linux|linux-x64|linux-arm64|universal)\.vsix$/i.test(x.name as string) ? 1 : 0;
            const yPlatform = /-(win32|darwin|linux|linux-x64|linux-arm64|universal)\.vsix$/i.test(y.name as string) ? 1 : 0;
            return xPlatform - yPlatform || String(x.name).localeCompare(String(y.name));
        })[0];
    let version = stripVersionPrefix(raw.tag_name);
    if (channel === 'nightly') {
        // nightly Release 的 tag 固定为 nightly，真实版本号写在 Release name 中
        //（如 "v1.4.6-nightly.20260809"），从 name 提取；旧的装饰性名称仍兼容。
        // 提取失败视为响应格式异常（避免 version 退化为 'nightly' 导致静默判为已最新）
        const nameVersion = extractNightlyVersionFromName(raw.name);
        if (!nameVersion) return null;
        version = nameVersion;
    }
    return {
        version,
        tagName: raw.tag_name,
        name: typeof raw.name === 'string' && raw.name ? raw.name : raw.tag_name,
        body: typeof raw.body === 'string' ? raw.body : '',
        vsixAssetUrl: typeof vsix?.browser_download_url === 'string' && vsix.browser_download_url
            ? vsix.browser_download_url
            : undefined,
        publishedAt: typeof raw.published_at === 'string' ? raw.published_at : '',
        channel,
    };
}

// ─── UpdateChecker ──────────────────────────────────

export interface UpdateCheckerOptions {
    /** 是否启用自动检查（用户设置 checkForUpdates !== false） */
    isCheckEnabled: () => boolean;
    /** 更新渠道（stable=正式发布 / nightly=每日构建；缺省 stable） */
    getUpdateChannel?: () => UpdateChannel;
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
    /** 上次成功检查时间戳：节流所有非 force 检查 */
    private readonly lastCheckKey = 'lastUpdateCheckAt';
    /** 上次自动检查尝试时间戳：失败也只节流自动检查，不影响用户显式检查（UI 重试） */
    private readonly lastAutoCheckKey = 'lastAutoCheckAt';
    private readonly options: UpdateCheckerOptions;
    private status: UpdateCheckStatus = { state: 'idle' };
    /** 进行中的 check() Promise：并发（含 force）检查复用同一请求，避免重复打上游 */
    private inFlightCheck: Promise<UpdateCheckStatus> | null = null;
    /** 代际计数：resetStatus() 递增，使在途 check() 的结果作废（不写回状态/存储） */
    private generation = 0;

    constructor(options: UpdateCheckerOptions) {
        this.options = options;
    }

    /** 当前检查状态（前端 getUpdateStatus 查询用） */
    getStatus(): UpdateCheckStatus {
        return this.status;
    }

    /**
     * 检查更新（幂等：进行中的检查返回同一结果，不会并发重复请求）。
     * force=true 忽略 24h 节流（手动检查）；进行中检查不被 force 吞掉——
     * 等待其结束后按 force 语义重新检查。
     */
    async check(force = false): Promise<UpdateCheckStatus> {
        if (!this.options.isCheckEnabled()) {
            this.status = { state: 'disabled' };
            return this.status;
        }
        // 并发去重：进行中的检查返回同一 Promise（不重复请求上游）
        if (this.inFlightCheck) {
            if (!force) {
                return this.inFlightCheck;
            }
            // force 检查：等待进行中的检查结束后按 force 语义重查（不吞掉用户显式检查）
            await this.inFlightCheck;
        }

        // 捕获代际：resetStatus() 会递增 generation 使在途检查结果作废，
        // 写回状态/存储前校验代际未变，否则丢弃本次结果
        const gen = this.generation;
        const run = async (): Promise<UpdateCheckStatus> => {
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
                const info = await this.fetchLatestRelease();
                // 检查期间 resetStatus() 已调用：丢弃本次结果，不写回状态与存储
                if (gen !== this.generation) {
                    return this.status;
                }
                const current = this.getCurrentVersion();
                if (!current) {
                    // 当前扩展版本读取失败：置 error 而非静默 upToDate（否则会误导用户以为已是最新）
                    throw new Error(t('modules.update.errors.cannotReadVersion'));
                }
                // nightly 版本号为 <semver>-nightly.<YYYYMMDD>（如 1.4.6-nightly.20260809），
                // compareVersions 将其视为「高于同主版本正式版」的最新构建，
                // 两个 nightly 之间按日期比较（1.4.6-nightly.20260810 > 1.4.6-nightly.20260809 > 1.4.6）
                if (current && compareVersions(info.version, current) > 0) {
                    this.status = { state: 'updateAvailable', checkedAt: now, update: info };
                } else {
                    this.status = { state: 'upToDate', checkedAt: now };
                }
                // 成功：记录成功检查时间（节流后续所有非 force 检查）；自动检查另记录尝试时间
                if (gen !== this.generation) {
                    return this.status;
                }
                try {
                    await this.options.storage.update(this.lastCheckKey, now);
                    if (!force) {
                        await this.options.storage.update(this.lastAutoCheckKey, now);
                    }
                } catch {
                    // 存储失败不影响检查状态
                }
            } catch (e: any) {
                if (gen !== this.generation) {
                    return this.status;
                }
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
        };

        const promise = run();
        this.inFlightCheck = promise;
        try {
            return await promise;
        } finally {
            // 只清除自己持有的 in-flight 引用：期间若有新检查启动，不能误清
            if (this.inFlightCheck === promise) {
                this.inFlightCheck = null;
            }
        }
    }

    /**
     * 下载 vsix 并安装（workbench.extensions.installExtension）。
     * 安装成功后返回本地 vsix 文件路径；失败抛错（调用方提示用户打开 Release 页兜底）。
     */
    async downloadAndInstall(update: UpdateInfo): Promise<string> {
        // 安全校验：只允许下载本仓库 GitHub Releases 的 vsix，且版本号符合合法格式，
        // 防止前端传入任意 URL / 版本拼出恶意下载路径（本地代码执行路径）
        if (!update.vsixAssetUrl || !update.vsixAssetUrl.startsWith(`https://github.com/${UPDATE_REPO}/releases/`)) {
            throw new Error(t('modules.update.errors.invalidDownloadUrl'));
        }
        if (!/^[\w.\-+]+$/.test(update.version)) {
            throw new Error(t('modules.update.errors.invalidVersion', { version: update.version }));
        }
        const dir = path.join(this.options.globalStoragePath, 'update');
        await fs.mkdir(dir, { recursive: true });
        const target = path.join(dir, `graycode-${update.version}.vsix`);
        const tmpTarget = `${target}.tmp`;

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), UPDATE_DOWNLOAD_TIMEOUT_MS);
        try {
            const res = await this.getFetch()(update.vsixAssetUrl, { signal: controller.signal });
            if (!res.ok) {
                throw new Error(t('modules.update.errors.downloadFailed', {
                    status: res.status,
                    statusText: res.statusText
                }));
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
                        throw new Error(t('modules.update.errors.emptyDownload'));
                    }
                } finally {
                    await fileHandle.close();
                }
            } else {
                // 无流式响应体（如代理路径）：回退整包读取
                const buf = Buffer.from(await res.arrayBuffer());
                if (buf.length === 0) {
                    throw new Error(t('modules.update.errors.emptyDownload'));
                }
                await fs.writeFile(tmpTarget, buf);
            }
            // Windows 上 rename 无法覆盖已存在目标（EEXIST/EPERM）：同版本 vsix 已存在
            // （首次下载后安装被拒/取消，再次安装同版本）时直接 rename 会失败。先删旧再
            // rename（tmp 是完整文件，删旧窗口内最坏是 target 短暂缺失，下次下载重建）
            try {
                await fs.rm(target, { force: true });
            } catch {
                // 删除失败（文件锁/杀软等）：rename 仍会尝试并暴露真实错误
            }
            await fs.rename(tmpTarget, target);
        } catch (error) {
            // 超时中止（代理/原生 fetch 路径均以 AbortError 呈现）：给出明确的超时文案，
            // 而不是底层 'Request cancelled'/'This operation was aborted'
            if (error instanceof Error && error.name === 'AbortError') {
                throw new Error(t('modules.update.errors.downloadTimeout', {
                    seconds: Math.round(UPDATE_DOWNLOAD_TIMEOUT_MS / 1000)
                }));
            }
            throw error;
        } finally {
            clearTimeout(timer);
            await fs.rm(tmpTarget, { force: true }).catch(() => undefined);
        }

        await vscode.commands.executeCommand('workbench.extensions.installExtension', vscode.Uri.file(target));
        // 安装成功：状态置 upToDate（reload 后新版本才生效），避免 UI 仍显示 updateAvailable
        this.status = { state: 'upToDate', checkedAt: Date.now() };
        return target;
    }

    /** 打开 GitHub Releases 页面（安装失败/无 vsix 资产时的兜底入口；按渠道打开对应页面） */
    openReleasePage(): Thenable<boolean> {
        const channel = this.getUpdateChannel();
        const page = channel === 'nightly'
            ? `https://github.com/${UPDATE_REPO}/releases/tag/nightly`
            : `https://github.com/${UPDATE_REPO}/releases/latest`;
        return vscode.env.openExternal(vscode.Uri.parse(page));
    }

    // ─── 私有 ──────────────────────────────────────

    private getCurrentVersion(): string {
        if (this.options.getCurrentVersion) {
            return this.options.getCurrentVersion();
        }
        const ext = vscode.extensions.getExtension(EXTENSION_ID);
        return ext?.packageJSON?.version || '';
    }

    private getUpdateChannel(): UpdateChannel {
        if (this.options.getUpdateChannel) {
            return this.options.getUpdateChannel();
        }
        return 'stable';
    }

    /**
     * 渠道等影响检查结果的条件变化时调用：清除内存状态并重置节流时间戳，
     * 使下一次检查（含启动自动检查）按新条件重新拉取，
     * 避免旧渠道的缓存结果（如 Nightly 徽章/可安装项）残留到新渠道。
     */
    resetStatus(): void {
        // 代际计数递增：使在途 check() 的结果作废（check 在写回状态/存储前校验代际，
        // 变化即丢弃），防止旧渠道的检查结果覆盖 reset 后的新状态
        this.generation++;
        // 清空 in-flight 引用：reset 后新检查不再复用旧检查的结果
        this.inFlightCheck = null;
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

    private async fetchLatestRelease(): Promise<UpdateInfo> {
        const channel = this.getUpdateChannel();
        // stable：最新正式 Release；nightly：固定 tag=nightly 的每日构建 Release。
        // nightly 基于最新代码构建且版本号（如 1.4.7-nightly.<date>）恒高于正式版（1.4.7），
        // 正式版变更会随下一次 nightly 构建自然覆盖，无需再检查正式版。
        const endpoint = channel === 'nightly'
            ? `https://api.github.com/repos/${UPDATE_REPO}/releases/tags/nightly`
            : `https://api.github.com/repos/${UPDATE_REPO}/releases/latest`;
        return this.fetchRelease(endpoint, channel);
    }

    private async fetchRelease(endpoint: string, channel: UpdateChannel): Promise<UpdateInfo> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), UPDATE_FETCH_TIMEOUT_MS);
        try {
            const res = await this.getFetch()(endpoint, {
                headers: {
                    'Accept': 'application/vnd.github+json',
                    // GitHub API 要求显式 User-Agent（缺失会被 403）；带版本便于服务端排障
                    'User-Agent': `graycode-updater/${this.getCurrentVersion() || 'unknown'}`
                },
                signal: controller.signal,
            });
            if (!res.ok) {
                throw new Error(t('modules.update.errors.apiError', {
                    status: res.status,
                    statusText: res.statusText
                }));
            }
            const info = parseReleaseResponse(await res.json(), channel);
            if (!info) {
                throw new Error(t('modules.update.errors.apiResponseInvalid'));
            }
            return info;
        } catch (error) {
            // 超时中止（代理/原生 fetch 路径均以 AbortError 呈现）：给出明确的「检查超时」文案，
            // 与下载路径（downloadAndInstall）统一口径，而不是底层 'Request cancelled'/'This operation was aborted'
            if (error instanceof Error && error.name === 'AbortError') {
                throw new Error(t('modules.update.errors.checkTimeout', {
                    seconds: Math.round(UPDATE_FETCH_TIMEOUT_MS / 1000)
                }));
            }
            throw error;
        } finally {
            clearTimeout(timer);
        }
    }
}
