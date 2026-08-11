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
    resolveReleaseChannel,
    pickInstallerAsset,
    UPDATE_CHECK_INTERVAL_MS,
} from '../../modules/update/UpdateChecker';
import * as vscode from 'vscode';

// ─── 纯函数 ──────────────────────────────────────────

describe('stripVersionPrefix', () => {
    test('剥离 v 前缀', () => {
        expect(stripVersionPrefix('v1.2.3')).toBe('1.2.3');
        expect(stripVersionPrefix('V1.2.3')).toBe('1.2.3');
    });

    test('无前缀原样返回', () => {
        expect(stripVersionPrefix('1.2.3')).toBe('1.2.3');
        expect(stripVersionPrefix('')).toBe('');
    });
});

describe('compareVersions', () => {
    test('相等返回 0（含 v 前缀差异）', () => {
        expect(compareVersions('1.4.4', 'v1.4.4')).toBe(0);
        expect(compareVersions('1.4.4', '1.4.4')).toBe(0);
    });

    test('常规大小比较', () => {
        expect(compareVersions('1.4.5', '1.4.4')).toBe(1);
        expect(compareVersions('1.3.9', '1.4.0')).toBe(-1);
        expect(compareVersions('2.0.0', '1.9.9')).toBe(1);
    });

    test('段数不足按 0 补齐', () => {
        expect(compareVersions('1.4', '1.4.0')).toBe(0);
        expect(compareVersions('1.4.1', '1.4')).toBe(1);
        expect(compareVersions('1.4', '1.4.1')).toBe(-1);
    });

    test('非数字段按 0 处理', () => {
        expect(compareVersions('1.4.x', '1.4.0')).toBe(0);
    });

    it('dash 构建号与点号形式等价（1.7.5-2dev ↔ 1.7.5.2dev）', () => {
        expect(compareVersions('1.7.5-2dev', '1.7.5.2dev')).toBe(0);
        expect(compareVersions('1.7.6-1', '1.7.6.1')).toBe(0);
        expect(compareVersions('v1.7.5.1dev', '1.7.5-1dev')).toBe(0);
    });

    it('dash 构建号递增可识别（1.7.5-3dev > 1.7.5-2dev，不再丢失构建号）', () => {
        expect(compareVersions('1.7.5-3dev', '1.7.5-2dev')).toBe(1);
        expect(compareVersions('1.7.5-2dev', '1.7.5-3dev')).toBe(-1);
        expect(compareVersions('1.7.5-3dev', '1.7.6.1')).toBe(-1);
    });

    it('语义预发布（-beta 等）仍判为旧', () => {
        expect(compareVersions('1.0.0-beta', '1.0.0')).toBe(-1);
        expect(compareVersions('1.0.0', '1.0.0-beta')).toBe(1);
        expect(compareVersions('1.0.0-alpha', '1.0.0-beta')).toBe(-1);
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

    test('force 总是检查', () => {
        expect(shouldCheck(now, now + 1, true)).toBe(true);
    });

    test('无上次记录时检查', () => {
        expect(shouldCheck(undefined, now, false)).toBe(true);
    });

    test('间隔内不检查', () => {
        expect(shouldCheck(now - UPDATE_CHECK_INTERVAL_MS + 1, now, false)).toBe(false);
        expect(shouldCheck(now, now, false)).toBe(false);
    });

    test('超过间隔检查', () => {
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

    test('响应格式异常返回 null', () => {
        expect(parseReleaseResponse(null)).toBeNull();
        expect(parseReleaseResponse('oops')).toBeNull();
        expect(parseReleaseResponse({})).toBeNull();
        expect(parseReleaseResponse({ tag_name: 123 })).toBeNull();
    });

    it('installed 形态优先 Setup 安装包', () => {
        const info = parseReleaseResponse({
            tag_name: 'v1.7.6.1',
            assets: [
                { name: 'GrayCode-Portable-1.7.6-1.exe', browser_download_url: 'https://example.com/P.exe' },
                { name: 'GrayCode.Setup.1.7.6-1.exe', browser_download_url: 'https://example.com/S.exe' },
            ],
        });
        expect(info!.installerAssetUrl).toContain('S.exe');
    });

    it('portable 形态优先便携版 exe（绝不把便携用户拉进安装版）', () => {
        const info = parseReleaseResponse({
            tag_name: 'v1.7.5.2dev',
            assets: [
                { name: 'GrayCode.Setup.1.7.5-2dev.exe', browser_download_url: 'https://example.com/S.exe' },
                { name: 'GrayCode-Portable-1.7.5-2dev.exe', browser_download_url: 'https://example.com/P.exe' },
            ],
        }, 'portable');
        expect(info!.installerAssetUrl).toContain('P.exe');
    });

    it('portable 形态无便携资产时回退 Setup（仍有更新可装）', () => {
        const info = parseReleaseResponse({
            tag_name: 'v1.7.6.1',
            assets: [
                { name: 'GrayCode.Setup.1.7.6-1.exe', browser_download_url: 'https://example.com/S.exe' },
            ],
        }, 'portable');
        expect(info!.installerAssetUrl).toContain('S.exe');
    });

    it('pickInstallerAsset：无匹配时回退 zip', () => {
        const asset = pickInstallerAsset(
            [{ name: 'GrayCode-1.7.6.1-win.zip', browser_download_url: 'https://example.com/Z.zip' }],
            'portable',
        );
        expect(asset?.browser_download_url).toContain('Z.zip');
        expect(pickInstallerAsset([{ name: 'source.zip', browser_download_url: 'x' }], 'installed')).toBeUndefined();
    });
});

describe('resolveReleaseChannel', () => {
    it('dev 后缀归入 dev 通道（tag/根版本/electron-builder 三种命名）', () => {
        expect(resolveReleaseChannel('1.7.5.2dev')).toBe('dev');
        expect(resolveReleaseChannel('v1.7.5dev')).toBe('dev');
        expect(resolveReleaseChannel('1.7.5-2dev')).toBe('dev');
        expect(resolveReleaseChannel('v1.7.5.1dev')).toBe('dev');
    });

    it('正式版归入 stable 通道', () => {
        expect(resolveReleaseChannel('1.7.6.1')).toBe('stable');
        expect(resolveReleaseChannel('v1.6.9')).toBe('stable');
        expect(resolveReleaseChannel('1.7.6-1')).toBe('stable');
        expect(resolveReleaseChannel('')).toBe('stable');
    });

    it('历史手动 tag（dev、dev-1.7.1）按 dev 处理但版本恒为 0 不参与竞争', () => {
        expect(resolveReleaseChannel('dev')).toBe('dev');
        expect(resolveReleaseChannel('dev-1.7.1')).toBe('dev');
        expect(compareVersions('dev-1.7.1', '1.7.5.2dev')).toBe(-1);
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
    test('关闭自动检查时状态为 disabled 且不发请求', async () => {
        const fetchImpl = jest.fn();
        const { checker } = createChecker({ isCheckEnabled: () => false, fetchImpl });
        const status = await checker.check();
        expect(status).toEqual({ state: 'disabled' });
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('关闭自动检查时 force 手动检查仍执行（修复：禁用自动检查后手动检查失效）', async () => {
        const fetchImpl = jest.fn(async () => okResponse({
            tag_name: 'v1.5.0',
            name: 'v1.5.0',
            body: 'new',
            assets: [{ name: 'GrayCode.Setup.1.5.0.exe', browser_download_url: 'https://example.com/GrayCode.Setup.1.5.0.exe' }],
        }));
        const { checker } = createChecker({
            isCheckEnabled: () => false,
            fetchImpl,
            currentVersion: '1.4.4',
        });
        const status = await checker.check(true);
        expect(status.state).toBe('updateAvailable');
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        // 状态机正常推进，不是 disabled
        expect(checker.getStatus().state).not.toBe('disabled');
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

    test('有新版本时返回 updateAvailable 并记录检查时间', async () => {
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

    test('已是最新版本时返回 upToDate', async () => {
        const { checker } = createChecker({
            fetchImpl: async () => okResponse({ tag_name: 'v1.4.4', assets: [] }),
            currentVersion: '1.4.4',
        });
        const status = await checker.check();
        expect(status).toEqual({ state: 'upToDate', checkedAt: 2_000_000 });
    });

    test('fetch 失败时状态为 error（不抛出）且仍记录时间戳', async () => {
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

    test('API 返回非 2xx 时状态为 error', async () => {
        const { checker } = createChecker({
            fetchImpl: async () => okResponse({ message: 'rate limited' }, 403),
        });
        const status = await checker.check();
        expect(status.state).toBe('error');
        if (status.state === 'error') {
            expect(status.message).toContain('403');
        }
    });

    test('API 响应格式异常时状态为 error', async () => {
        const { checker } = createChecker({
            fetchImpl: async () => okResponse({ unexpected: true }),
        });
        const status = await checker.check();
        expect(status.state).toBe('error');
    });

    it('稳定版用户只匹配 stable release：dev release 不污染更新提示', async () => {
        // 列表按创建时间倒序（dev 最新创建在最前，若按时间取会误命中 dev）
        const { checker } = createChecker({
            fetchImpl: async () => okResponse([
                release('v1.7.7dev', ['GrayCode.Setup.1.7.7-dev.exe']),
                release('v1.7.6.1', ['GrayCode.Setup.1.7.6-1.exe']),
            ]),
            currentVersion: '1.7.6.1',
        });
        const status = await checker.check();
        expect(status).toEqual({ state: 'upToDate', checkedAt: 2_000_000 });
    });

    it('稳定版用户可升级到更新的 stable release（列表含更高 dev 也不选它）', async () => {
        const { checker } = createChecker({
            fetchImpl: async () => okResponse([
                release('v1.7.7dev', ['GrayCode.Setup.1.7.7-dev.exe']),
                release('v1.7.6.2', ['GrayCode.Setup.1.7.6-2.exe']),
            ]),
            currentVersion: '1.7.6.1',
        });
        const status = await checker.check();
        expect(status.state).toBe('updateAvailable');
        if (status.state === 'updateAvailable') {
            expect(status.update.version).toBe('1.7.6.2');
            expect(status.update.installerAssetUrl).toContain('GrayCode.Setup.1.7.6-2.exe');
        }
    });

    it('dev 用户只匹配 dev release：stable 更高也不跨通道提示', async () => {
        const { checker } = createChecker({
            fetchImpl: async () => okResponse([
                release('v1.7.6.1', ['GrayCode.Setup.1.7.6-1.exe']),
                release('v1.7.5.2dev', ['GrayCode.Setup.1.7.5-2dev.exe']),
            ]),
            currentVersion: '1.7.5.1dev',
        });
        const status = await checker.check();
        expect(status.state).toBe('updateAvailable');
        if (status.state === 'updateAvailable') {
            expect(status.update.version).toBe('1.7.5.2dev');
            expect(status.update.installerAssetUrl).toContain('GrayCode.Setup.1.7.5-2dev.exe');
        }
    });

    it('dev 通道无候选时回退 stable（dev 用户至少能收到正式版更新提示）', async () => {
        const { checker } = createChecker({
            fetchImpl: async () => okResponse([
                release('v1.7.6.1', ['GrayCode.Setup.1.7.6-1.exe']),
            ]),
            currentVersion: '1.7.5.2dev',
        });
        const status = await checker.check();
        expect(status.state).toBe('updateAvailable');
        if (status.state === 'updateAvailable') {
            expect(status.update.version).toBe('1.7.6.1');
        }
    });

    it('列表内按版本号取最高（忽略创建顺序）', async () => {
        const { checker } = createChecker({
            fetchImpl: async () => okResponse([
                release('v1.7.6.1', ['GrayCode.Setup.1.7.6-1.exe']),
                release('v1.7.5', ['GrayCode.Setup.1.7.5.exe']),
                release('v1.7.6', ['GrayCode.Setup.1.7.6.exe']),
            ]),
            currentVersion: '1.7.5',
        });
        const status = await checker.check();
        expect(status.state).toBe('updateAvailable');
        if (status.state === 'updateAvailable') {
            expect(status.update.version).toBe('1.7.6.1');
        }
    });
});

/** 构造单个 release 对象（测试用） */
function release(tagName: string, assetNames: string[]): Record<string, unknown> {
    return {
        tag_name: tagName,
        name: tagName,
        body: '',
        published_at: '2026-08-09T00:00:00Z',
        assets: assetNames.map(name => ({
            name,
            browser_download_url: `https://example.com/download/${name}`,
        })),
    };
}

describe('UpdateChecker.resetStatus', () => {
    test('清除内存状态并重置节流时间戳（渠道切换时调用，避免旧渠道缓存残留）', async () => {
        const update = jest.fn(async () => {});
        const { checker } = createChecker({
            storage: { get: () => undefined, update },
            fetchImpl: async () => okResponse({
                tag_name: 'v1.5.0',
                name: 'v1.5.0',
                assets: [{ name: 'GrayCode.Setup.1.5.0.exe', browser_download_url: 'https://example.com/GrayCode.Setup.1.5.0.exe' }],
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
