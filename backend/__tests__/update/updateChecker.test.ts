/**
 * UpdateChecker 单元测试（fork 桌面版：安装包为 exe/zip，安装动作=下载后交系统打开）：
 * 1. 纯函数：stripVersionPrefix / compareVersions / shouldCheck / parseReleaseResponse
 * 2. UpdateChecker.check：开关、24h 节流、新版本判定、失败静默、时间戳记录
 * 3. UpdateChecker.downloadAndInstall：无安装包资产、下载成功并打开、下载失败、空内容
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

describe('parseReleaseResponse', () => {
    it('解析正常响应（优先 Setup 安装包资产）', () => {
        const info = parseReleaseResponse({
            tag_name: 'v1.4.5',
            name: 'Gray Code 1.4.5',
            body: '## 更新内容\n- 修复 bug',
            published_at: '2026-08-08T00:00:00Z',
            assets: [
                { name: 'GrayCode-Portable-1.4.5.exe', browser_download_url: 'https://github.com/x/y/releases/download/v1.4.5/GrayCode-Portable-1.4.5.exe' },
                { name: 'GrayCode.Setup.1.4.5.exe', browser_download_url: 'https://github.com/x/y/releases/download/v1.4.5/GrayCode.Setup.1.4.5.exe' },
                { name: 'source.zip', browser_download_url: 'https://example.com/source.zip' },
            ],
        });
        expect(info).not.toBeNull();
        expect(info!.version).toBe('1.4.5');
        expect(info!.tagName).toBe('v1.4.5');
        expect(info!.name).toBe('Gray Code 1.4.5');
        expect(info!.body).toContain('修复 bug');
        expect(info!.installerAssetUrl).toContain('GrayCode.Setup.1.4.5.exe');
        expect(info!.publishedAt).toBe('2026-08-08T00:00:00Z');
    });

    it('无 Setup 安装包时回退任意 exe（便携版）', () => {
        const info = parseReleaseResponse({
            tag_name: 'v1.4.5',
            assets: [
                { name: 'GrayCode-Portable-1.4.5.exe', browser_download_url: 'https://example.com/GrayCode-Portable-1.4.5.exe' },
            ],
        });
        expect(info).not.toBeNull();
        expect(info!.installerAssetUrl).toContain('GrayCode-Portable-1.4.5.exe');
    });

    it('无 exe 时回退 zip（免安装包）', () => {
        const info = parseReleaseResponse({
            tag_name: 'v1.4.5',
            assets: [
                { name: 'GrayCode-1.4.5-win.zip', browser_download_url: 'https://example.com/GrayCode-1.4.5-win.zip' },
            ],
        });
        expect(info).not.toBeNull();
        expect(info!.installerAssetUrl).toContain('GrayCode-1.4.5-win.zip');
    });

    it('无安装包资产时 installerAssetUrl 为 undefined', () => {
        const info = parseReleaseResponse({
            tag_name: 'v1.4.5',
            assets: [{ name: 'source.zip', browser_download_url: 'https://example.com/source.zip' }],
        });
        expect(info).not.toBeNull();
        expect(info!.installerAssetUrl).toBeUndefined();
    });

    it('响应格式异常返回 null', () => {
        expect(parseReleaseResponse(null)).toBeNull();
        expect(parseReleaseResponse('oops')).toBeNull();
        expect(parseReleaseResponse({})).toBeNull();
        expect(parseReleaseResponse({ tag_name: 123 })).toBeNull();
    });
});

// ─── UpdateChecker ───────────────────────────────────

function createChecker(overrides: {
    isCheckEnabled?: () => boolean;
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
                assets: [{ name: 'GrayCode.Setup.1.5.0.exe', browser_download_url: 'https://example.com/GrayCode.Setup.1.5.0.exe' }],
            }),
            currentVersion: '1.4.4',
        });
        const status = await checker.check();
        expect(status.state).toBe('updateAvailable');
        if (status.state === 'updateAvailable') {
            expect(status.update.version).toBe('1.5.0');
            expect(status.update.installerAssetUrl).toContain('GrayCode.Setup.1.5.0.exe');
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
});

describe('UpdateChecker.downloadAndInstall', () => {
    let tmpDir: string;
    beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-update-install-')); });
    afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

    it('无安装包资产时抛错', async () => {
        const { checker } = createChecker();
        await expect(checker.downloadAndInstall({
            version: '1.5.0', tagName: 'v1.5.0', name: '', body: '', publishedAt: '',
        })).rejects.toThrow(/未附带安装包/);
    });

    it('下载成功并交给系统打开（openExternal）', async () => {
        (vscode.env.openExternal as jest.Mock).mockResolvedValueOnce(true);
        const { checker } = createChecker({
            fetchImpl: async () => new Response(Buffer.from('SETUP-EXE-CONTENT'), { status: 200 }),
        });
        const target = await checker.downloadAndInstall({
            version: '1.5.0',
            tagName: 'v1.5.0',
            name: '',
            body: '',
            publishedAt: '',
            installerAssetUrl: 'https://example.com/GrayCode.Setup.1.5.0.exe',
        });
        expect(target).toContain('graycode-1.5.0-setup.exe');
        expect(fs.existsSync(target)).toBe(true);
        expect(fs.readFileSync(target, 'utf-8')).toBe('SETUP-EXE-CONTENT');
        expect(vscode.env.openExternal).toHaveBeenCalledWith(
            expect.objectContaining({ fsPath: target })
        );
    });

    it('下载 HTTP 失败时抛错且不打开', async () => {
        (vscode.env.openExternal as jest.Mock).mockClear();
        const { checker } = createChecker({
            fetchImpl: async () => new Response('Not Found', { status: 404 }),
        });
        await expect(checker.downloadAndInstall({
            version: '1.5.0', tagName: 'v1.5.0', name: '', body: '', publishedAt: '', installerAssetUrl: 'https://example.com/x.exe',
        })).rejects.toThrow(/404/);
        expect(vscode.env.openExternal).not.toHaveBeenCalled();
    });

    it('下载内容为空时抛错且不打开', async () => {
        (vscode.env.openExternal as jest.Mock).mockClear();
        const { checker } = createChecker({
            fetchImpl: async () => new Response('', { status: 200 }),
        });
        await expect(checker.downloadAndInstall({
            version: '1.5.0', tagName: 'v1.5.0', name: '', body: '', publishedAt: '', installerAssetUrl: 'https://example.com/x.exe',
        })).rejects.toThrow(/空/);
        expect(vscode.env.openExternal).not.toHaveBeenCalled();
    });
});
