/**
 * UpdateHandlers（updateNow / installUpdate）单元测试：
 * 1. updateNow 有新版本：自动下载安装 + 提示 reload + 回复成功
 * 2. updateNow 已是最新：回复 alreadyUpToDate，不下载
 * 3. updateNow 自动检查关闭：报错
 * 4. updateNow 检查失败：报错
 * 5. updateNow 安装失败：报错
 * 6. updateNow 用户点「立即重新加载」：执行 reloadWindow 命令
 * 7. installUpdate 无 vsix 资产：报错
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
    vsixAssetUrl: 'https://example.com/graycode-1.5.0.vsix',
};

function createCtx(checker?: UpdateChecker) {
    const sendResponse = jest.fn();
    const sendError = jest.fn();
    return { updateChecker: checker, sendResponse, sendError } as any;
}

function createChecker(status: any, downloadImpl?: jest.Mock) {
    return {
        check: jest.fn(async () => status),
        downloadAndInstall: downloadImpl ?? jest.fn(async () => '/tmp/graycode-1.5.0.vsix'),
        getStatus: jest.fn(() => status),
    } as unknown as UpdateChecker;
}

beforeEach(() => {
    (vscode.commands.executeCommand as jest.Mock).mockClear();
    (vscode.window.showInformationMessage as jest.Mock).mockClear();
    (vscode.window.showInformationMessage as jest.Mock).mockResolvedValue(undefined);
});

describe('UpdateHandlers updateNow', () => {
    test('有新版本：自动下载安装 + 提示 reload + 回复成功', async () => {
        const downloadImpl = jest.fn(async () => '/tmp/graycode-1.5.0.vsix');
        const checker = createChecker({ state: 'updateAvailable', checkedAt: 1, update: FAKE_UPDATE }, downloadImpl);
        const ctx = createCtx(checker);
        await updateNow({}, 'req_1', ctx);

        expect(checker.check).toHaveBeenCalledWith(true);
        expect(downloadImpl).toHaveBeenCalledWith(FAKE_UPDATE);
        expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
            expect.stringContaining('1.5.0'),
            '立即重新加载'
        );
        expect(ctx.sendError).not.toHaveBeenCalled();
        expect(ctx.sendResponse).toHaveBeenCalledWith('req_1', {
            success: true,
            version: '1.5.0',
            localPath: '/tmp/graycode-1.5.0.vsix',
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

    test('自动检查关闭：报错', async () => {
        const checker = createChecker({ state: 'disabled' });
        const ctx = createCtx(checker);
        await updateNow({}, 'req_3', ctx);

        expect(ctx.sendResponse).not.toHaveBeenCalled();
        expect(ctx.sendError).toHaveBeenCalledWith('req_3', 'UPDATE_NOW_ERROR', expect.stringContaining('关闭'));
    });

    test('检查失败：报错', async () => {
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

    test('用户点「立即重新加载」：执行 reloadWindow 命令', async () => {
        (vscode.window.showInformationMessage as jest.Mock).mockResolvedValue('立即重新加载');
        const checker = createChecker({ state: 'updateAvailable', checkedAt: 1, update: FAKE_UPDATE });
        const ctx = createCtx(checker);
        await updateNow({}, 'req_6', ctx);

        expect(vscode.commands.executeCommand).toHaveBeenCalledWith('workbench.action.reloadWindow');
    });
});

describe('UpdateHandlers installUpdate', () => {
    test('无 vsix 资产：报错', async () => {
        const checker = createChecker({ state: 'updateAvailable', checkedAt: 1, update: FAKE_UPDATE });
        const ctx = createCtx(checker);
        await installUpdate({ update: { ...FAKE_UPDATE, vsixAssetUrl: undefined } }, 'req_7', ctx);

        expect(ctx.sendResponse).not.toHaveBeenCalled();
        expect(ctx.sendError).toHaveBeenCalledWith('req_7', 'INSTALL_UPDATE_ERROR', expect.any(String));
    });

    test('正常下载安装并回复成功', async () => {
        const downloadImpl = jest.fn(async () => '/tmp/graycode-1.5.0.vsix');
        const checker = createChecker({ state: 'updateAvailable', checkedAt: 1, update: FAKE_UPDATE }, downloadImpl);
        const ctx = createCtx(checker);
        await installUpdate({ update: FAKE_UPDATE }, 'req_8', ctx);

        expect(downloadImpl).toHaveBeenCalledWith(FAKE_UPDATE);
        expect(ctx.sendResponse).toHaveBeenCalledWith('req_8', {
            success: true,
            version: '1.5.0',
            localPath: '/tmp/graycode-1.5.0.vsix',
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
