/**
 * 共享版本规则与桌面更新入口。
 * 原 VSIX 检查用例迁移到 DesktopUpdates；下载和安装结果用例位于 desktopInstaller.test.ts。
 */
import { app as desktopApp, shell as desktopShell } from 'electron';
import { DesktopUpdates } from '../../../apps/desktop/src/updates';
import {
    stripVersionPrefix,
    compareVersions,
    extractNightlyVersionFromName,
} from '../../../shared/updateVersion';

jest.mock('electron', () => ({
    app: { getVersion: jest.fn() },
    shell: { openExternal: jest.fn().mockResolvedValue(undefined) }
}));

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

    test('nightly 预发布视为高于同主版本正式版，nightly 之间按日期比较', () => {
        expect(compareVersions('1.4.6-nightly.20260810', '1.4.6')).toBe(1);
        expect(compareVersions('1.4.6', '1.4.6-nightly.20260809')).toBe(-1);
        expect(compareVersions('1.4.6-nightly.20260810', '1.4.6-nightly.20260809')).toBe(1);
        expect(compareVersions('1.4.6-nightly.20260809', '1.4.6-nightly.20260809')).toBe(0);
        expect(compareVersions('1.4.7', '1.4.6-nightly.20260810')).toBe(1);
    });
});

describe('extractNightlyVersionFromName', () => {
    test('直接使用带 v 前缀的 nightly 版本号作为 Release name', () => {
        expect(extractNightlyVersionFromName('v1.4.6-nightly.20260809')).toBe('1.4.6-nightly.20260809');
    });

    test('从 Release name 提取 nightly 版本号（-nightly.<date> 预发布段，含 v 前缀）', () => {
        expect(extractNightlyVersionFromName('Gray Code Nightly v1.4.6-nightly.20260809')).toBe('1.4.6-nightly.20260809');
    });

    test('无 v 前缀同样可提取', () => {
        expect(extractNightlyVersionFromName('Gray Code Nightly 1.4.6-nightly.20260809')).toBe('1.4.6-nightly.20260809');
    });

    test('版本号后跟多余数字时不截断（锚定结尾）', () => {
        expect(extractNightlyVersionFromName('Gray Code Nightly v1.4.6-nightly.202608090')).toBeNull();
    });

    test('无版本号返回 null', () => {
        expect(extractNightlyVersionFromName('Gray Code Nightly')).toBeNull();
        expect(extractNightlyVersionFromName(undefined)).toBeNull();
        expect(extractNightlyVersionFromName('')).toBeNull();
    });
});

function okResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('桌面更新检查与发行识别', () => {
    let channel: 'stable' | 'nightly';
    let automatic: boolean;
    let updates: DesktopUpdates;
    let fetchMock: jest.SpyInstance;
    const application = {
        product: { runtimeSettings: () => ({ getSettings: () => ({ checkForUpdates: automatic, updateChannel: channel }) }) }
    };
    const release = (version: string, fields: Record<string, unknown> = {}) => ({
        tag_name: version, name: version, body: '更新说明', draft: false, prerelease: false,
        assets: [{ name: 'GrayCode-win32-x64.zip' }], ...fields
    });
    const respond = (body: unknown, status = 200) => fetchMock.mockImplementation(async () => okResponse(body, status));

    beforeEach(() => {
        channel = 'stable';
        automatic = true;
        (desktopApp.getVersion as jest.Mock).mockReturnValue('1.4.4');
        updates = new DesktopUpdates(application as any);
        fetchMock = jest.spyOn(globalThis, 'fetch');
    });
    afterEach(() => { fetchMock.mockRestore(); jest.clearAllMocks(); });

    test('手动检查会刷新已有结果', async () => {
        respond([release('v1.4.4')]);
        await updates.get();
        await updates.check();
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    test('没有检查结果时自动查询', async () => {
        respond([release('v1.4.4')]);
        expect((await updates.get()).status.state).toBe('upToDate');
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    test('解析桌面发行版本、标签、标题和正文', async () => {
        respond([release('v1.4.5', { name: 'Gray Code 1.4.5', body: '## 更新内容\n- 修复 bug' })]);
        expect((await updates.check()).status.update).toMatchObject({
            version: '1.4.5', tagName: 'v1.4.5', name: 'Gray Code 1.4.5', body: expect.stringContaining('修复 bug')
        });
    });

    test('无桌面资产的发行版报告不可用', async () => {
        respond([release('v1.4.5', { assets: [{ name: 'source.zip', browser_download_url: 'https://example.com/source.zip' }] })]);
        expect((await updates.check()).status.state).toBe('unavailable');
    });

    test('异常发行响应与无效版本均不产生更新候选', async () => {
        for (const body of [null, 'oops', {}]) {
            respond(body);
            expect((await updates.check()).status.state).toBe('error');
        }
        respond([release('v1.4.5', { tag_name: 123 })]);
        expect((await updates.check()).status.state).toBe('unavailable');
    });

    test('固定 nightly 标签从发行名称提取真实版本', async () => {
        channel = 'nightly';
        respond([release('nightly', { name: 'v1.4.6-nightly.20260809', prerelease: true })]);
        expect((await updates.check()).status.update).toMatchObject({ version: '1.4.6-nightly.20260809', tagName: 'nightly' });
    });

    test('稳定渠道使用发行标签作为版本来源', async () => {
        respond([release('v1.4.5', { name: '稳定版' })]);
        expect((await updates.check()).status.update).toMatchObject({ version: '1.4.5', tagName: 'v1.4.5' });
    });

    test('关闭自动检查时保持空闲且不发请求', async () => {
        automatic = false;
        expect((await updates.get()).status).toEqual({ state: 'idle' });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    test('重复读取已检查状态时不重复请求', async () => {
        respond([release('v1.4.4')]);
        const first = await updates.get();
        expect((await updates.get()).status).toEqual(first.status);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    test('发现较新版本时返回更新信息并保留结果', async () => {
        respond([release('v1.5.0')]);
        const first = await updates.check();
        expect(first.status).toMatchObject({ state: 'updateAvailable', update: { version: '1.5.0' } });
        expect((await updates.get()).status).toEqual(first.status);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    test('已是最新版本时返回 upToDate', async () => {
        respond([release('v1.4.4')]);
        expect((await updates.check()).status.state).toBe('upToDate');
    });

    test('网络失败转换为错误状态并保留原因', async () => {
        fetchMock.mockRejectedValue(new Error('network down'));
        expect((await updates.check()).status).toMatchObject({ state: 'error', message: expect.stringContaining('network down') });
    });

    test('非成功 HTTP 响应保留状态码', async () => {
        respond({ message: 'rate limited' }, 403);
        expect((await updates.check()).status).toMatchObject({ state: 'error', message: expect.stringContaining('403') });
    });

    test('发行目录响应形状错误时返回 error', async () => {
        respond({ unexpected: true });
        expect((await updates.check()).status.state).toBe('error');
    });

    test('nightly 渠道从官方发行目录识别较新构建', async () => {
        channel = 'nightly';
        (desktopApp.getVersion as jest.Mock).mockReturnValue('1.4.6-nightly.20260809');
        respond([release('nightly', { name: 'Gray Code Nightly v1.4.6-nightly.20260810', prerelease: true })]);
        expect((await updates.check()).status).toMatchObject({ state: 'updateAvailable', update: { version: '1.4.6-nightly.20260810' } });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock).toHaveBeenCalledWith('https://api.github.com/repos/Komeiji-Shiki/Gray-Code/releases?per_page=30',
            expect.objectContaining({ headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'GrayCode-Desktop' } }));
    });

    test('同日期 nightly 构建不提示更新', async () => {
        channel = 'nightly';
        (desktopApp.getVersion as jest.Mock).mockReturnValue('1.4.6-nightly.20260809');
        respond([release('nightly', { name: 'Gray Code Nightly v1.4.6-nightly.20260809', prerelease: true })]);
        expect((await updates.check()).status.state).toBe('upToDate');
    });

    test('同版本 nightly 构建高于当前正式版时提示更新', async () => {
        channel = 'nightly';
        (desktopApp.getVersion as jest.Mock).mockReturnValue('1.4.6');
        respond([release('nightly', { name: 'Gray Code Nightly v1.4.6-nightly.20260809', prerelease: true })]);
        expect((await updates.check()).status.state).toBe('updateAvailable');
    });

    test('nightly 检查返回 404 时报告错误，不另发稳定渠道请求', async () => {
        channel = 'nightly';
        respond({ message: 'Not Found' }, 404);
        expect((await updates.check()).status).toMatchObject({ state: 'error', message: expect.stringContaining('404') });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    test('默认稳定渠道只发一次官方发行目录请求', async () => {
        respond([release('v1.4.4')]);
        await updates.check();
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock).toHaveBeenCalledWith('https://api.github.com/repos/Komeiji-Shiki/Gray-Code/releases?per_page=30',
            expect.objectContaining({ headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'GrayCode-Desktop' } }));
    });

    test('渠道切换后的显式检查替换旧渠道结果', async () => {
        respond([release('v1.5.0')]);
        expect((await updates.check()).status.update.version).toBe('1.5.0');
        channel = 'nightly';
        respond([release('nightly', { name: 'v1.5.0-nightly.20260810', prerelease: true })]);
        expect((await updates.check()).status.update.version).toBe('1.5.0-nightly.20260810');
        expect((await updates.get()).status.update.version).toBe('1.5.0-nightly.20260810');
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    test('缺少自动更新清单时转为手动下载，不调用安装器', async () => {
        const installer = { status: jest.fn(async () => ({ kind: 'installed' })), prepare: jest.fn() };
        updates = new DesktopUpdates(application as any, installer as any);
        respond([release('v1.5.0')]);
        await expect(updates.prepare()).resolves.toMatchObject({ success: true, manual: true });
        expect(desktopShell.openExternal).toHaveBeenCalledWith('https://github.com/Komeiji-Shiki/Gray-Code/releases');
        expect(installer.prepare).not.toHaveBeenCalled();
    });
});
