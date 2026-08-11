/**
 * UpdateHandlers（updateNow / installUpdate）单元测试（fork 桌面版：安装=下载后交系统打开）：
 * 1. updateNow 有新版本：自动下载并打开 + 提示完成安装 + 回复成功
 * 2. updateNow 已是最新：回复 alreadyUpToDate，不下载
 * 3. updateNow 自动检查关闭：报错
 * 4. updateNow 检查失败：报错
 * 5. updateNow 安装失败：报错
 * 6. updateNow 下载完成：提示「安装包已下载并打开」，不执行 reloadWindow
 * 7. installUpdate 无安装包资产：报错
 * 8. updateChecker 未初始化：报错
 */
import * as vscode from 'vscode';
import {
    updateNow,
    installUpdate,
} from '../../../webview/handlers/UpdateHandlers';
import { UpdateChecker, type UpdateInfo } from '../../../backend/modules/update';

const FAKE_UPDATE: UpdateInfo = {
    version: '1.5.0',
    tagName: 'v1.5.0',
    name: 'v1.5.0',
    body: 'new release',
    publishedAt: '2026-08-08T00:00:00Z',
    installerAssetUrl: 'https://example.com/GrayCode.Setup.1.5.0.exe',
};

function createCtx(checker?: UpdateChecker) {
    const sendResponse = jest.fn();
    const sendError = jest.fn();
    return { updateChecker: checker, sendResponse, sendError } as any;
}

function createChecker(status: any, downloadImpl?: jest.Mock) {
    return {
        check: jest.fn(async () => status),
        downloadAndInstall: downloadImpl ?? jest.fn(async (update: UpdateInfo) => {
            if (!update.installerAssetUrl) {
                const err = new Error('该 Release 未附带安装包，请前往 GitHub Releases 手动下载。') as Error & { code?: string };
                err.code = 'UPDATE_NO_ASSET';
                throw err;
            }
            return '/tmp/graycode-1.5.0-setup.exe';
        }),
        getStatus: jest.fn(() => status),
    } as unknown as UpdateChecker;
}

beforeEach(() => {
    (vscode.commands.executeCommand as jest.Mock).mockClear();
    (vscode.window.showInformationMessage as jest.Mock).mockClear();
    (vscode.window.showInformationMessage as jest.Mock).mockResolvedValue(undefined);
});

describe('UpdateHandlers updateNow', () => {
    it('有新版本：自动下载并打开 + 提示完成安装 + 回复成功', async () => {
        const downloadImpl = jest.fn(async () => '/tmp/graycode-1.5.0-setup.exe');
        const checker = createChecker({ state: 'updateAvailable', checkedAt: 1, update: FAKE_UPDATE }, downloadImpl);
        const ctx = createCtx(checker);
        await updateNow({}, 'req_1', ctx);

        expect(checker.check).toHaveBeenCalledWith(true);
        expect(downloadImpl).toHaveBeenCalledWith(FAKE_UPDATE);
        expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
            expect.stringContaining('1.5.0'),
            '确定'
        );
        expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
        expect(ctx.sendError).not.toHaveBeenCalled();
        expect(ctx.sendResponse).toHaveBeenCalledWith('req_1', {
            success: true,
            version: '1.5.0',
            localPath: '/tmp/graycode-1.5.0-setup.exe',
        });
    });

    test('已是最新版本：回复 alreadyUpToDate，不触发下载', async () => {
        const downloadImpl = jest.fn();
        const checker = createChecker({ state: 'upToDate', checkedAt: 1 }, downloadImpl);
        const ctx = createCtx(checker);
        await updateNow({}, 'req_2', ctx);

        expect(downloadImpl).not.toHaveBeenCalled();
        expect(ctx.sendResponse).toHaveBeenCalledWith('req_2', { success: true, alreadyUpToDate: true });
        expect(ctx.sendError).not.toHaveBeenCalled();
    });

    test('自动检查关闭：报错（结构化错误码 UPDATE_NOW_DISABLED）', async () => {
        const checker = createChecker({ state: 'disabled' });
        const ctx = createCtx(checker);
        await updateNow({}, 'req_3', ctx);

        expect(ctx.sendResponse).not.toHaveBeenCalled();
        expect(ctx.sendError).toHaveBeenCalledWith('req_3', 'UPDATE_NOW_DISABLED', expect.stringContaining('关闭'));
    });

    test('检查失败：报错（结构化错误码 UPDATE_NOW_ERROR）', async () => {
        const checker = createChecker({ state: 'error', checkedAt: 1, message: 'network down' });
        const ctx = createCtx(checker);
        await updateNow({}, 'req_4', ctx);

        expect(ctx.sendError).toHaveBeenCalledWith('req_4', 'UPDATE_NOW_ERROR', expect.stringContaining('network down'));
    });

    test('安装失败：报错', async () => {
        const downloadImpl = jest.fn(async () => { throw new Error('下载失败：HTTP 500'); });
        const checker = createChecker({ state: 'updateAvailable', checkedAt: 1, update: FAKE_UPDATE }, downloadImpl);
        const ctx = createCtx(checker);
        await updateNow({}, 'req_5', ctx);

        expect(ctx.sendResponse).not.toHaveBeenCalled();
        expect(ctx.sendError).toHaveBeenCalledWith('req_5', 'UPDATE_NOW_ERROR', expect.stringContaining('500'));
    });

    it('下载完成后提示完成安装，不执行 reloadWindow', async () => {
        (vscode.window.showInformationMessage as jest.Mock).mockResolvedValue('确定');
        const checker = createChecker({ state: 'updateAvailable', checkedAt: 1, update: FAKE_UPDATE });
        const ctx = createCtx(checker);
        await updateNow({}, 'req_6', ctx);

        expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
        expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
            expect.stringContaining('安装包已下载并打开'),
            '确定'
        );
    });
});

