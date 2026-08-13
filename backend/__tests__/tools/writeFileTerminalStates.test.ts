/**
 * write_file handler 的 diff 审阅终态组装测试（发现 04 / 任务 02#20-A）。
 *
 * 覆盖四条终态路径：
 *  - 接受（waitForDiffResolution → 'none'，finalDiff accepted）
 *  - 拒绝（waitForDiffResolution → 'rejected'）
 *  - 取消/中断（waitForDiffResolution → 'abort' / 'user'）
 *  - autoSave 失败（waitForDiffResolution → 'none'，finalDiff 存在且状态非 accepted，带 autoSaveError）
 *
 * 重点断言：wasAccepted 判定、status/success/error/autoSaveError 字段语义，
 * 以及 resolveDiffOutcome 保存的 diffContentId 与 pendingDiffId 是否真实回传到结果。
 */

import * as vscode from 'vscode';
import { registerWriteFile } from '../../tools/file/write_file';

const mockDiffManager = {
    createPendingDiff: jest.fn(),
    getDiff: jest.fn(),
    waitForDiffResolution: jest.fn(),
    prewarmDocument: jest.fn()
};

const mockDiffStorageManager = {
    saveGlobalDiff: jest.fn(),
    saveGlobalDiffDeferred: jest.fn()
};

jest.mock('../../core/services/diffManager', () => ({
    getDiffManager: () => mockDiffManager
}));

jest.mock('../../modules/conversation', () => ({
    getDiffStorageManager: () => mockDiffStorageManager
}));

jest.mock('fs', () => ({
    existsSync: jest.fn(),
    mkdirSync: jest.fn(),
    writeFileSync: jest.fn(),
    readFileSync: jest.fn(),
    unlinkSync: jest.fn(),
    promises: {
        mkdir: jest.fn(),
        writeFile: jest.fn(),
        stat: jest.fn(),
        readFile: jest.fn()
    }
}));

