/**
 * delete_code handler 的 diff 审阅终态组装测试（任务 02#20-A）。
 *
 * 与 write_file/insert_code 共用 resolveDiffOutcome，四条终态路径的字段语义
 * 保持一致，仅 actionLabel（'Delete'）与 per-file 字段（start_line/end_line/deletedLines）不同。
 */

import * as fs from 'fs';
import * as vscode from 'vscode';
import { registerDeleteCode } from '../../tools/file/delete_code';

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

describe('delete_code 终态语义（diff 审阅）', () => {
    beforeEach(() => {
        jest.clearAllMocks();

        (vscode.workspace as any).workspaceFolders = [{
            name: 'project',
            uri: vscode.Uri.file('/workspace/project')
        }];

        // 模拟已存在文件：4 行内容，删除第 2~3 行
        (fs.promises as any).stat.mockResolvedValue({ size: 64 });
        (fs.promises as any).readFile.mockResolvedValue('line1\nline2\nline3\nline4\n');

        mockDiffManager.createPendingDiff.mockResolvedValue({ id: 'pending-diff-1', status: 'pending' });
        mockDiffManager.prewarmDocument.mockReturnValue(undefined);
        mockDiffStorageManager.saveGlobalDiff.mockResolvedValue({ diffId: 'content-id-1' });
    });

    async function runDeleteCode(files: any[], context?: Record<string, unknown>) {
        const tool = registerDeleteCode();
        return tool.handler({ files }, context as any);
    }

    function assertCommonPassthrough(entry: any) {
        expect(entry.diffContentId).toBe('content-id-1');
        expect(entry.pendingDiffId).toBe('pending-diff-1');
        expect(entry.path).toBe('sample.ts');
        expect(entry.start_line).toBe(2);
        expect(entry.end_line).toBe(3);
        expect(entry.deletedLines).toBe(2);
    }

    test('接受：status=accepted、success=true、无 error', async () => {
        mockDiffManager.waitForDiffResolution.mockResolvedValue('none');
        mockDiffManager.getDiff.mockReturnValue({ id: 'pending-diff-1', status: 'accepted' });

        const result = await runDeleteCode([{ path: 'sample.ts', start_line: 2, end_line: 3 }], { toolId: 'tool-1' });
        const entry = result.data.results[0];

        expect(result.success).toBe(true);
        expect(result.cancelled).toBe(false);
        expect(entry).toMatchObject({
            path: 'sample.ts',
            success: true,
            start_line: 2,
            end_line: 3,
            deletedLines: 2,
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

        const result = await runDeleteCode([{ path: 'sample.ts', start_line: 2, end_line: 3 }], { toolId: 'tool-1' });
        const entry = result.data.results[0];

        expect(result.success).toBe(false);
        expect(result.cancelled).toBe(false);
        expect(result.error).toBe('1 file(s) failed to delete');

        expect(entry).toMatchObject({
            path: 'sample.ts',
            success: false,
            start_line: 2,
            end_line: 3,
            deletedLines: 2,
            status: 'rejected',
            cancelled: false
        });
        expect(entry.error).toBe('Diff was rejected by user');
        expect(entry.autoSaveError).toBeUndefined();
        assertCommonPassthrough(entry);
    });

    test.each([
        ['abort', 'Delete was cancelled by user'],
        ['user', 'Delete was interrupted by user']
    ])('取消/中断（reason=%s）：cancelled=true、status=rejected、error=%s', async (reason, expectedError) => {
        mockDiffManager.waitForDiffResolution.mockResolvedValue(reason);
        mockDiffManager.getDiff.mockReturnValue(undefined);

        const result = await runDeleteCode([{ path: 'sample.ts', start_line: 2, end_line: 3 }], { toolId: 'tool-1' });
        const entry = result.data.results[0];

        expect(result.success).toBe(false);
        expect(result.cancelled).toBe(true);
        expect(result.error).toBe('Delete was cancelled by user');

        expect(entry).toMatchObject({
            path: 'sample.ts',
            success: false,
            start_line: 2,
            end_line: 3,
            deletedLines: 2,
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

        const result = await runDeleteCode([{ path: 'sample.ts', start_line: 2, end_line: 3 }], { toolId: 'tool-1' });
        const entry = result.data.results[0];

        expect(result.success).toBe(false);
        expect(result.cancelled).toBe(false);
        expect(result.error).toBe('1 file(s) failed to delete');

        expect(entry).toMatchObject({
            path: 'sample.ts',
            success: false,
            start_line: 2,
            end_line: 3,
            deletedLines: 2,
            status: 'rejected'
        });
        expect(entry.error).toBe(autoSaveError);
        expect(entry.autoSaveError).toBe(autoSaveError);
        expect(entry.cancelled).toBeUndefined();
        assertCommonPassthrough(entry);
    });

    test('边界：files 为空数组返回非空数组错误', async () => {
        const result = await runDeleteCode([]);
        expect(result).toEqual({ success: false, error: 'files is required and must be a non-empty array' });
        expect(mockDiffManager.createPendingDiff).not.toHaveBeenCalled();
    });

    test('边界：start_line > end_line 返回校验错误（不进入 diff 审阅）', async () => {
        const result = await runDeleteCode([{ path: 'sample.ts', start_line: 3, end_line: 2 }]);
        expect(result.success).toBe(false);
        expect(result.error).toBe('1 file(s) failed to delete');
        expect(result.data.results[0]).toMatchObject({
            path: 'sample.ts',
            success: false,
            error: 'start_line (3) must be <= end_line (2)'
        });
        expect(mockDiffManager.createPendingDiff).not.toHaveBeenCalled();
    });

    test('异常路径：start_line 越界返回可读错误', async () => {
        const result = await runDeleteCode([{ path: 'sample.ts', start_line: 99, end_line: 99 }]);
        expect(result.success).toBe(false);
        expect(result.data.results[0]).toMatchObject({
            path: 'sample.ts',
            success: false,
            error: 'start_line 99 is out of range. File has 5 lines.'
        });
        expect(mockDiffManager.createPendingDiff).not.toHaveBeenCalled();
    });
});
