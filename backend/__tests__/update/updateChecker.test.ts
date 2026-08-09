/**
 * UpdateChecker 单元测试：
 * 1. 纯函数：stripVersionPrefix / compareVersions / shouldCheck / parseReleaseResponse
 * 2. UpdateChecker.check：开关、24h 节流、新版本判定、失败静默、时间戳记录
 * 3. UpdateChecker.downloadAndInstall：无 vsix 资产、下载成功安装、下载失败、空内容
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    UpdateChecker,
    stripVersionPrefix,
    compareVersions,
    shouldCheck,
    parseReleaseResponse,
    extractNightlyVersionFromName,
    UPDATE_CHECK_INTERVAL_MS,
} from '../../modules/update';
import * as vscode from 'vscode';

// ─── 纯函数 ──────────────────────────────────────────

describe('stripVersionPrefix', () => {
    it('剥离 v 前缀', () => {
        expect(stripVersionPrefix('v1.2.3')).toBe('1.2.3');
        expect(stripVersionPrefix('V1.2.3')).toBe('1.2.3');
    });

    it('无前缀原样返回', () => {
        expect(stripVersionPrefix('1.2.3')).toBe('1.2.3');
        expect(stripVersionPrefix('')).toBe('');
    });
});

describe('compareVersions', () => {
    it('相等返回 0（含 v 前缀差异）', () => {
        expect(compareVersions('1.4.4', 'v1.4.4')).toBe(0);
        expect(compareVersions('1.4.4', '1.4.4')).toBe(0);
    });

    it('常规大小比较', () => {
        expect(compareVersions('1.4.5', '1.4.4')).toBe(1);
        expect(compareVersions('1.3.9', '1.4.0')).toBe(-1);
        expect(compareVersions('2.0.0', '1.9.9')).toBe(1);
    });

    it('段数不足按 0 补齐', () => {
        expect(compareVersions('1.4', '1.4.0')).toBe(0);
        expect(compareVersions('1.4.1', '1.4')).toBe(1);
        expect(compareVersions('1.4', '1.4.1')).toBe(-1);
    });

    it('非数字段按 0 处理', () => {
        expect(compareVersions('1.4.x', '1.4.0')).toBe(0);
    });

    it('nightly 预发布视为高于同主版本正式版，nightly 之间按日期比较', () => {
        expect(compareVersions('1.4.6-nightly.20260810', '1.4.6')).toBe(1);
        expect(compareVersions('1.4.6', '1.4.6-nightly.20260809')).toBe(-1);
        expect(compareVersions('1.4.6-nightly.20260810', '1.4.6-nightly.20260809')).toBe(1);
        expect(compareVersions('1.4.6-nightly.20260809', '1.4.6-nightly.20260809')).toBe(0);
        expect(compareVersions('1.4.7', '1.4.6-nightly.20260810')).toBe(1);
    });
});

describe('shouldCheck', () => {
    const now = 1_000_000;

    it('force 总是检查', () => {
        expect(shouldCheck(now, now + 1, true)).toBe(true);
    });

    it('无上次记录时检查', () => {
        expect(shouldCheck(undefined, now, false)).toBe(true);
    });

    it('间隔内不检查', () => {
        expect(shouldCheck(now - UPDATE_CHECK_INTERVAL_MS + 1, now, false)).toBe(false);
        expect(shouldCheck(now, now, false)).toBe(false);
    });

    it('超过间隔检查', () => {
        expect(shouldCheck(now - UPDATE_CHECK_INTERVAL_MS, now, false)).toBe(true);
    });
});

describe('extractNightlyVersionFromName', () => {
    it('从 Release name 提取 nightly 版本号（-nightly.<date> 预发布段，含 v 前缀）', () => {
        expect(extractNightlyVersionFromName('Gray Code Nightly v1.4.6-nightly.20260809')).toBe('1.4.6-nightly.20260809');
    });

    it('无 v 前缀同样可提取', () => {
        expect(extractNightlyVersionFromName('Gray Code Nightly 1.4.6-nightly.20260809')).toBe('1.4.6-nightly.20260809');
    });

    it('版本号后跟多余数字时不截断（锚定结尾）', () => {
        expect(extractNightlyVersionFromName('Gray Code Nightly v1.4.6-nightly.202608090')).toBeNull();
    });

    it('无版本号返回 null', () => {
        expect(extractNightlyVersionFromName('Gray Code Nightly')).toBeNull();
        expect(extractNightlyVersionFromName(undefined)).toBeNull();
        expect(extractNightlyVersionFromName('')).toBeNull();
    });
});

describe('parseReleaseResponse', () => {
    it('解析正常响应（含 vsix 资产）', () => {
        const info = parseReleaseResponse({
            tag_name: 'v1.4.5',
            name: 'Gray Code 1.4.5',
            body: '## 更新内容\n- 修复 bug',
            published_at: '2026-08-08T00:00:00Z',
            assets: [
                { name: 'graycode-1.4.5.vsix', browser_download_url: 'https://github.com/x/y/releases/download/v1.4.5/graycode-1.4.5.vsix' },
                { name: 'source.zip', browser_download_url: 'https://example.com/source.zip' },
            ],
        });
        expect(info).not.toBeNull();
        expect(info!.version).toBe('1.4.5');
        expect(info!.tagName).toBe('v1.4.5');
        expect(info!.name).toBe('Gray Code 1.4.5');
        expect(info!.body).toContain('修复 bug');
        expect(info!.vsixAssetUrl).toContain('graycode-1.4.5.vsix');
        expect(info!.publishedAt).toBe('2026-08-08T00:00:00Z');
    });

    it('无 vsix 资产时 vsixAssetUrl 为 undefined', () => {
        const info = parseReleaseResponse({
            tag_name: 'v1.4.5',
            assets: [{ name: 'source.zip', browser_download_url: 'https://example.com/source.zip' }],
        });
        expect(info).not.toBeNull();
        expect(info!.vsixAssetUrl).toBeUndefined();
    });

    it('响应格式异常返回 null', () => {
        expect(parseReleaseResponse(null)).toBeNull();
        expect(parseReleaseResponse('oops')).toBeNull();
        expect(parseReleaseResponse({})).toBeNull();
        expect(parseReleaseResponse({ tag_name: 123 })).toBeNull();
    });

    it('nightly 渠道从 Release name 提取版本号（tag 固定为 nightly）', () => {
        const info = parseReleaseResponse({
            tag_name: 'nightly',
            name: 'Gray Code Nightly v1.4.6-nightly.20260809',
            body: 'auto build',
            published_at: '2026-08-09T00:00:00Z',
            assets: [{
                name: 'graycode-nightly.vsix',
                browser_download_url: 'https://github.com/Komeiji-Shiki/Gray-Code/releases/download/nightly/graycode-nightly.vsix',
            }],
        }, 'nightly');
        expect(info).not.toBeNull();
        expect(info!.version).toBe('1.4.6-nightly.20260809');
        expect(info!.tagName).toBe('nightly');
        expect(info!.channel).toBe('nightly');
        expect(info!.vsixAssetUrl).toContain('graycode-nightly.vsix');
    });

    it('stable 渠道默认使用 tag_name 作为版本号且标记渠道', () => {
        const info = parseReleaseResponse({ tag_name: 'v1.4.5', assets: [] });
        expect(info!.version).toBe('1.4.5');
        expect(info!.channel).toBe('stable');
    });
});

// ─── UpdateChecker ───────────────────────────────────

function createChecker(overrides: {
    isCheckEnabled?: () => boolean;
    getUpdateChannel?: () => 'stable' | 'nightly';
    storage?: { get: (k: string) => number | undefined; update: (k: string, v: number) => Promise<void> };
    fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
    currentVersion?: string;
    now?: () => number;
} = {}): { checker: UpdateChecker; storage: { get: (k: string) => number | undefined; update: (k: string, v: number) => Promise<void> } } {
    const storage = overrides.storage ?? {
        get: () => undefined,
        update: jest.fn(async () => {}),
    };
    const checker = new UpdateChecker({
        isCheckEnabled: overrides.isCheckEnabled ?? (() => true),
        getUpdateChannel: overrides.getUpdateChannel,
        storage,
        globalStoragePath: fs.mkdtempSync(path.join(os.tmpdir(), 'mm-update-')),
        getCurrentVersion: () => overrides.currentVersion ?? '1.4.4',
        fetchImpl: overrides.fetchImpl,
        now: overrides.now ?? (() => 2_000_000),
    });
    return { checker, storage };
}

function okResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('UpdateChecker.check', () => {
    it('关闭自动检查时状态为 disabled 且不发请求', async () => {
        const fetchImpl = jest.fn();
        const { checker } = createChecker({ isCheckEnabled: () => false, fetchImpl });
        const status = await checker.check();
        expect(status).toEqual({ state: 'disabled' });
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('24h 节流窗口内不重复请求', async () => {
        const fetchImpl = jest.fn();
        const { checker } = createChecker({
            storage: { get: () => 2_000_000 - 3_600_000, update: jest.fn(async () => {}) },
            fetchImpl,
        });
        const status = await checker.check(false);
        expect(fetchImpl).not.toHaveBeenCalled();
        // 节流窗口内返回内存状态（idle）
        expect(status).toEqual({ state: 'idle' });
    });

    it('有新版本时返回 updateAvailable 并记录检查时间', async () => {
        const update = jest.fn(async () => {});
        const { checker, storage } = createChecker({
            storage: { get: () => undefined, update },
            fetchImpl: async () => okResponse({
                tag_name: 'v1.5.0',
                name: 'v1.5.0',
                body: 'new',
                assets: [{ name: 'graycode-1.5.0.vsix', browser_download_url: 'https://example.com/graycode-1.5.0.vsix' }],
            }),
            currentVersion: '1.4.4',
        });
        const status = await checker.check();
        expect(status.state).toBe('updateAvailable');
        if (status.state === 'updateAvailable') {
            expect(status.update.version).toBe('1.5.0');
            expect(status.update.vsixAssetUrl).toContain('graycode-1.5.0.vsix');
        }
        expect(update).toHaveBeenCalledWith('lastUpdateCheckAt', 2_000_000);
        // 状态缓存：再次 getStatus 返回同一结果
        expect(checker.getStatus()).toEqual(status);
    });

    it('已是最新版本时返回 upToDate', async () => {
        const { checker } = createChecker({
            fetchImpl: async () => okResponse({ tag_name: 'v1.4.4', assets: [] }),
            currentVersion: '1.4.4',
        });
        const status = await checker.check();
        expect(status).toEqual({ state: 'upToDate', checkedAt: 2_000_000 });
    });

    it('fetch 失败时状态为 error（不抛出）且仍记录时间戳', async () => {
        const update = jest.fn(async () => {});
        const { checker } = createChecker({
            storage: { get: () => undefined, update },
            fetchImpl: async () => { throw new Error('network down'); },
        });
        const status = await checker.check();
        expect(status.state).toBe('error');
        if (status.state === 'error') {
            expect(status.message).toContain('network down');
        }
        expect(update).toHaveBeenCalled();
    });

    it('API 返回非 2xx 时状态为 error', async () => {
        const { checker } = createChecker({
            fetchImpl: async () => okResponse({ message: 'rate limited' }, 403),
        });
        const status = await checker.check();
        expect(status.state).toBe('error');
        if (status.state === 'error') {
            expect(status.message).toContain('403');
        }
    });

    it('API 响应格式异常时状态为 error', async () => {
        const { checker } = createChecker({
            fetchImpl: async () => okResponse({ unexpected: true }),
        });
        const status = await checker.check();
        expect(status.state).toBe('error');
    });

    it('nightly 渠道请求 /releases/tags/nightly 且 -nightly.<date> 版本高于当前时提示更新', async () => {
        const fetchImpl = jest.fn(async () => okResponse({
            tag_name: 'nightly',
            name: 'Gray Code Nightly v1.4.6-nightly.20260810',
            body: 'auto build',
            assets: [{
                name: 'graycode-nightly.vsix',
                browser_download_url: 'https://github.com/Komeiji-Shiki/Gray-Code/releases/download/nightly/graycode-nightly.vsix',
            }],
        }));
        const { checker } = createChecker({
            getUpdateChannel: () => 'nightly',
            fetchImpl,
            currentVersion: '1.4.6-nightly.20260809',
        });
        const status = await checker.check();
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(fetchImpl).toHaveBeenCalledWith(
            'https://api.github.com/repos/Komeiji-Shiki/Gray-Code/releases/tags/nightly',
            expect.objectContaining({ headers: { 'Accept': 'application/vnd.github+json' } })
        );
        expect(status.state).toBe('updateAvailable');
        if (status.state === 'updateAvailable') {
            expect(status.update.version).toBe('1.4.6-nightly.20260810');
            expect(status.update.channel).toBe('nightly');
        }
    });

    it('nightly 渠道：当前已是同日期构建时不提示更新', async () => {
        const fetchImpl = jest.fn(async () => okResponse({
            tag_name: 'nightly',
            name: 'Gray Code Nightly v1.4.6-nightly.20260809',
            assets: [{
                name: 'graycode-nightly.vsix',
                browser_download_url: 'https://github.com/Komeiji-Shiki/Gray-Code/releases/download/nightly/graycode-nightly.vsix',
            }],
        }));
        const { checker } = createChecker({
            getUpdateChannel: () => 'nightly',
            fetchImpl,
            currentVersion: '1.4.6-nightly.20260809',
        });
        const status = await checker.check();
        expect(status).toEqual({ state: 'upToDate', checkedAt: 2_000_000 });
    });

    it('nightly 渠道：nightly 版本高于当前正式版时提示更新', async () => {
        const fetchImpl = jest.fn(async () => okResponse({
            tag_name: 'nightly',
            name: 'Gray Code Nightly v1.4.6-nightly.20260809',
            assets: [{
                name: 'graycode-nightly.vsix',
                browser_download_url: 'https://github.com/Komeiji-Shiki/Gray-Code/releases/download/nightly/graycode-nightly.vsix',
            }],
        }));
        const { checker } = createChecker({
            getUpdateChannel: () => 'nightly',
            fetchImpl,
            currentVersion: '1.4.6',
        });
        const status = await checker.check();
        expect(status.state).toBe('updateAvailable');
    });

    it('nightly 渠道：nightly 请求 404 时状态为 error（不降级到正式版）', async () => {
        const fetchImpl = jest.fn(async () => okResponse({ message: 'Not Found' }, 404));
        const { checker } = createChecker({ getUpdateChannel: () => 'nightly', fetchImpl });
        const status = await checker.check();
        expect(status.state).toBe('error');
        if (status.state === 'error') {
            expect(status.message).toContain('404');
        }
    });

    it('stable 渠道（默认）仅请求 /releases/latest', async () => {
        const fetchImpl = jest.fn(async () => okResponse({ tag_name: 'v1.4.4', assets: [] }));
        const { checker } = createChecker({ fetchImpl, currentVersion: '1.4.4' });
        await checker.check();
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(fetchImpl).toHaveBeenCalledWith(
            'https://api.github.com/repos/Komeiji-Shiki/Gray-Code/releases/latest',
            expect.objectContaining({ headers: { 'Accept': 'application/vnd.github+json' } })
        );
    });
});

describe('UpdateChecker.resetStatus', () => {
    it('清除内存状态并重置节流时间戳（渠道切换时调用，避免旧渠道缓存残留）', async () => {
        const update = jest.fn(async () => {});
        const { checker } = createChecker({
            storage: { get: () => undefined, update },
            fetchImpl: async () => okResponse({
                tag_name: 'v1.5.0',
                name: 'v1.5.0',
                assets: [{ name: 'graycode-1.5.0.vsix', browser_download_url: 'https://example.com/graycode-1.5.0.vsix' }],
            }),
            currentVersion: '1.4.4',
        });
        await checker.check();
        expect(checker.getStatus().state).toBe('updateAvailable');

        checker.resetStatus();
        expect(checker.getStatus()).toEqual({ state: 'idle' });
        expect(update).toHaveBeenCalledWith('lastUpdateCheckAt', 0);

        // 重置后节流窗口已清除，再次 check（非 force）会重新发起请求
        const fetchImpl = jest.fn(async () => okResponse({ tag_name: 'v1.4.4', assets: [] }));
        const { checker: checker2 } = createChecker({ fetchImpl, currentVersion: '1.4.4' });
        await checker2.check();
        checker2.resetStatus();
        const status = await checker2.check();
        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect(status.state).toBe('upToDate');
    });
});

describe('UpdateChecker.downloadAndInstall', () => {
    let tmpDir: string;
    beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-update-install-')); });
    afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

    it('无 vsix 资产时抛错', async () => {
        const { checker } = createChecker();
        await expect(checker.downloadAndInstall({
            version: '1.5.0', tagName: 'v1.5.0', name: '', body: '', publishedAt: '',
        })).rejects.toThrow(/非法下载地址/);
    });

    it('下载成功并调用 installExtension 命令', async () => {
        (vscode.commands.executeCommand as jest.Mock).mockResolvedValueOnce(undefined);
        const { checker } = createChecker({
            fetchImpl: async () => new Response(Buffer.from('VSIX-CONTENT'), { status: 200 }),
        });
        const target = await checker.downloadAndInstall({
            version: '1.5.0',
            tagName: 'v1.5.0',
            name: '',
            body: '',
            publishedAt: '',
            vsixAssetUrl: 'https://github.com/Komeiji-Shiki/Gray-Code/releases/download/v1.5.0/graycode-1.5.0.vsix',
        });
        expect(target).toContain('graycode-1.5.0.vsix');
        expect(fs.existsSync(target)).toBe(true);
        expect(fs.readFileSync(target, 'utf-8')).toBe('VSIX-CONTENT');
        expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
            'workbench.extensions.installExtension',
            expect.objectContaining({ fsPath: target })
        );
    });

    it('下载 HTTP 失败时抛错且不安装', async () => {
        (vscode.commands.executeCommand as jest.Mock).mockClear();
        const { checker } = createChecker({
            fetchImpl: async () => new Response('Not Found', { status: 404 }),
        });
        await expect(checker.downloadAndInstall({
            version: '1.5.0', tagName: 'v1.5.0', name: '', body: '', publishedAt: '', vsixAssetUrl: 'https://github.com/Komeiji-Shiki/Gray-Code/releases/download/v1.5.0/graycode-1.5.0.vsix',
        })).rejects.toThrow(/404/);
        expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
    });

    it('下载内容为空时抛错且不安装', async () => {
        (vscode.commands.executeCommand as jest.Mock).mockClear();
        const { checker } = createChecker({
            fetchImpl: async () => new Response('', { status: 200 }),
        });
        await expect(checker.downloadAndInstall({
            version: '1.5.0', tagName: 'v1.5.0', name: '', body: '', publishedAt: '', vsixAssetUrl: 'https://github.com/Komeiji-Shiki/Gray-Code/releases/download/v1.5.0/graycode-1.5.0.vsix',
        })).rejects.toThrow(/空/);
        expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
    });
});