describe('write_file 终态语义（diff 审阅）', () => {
    beforeEach(() => {
        jest.clearAllMocks();

        (vscode.workspace as any).workspaceFolders = [{
            name: 'project',
            uri: vscode.Uri.file('/workspace/project')
        }];

        // 已存在文件：stat 成功 + readFile 返回原始内容（与写入内容不同 → 进入 diff 审阅）
        (vscode.workspace.fs.stat as jest.Mock).mockResolvedValue({ size: 1024 });
        (vscode.workspace.fs.readFile as jest.Mock).mockResolvedValue(
            new TextEncoder().encode('original content')
        );

        mockDiffManager.createPendingDiff.mockResolvedValue({ id: 'pending-diff-1', status: 'pending' });
        mockDiffManager.prewarmDocument.mockReturnValue(undefined);
        mockDiffStorageManager.saveGlobalDiff.mockResolvedValue({ diffId: 'content-id-1' });
    });

    async function runWriteFile(args: Record<string, unknown>, context?: Record<string, unknown>) {
        const tool = registerWriteFile();
        return tool.handler(args, context as any);
    }

    function assertCommonPassthrough(entry: any) {
        // resolveDiffOutcome 保存 diff 内容得到的 id 与 pending diff id 应恒回传
        expect(entry.diffContentId).toBe('content-id-1');
        expect(entry.pendingDiffId).toBe('pending-diff-1');
        expect(entry.path).toBe('sample.ts');
    }

    test('接受：status=accepted、success=true、无 error、action=modified', async () => {
        mockDiffManager.waitForDiffResolution.mockResolvedValue('none');
        mockDiffManager.getDiff.mockReturnValue({ id: 'pending-diff-1', status: 'accepted' });

        const result = await runWriteFile({ path: 'sample.ts', content: 'new content' }, { toolId: 'tool-1' });
        const entry = result.data.results[0];

        expect(result.success).toBe(true);
        expect(result.cancelled).toBe(false);
        expect(entry).toMatchObject({
            path: 'sample.ts',
            success: true,
            action: 'modified',
            status: 'accepted'
        });
        expect(entry.error).toBeUndefined();
        expect(entry.autoSaveError).toBeUndefined();
        expect(entry.cancelled).toBeUndefined();
        assertCommonPassthrough(entry);
        expect(mockDiffManager.createPendingDiff).toHaveBeenCalledTimes(1);
    });

    test('拒绝：status=rejected、success=false、cancelled=false、error=拒绝文案', async () => {
        mockDiffManager.waitForDiffResolution.mockResolvedValue('rejected');
        mockDiffManager.getDiff.mockReturnValue({ id: 'pending-diff-1', status: 'rejected' });

        const result = await runWriteFile({ path: 'sample.ts', content: 'new content' }, { toolId: 'tool-1' });
        const entry = result.data.results[0];

        expect(result.success).toBe(false);
        expect(result.cancelled).toBe(false);
        expect(result.error).toBe('1 file failed to write');

        expect(entry).toMatchObject({
            path: 'sample.ts',
            success: false,
            action: 'modified',
            status: 'rejected',
            cancelled: false
        });
        expect(entry.error).toBe('Diff was rejected by user');
        expect(entry.autoSaveError).toBeUndefined();
        assertCommonPassthrough(entry);
    });

    test('新文件拒绝后的清理失败会在结果中明确透传', async () => {
        const cleanupError = 'Failed to clean up pre-created file "sample.ts": file is locked';
        mockDiffManager.waitForDiffResolution.mockResolvedValue('rejected');
        mockDiffManager.getDiff.mockReturnValue({
            id: 'pending-diff-1',
            status: 'rejected',
            cleanupError
        });

        const result = await runWriteFile({ path: 'sample.ts', content: 'new content' }, { toolId: 'tool-1' });
        const entry = result.data.results[0];

        expect(result.success).toBe(false);
        expect(entry.cleanupError).toBe(cleanupError);
        expect(entry.error).toBe(`Diff was rejected by user. ${cleanupError}`);
    });

    test.each([
        ['abort', 'Write was cancelled by user'],
        ['user', 'Write was interrupted by user']
    ])('取消/中断（reason=%s）：cancelled=true、status=rejected、error=%s', async (reason, expectedError) => {
        mockDiffManager.waitForDiffResolution.mockResolvedValue(reason);
        // 中断路径下 finalDiff 内容不影响 wasInterrupted 判定
        mockDiffManager.getDiff.mockReturnValue(undefined);

        const result = await runWriteFile({ path: 'sample.ts', content: 'new content' }, { toolId: 'tool-1' });
        const entry = result.data.results[0];

        expect(result.success).toBe(false);
        expect(result.cancelled).toBe(true);
        expect(result.error).toBe('Write was cancelled by user');

        expect(entry).toMatchObject({
            path: 'sample.ts',
            success: false,
            action: 'modified',
            status: 'rejected',
            cancelled: true
        });
        expect(entry.error).toBe(expectedError);
        expect(entry.autoSaveError).toBeUndefined();
        assertCommonPassthrough(entry);
    });

    test('autoSave 失败：success=false、status=rejected、error/autoSaveError 透传', async () => {
        const autoSaveError = 'Auto-save failed while accepting diff. The diff was rejected to unblock tool execution.';
        mockDiffManager.waitForDiffResolution.mockResolvedValue('none');
        mockDiffManager.getDiff.mockReturnValue({ id: 'pending-diff-1', status: 'rejected', autoSaveError });

        const result = await runWriteFile({ path: 'sample.ts', content: 'new content' }, { toolId: 'tool-1' });
        const entry = result.data.results[0];

        expect(result.success).toBe(false);
        expect(result.cancelled).toBe(false);
        expect(result.error).toBe('1 file failed to write');

        expect(entry).toMatchObject({
            path: 'sample.ts',
            success: false,
            status: 'rejected'
        });
        // wasAccepted=false（finalDiff 存在但状态非 accepted），错误来源应为 autoSaveError
        expect(entry.error).toBe(autoSaveError);
        expect(entry.autoSaveError).toBe(autoSaveError);
        expect(entry.cancelled).toBeUndefined();
        assertCommonPassthrough(entry);
    });

    test('边界：空 path 返回 path is required', async () => {
        const result = await runWriteFile({ path: '   ', content: 'x' });
        expect(result).toEqual({ success: false, error: 'path is required' });
        expect(mockDiffManager.createPendingDiff).not.toHaveBeenCalled();
    });

    test('边界：content 非字符串返回 content is required', async () => {
        const result = await runWriteFile({ path: 'sample.ts', content: 123 });
        expect(result).toEqual({ success: false, error: 'content is required' });
        expect(mockDiffManager.createPendingDiff).not.toHaveBeenCalled();
    });

    test('工具契约说明确认前预创建、拒绝清理范围和失败报告', () => {
        const description = registerWriteFile().declaration.description;
        expect(description).toContain('确认前预创建空文件');
        expect(description).toContain('本次新建且仍为空的父目录');
        expect(description).toContain('清理失败');
    });
});
