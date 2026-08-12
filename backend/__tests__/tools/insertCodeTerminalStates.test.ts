/**
 * insert_code handler 的 diff 审阅终态组装测试（任务 02#20-A）。
 *
 * 与 write_file 共用 resolveDiffOutcome，四条终态路径的字段语义应与
 * write_file/delete_code 保持一致，仅 actionLabel（'Insert'）与
 * per-file 字段（line/insertedLines）不同。
 */

import * as fs from 'fs';
import * as vscode from 'vscode';
import { registerInsertCode } from '../../tools/file/insert_code';

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

describe('insert_code 终态语义（diff 审阅）', () => {
    beforeEach(() => {
        jest.clearAllMocks();

        (vscode.workspace as any).workspaceFolders = [{
            name: 'project',
            uri: vscode.Uri.file('/workspace/project')
        }];

        // 模拟已存在文件：4 行内容，第 2 行前插入一行
        (fs.promises as any).stat.mockResolvedValue({ size: 64 });
        (fs.promises as any).readFile.mockResolvedValue('line1\nline2\nline3\n');

        mockDiffManager.createPendingDiff.mockResolvedValue({ id: 'pending-diff-1', status: 'pending' });
        mockDiffManager.prewarmDocument.mockReturnValue(undefined);
        mockDiffStorageManager.saveGlobalDiff.mockResolvedValue({ diffId: 'content-id-1' });
    });

    async function runInsertCode(files: any[], context?: Record<string, unknown>) {
        const tool = registerInsertCode();
        return tool.handler({ files }, context as any);
    }

    function assertCommonPassthrough(entry: any) {
        expect(entry.diffContentId).toBe('content-id-1');
        expect(entry.pendingDiffId).toBe('pending-diff-1');
        expect(entry.path).toBe('sample.ts');
        expect(entry.line).toBe(2);
        expect(entry.insertedLines).toBe(1);
    }

    test('接受：status=accepted、success=true、无 error', async () => {
        mockDiffManager.waitForDiffResolution.mockResolvedValue('none');
        mockDiffManager.getDiff.mockReturnValue({ id: 'pending-diff-1', status: 'accepted' });

        const result = await runInsertCode([{ path: 'sample.ts', line: 2, content: 'X' }], { toolId: 'tool-1' });
        const entry = result.data.results[0];

        expect(result.success).toBe(true);
        expect(result.cancelled).toBe(false);
        expect(entry).toMatchObject({
            path: 'sample.ts',
            success: true,
            line: 2,
            insertedLines: 1,
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

        const result = await runInsertCode([{ path: 'sample.ts', line: 2, content: 'X' }], { toolId: 'tool-1' });
        const entry = result.data.results[0];

        expect(result.success).toBe(false);
        expect(result.cancelled).toBe(false);
        expect(result.error).toBe('1 file(s) failed to insert');

        expect(entry).toMatchObject({
            path: 'sample.ts',
            success: false,
            line: 2,
            insertedLines: 1,
            status: 'rejected',
            cancelled: false
        });
        expect(entry.error).toBe('Diff was rejected by user');
        expect(entry.autoSaveError).toBeUndefined();
        assertCommonPassthrough(entry);
    });

    test.each([
        ['abort', 'Insert was cancelled by user'],
        ['user', 'Insert was interrupted by user']
    ])('取消/中断（reason=%s）：cancelled=true、status=rejected、error=%s', async (reason, expectedError) => {
        mockDiffManager.waitForDiffResolution.mockResolvedValue(reason);
        mockDiffManager.getDiff.mockReturnValue(undefined);

        const result = await runInsertCode([{ path: 'sample.ts', line: 2, content: 'X' }], { toolId: 'tool-1' });
        const entry = result.data.results[0];

        expect(result.success).toBe(false);
        expect(result.cancelled).toBe(true);
        expect(result.error).toBe('Insert was cancelled by user');

        expect(entry).toMatchObject({
            path: 'sample.ts',
            success: false,
            line: 2,
            insertedLines: 1,
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

        const result = await runInsertCode([{ path: 'sample.ts', line: 2, content: 'X' }], { toolId: 'tool-1' });
        const entry = result.data.results[0];

        expect(result.success).toBe(false);
        expect(result.cancelled).toBe(false);
        expect(result.error).toBe('1 file(s) failed to insert');

        expect(entry).toMatchObject({
            path: 'sample.ts',
            success: false,
            line: 2,
            insertedLines: 1,
            status: 'rejected'
        });
        expect(entry.error).toBe(autoSaveError);
        expect(entry.autoSaveError).toBe(autoSaveError);
        expect(entry.cancelled).toBeUndefined();
        assertCommonPassthrough(entry);
    });

    test('边界：files 为空数组返回非空数组错误', async () => {
        const result = await runInsertCode([]);
        expect(result).toEqual({ success: false, error: 'files is required and must be a non-empty array' });
        expect(mockDiffManager.createPendingDiff).not.toHaveBeenCalled();
    });

    test('边界：line 非正整数返回校验错误（不进入 diff 审阅）', async () => {
        const result = await runInsertCode([{ path: 'sample.ts', line: 0, content: 'X' }]);
        expect(result.success).toBe(false);
        expect(result.error).toBe('1 file(s) failed to insert');
        expect(result.data.results[0]).toMatchObject({
            path: 'sample.ts',
            success: false,
            error: 'line must be a positive integer (1-based)'
        });
        expect(mockDiffManager.createPendingDiff).not.toHaveBeenCalled();
    });

    test('异常路径：插入行号越界返回可读错误', async () => {
        const result = await runInsertCode([{ path: 'sample.ts', line: 99, content: 'X' }]);
        expect(result.success).toBe(false);
        expect(result.data.results[0]).toMatchObject({
            path: 'sample.ts',
            success: false,
            error: 'Line 99 is out of range. File has 4 lines. Use 1~5.'
        });
        expect(mockDiffManager.createPendingDiff).not.toHaveBeenCalled();
    });
});