describe('UpdateHandlers installUpdate', () => {
    it('版本与 checker 当前状态不一致：拒绝（不信任渲染层传入的更新对象）', async () => {
        const checker = createChecker({ state: 'updateAvailable', checkedAt: 1, update: FAKE_UPDATE });
        const ctx = createCtx(checker);
        await installUpdate({ update: { ...FAKE_UPDATE, version: '9.9.9' } }, 'req_7', ctx);

        expect(ctx.sendResponse).not.toHaveBeenCalled();
        expect(ctx.sendError).toHaveBeenCalledWith('req_7', 'INSTALL_UPDATE_NO_ASSET', expect.any(String));
    });

    it('checker 解析的更新无安装包资产：透传 UPDATE_NO_ASSET 码', async () => {
        const noAssetUpdate = { ...FAKE_UPDATE, installerAssetUrl: undefined };
        const checker = createChecker({ state: 'updateAvailable', checkedAt: 1, update: noAssetUpdate });
        const ctx = createCtx(checker);
        await installUpdate({ update: noAssetUpdate }, 'req_7', ctx);

        expect(ctx.sendResponse).not.toHaveBeenCalled();
        // checker.downloadAndInstall 抛出的结构化码经 handler 透传（本地化映射依赖它）
        expect(ctx.sendError).toHaveBeenCalledWith('req_7', 'UPDATE_NO_ASSET', expect.stringContaining('未附带安装包'));
    });

    it('下载失败时透传 checker 抛出的结构化错误码（UPDATE_LAUNCH_FAILED）', async () => {
        const launchErr = new Error('launch blocked') as Error & { code?: string };
        launchErr.code = 'UPDATE_LAUNCH_FAILED';
        const downloadImpl = jest.fn(async () => { throw launchErr; });
        const checker = createChecker({ state: 'updateAvailable', checkedAt: 1, update: FAKE_UPDATE }, downloadImpl);
        const ctx = createCtx(checker);
        await installUpdate({ update: FAKE_UPDATE }, 'req_8', ctx);

        expect(ctx.sendResponse).not.toHaveBeenCalled();
        expect(ctx.sendError).toHaveBeenCalledWith('req_8', 'UPDATE_LAUNCH_FAILED', expect.stringContaining('launch blocked'));
    });

    it('正常下载并回复成功', async () => {
        const downloadImpl = jest.fn(async () => '/tmp/graycode-1.5.0-setup.exe');
        const checker = createChecker({ state: 'updateAvailable', checkedAt: 1, update: FAKE_UPDATE }, downloadImpl);
        const ctx = createCtx(checker);
        await installUpdate({ update: FAKE_UPDATE }, 'req_8', ctx);

        expect(downloadImpl).toHaveBeenCalledWith(FAKE_UPDATE);
        expect(ctx.sendResponse).toHaveBeenCalledWith('req_8', {
            success: true,
            version: '1.5.0',
            localPath: '/tmp/graycode-1.5.0-setup.exe',
        });
    });
});

describe('UpdateHandlers 公共', () => {
    test('updateChecker 未初始化：报错', async () => {
        const ctx = createCtx(undefined);
        await updateNow({}, 'req_9', ctx);
        expect(ctx.sendResponse).not.toHaveBeenCalled();
        expect(ctx.sendError).toHaveBeenCalledWith('req_9', 'UPDATE_NOW_ERROR', expect.stringContaining('not initialized'));
    });
});
