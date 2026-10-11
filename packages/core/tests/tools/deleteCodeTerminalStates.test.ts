/** 平台删除代码的 Diff 终态、参数边界与换行行为。 */
import { createMutationToolFixture } from '../support/mutationToolFixture';

const fixture = createMutationToolFixture('delete_code');
const propose = fixture.propose;

describe('delete_code 终态语义（diff 审阅）', () => {
    beforeEach(async () => {
        await fixture.reset('line1\nline2\nline3\nline4\n');
    });
    afterEach(async () => { await fixture.restore(); });

    async function runDeleteCode(files: any[], context?: Record<string, unknown>) {
        return fixture.run({ files });
    }

    function assertCommonPassthrough(entry: any) {
        expect(entry.diffContentId).toBe('pending-diff-1');
        expect(entry.pendingDiffId).toBe('pending-diff-1');
        expect(entry.path).toBe('sample.ts');
        expect(entry.start_line).toBe(2);
        expect(entry.end_line).toBe(3);
        expect(entry.deletedLines).toBe(2);
    }

    test('接受：status=accepted、success=true、无 error', async () => {
        propose.mockResolvedValue({ id: 'pending-diff-1', status: 'accepted' });

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
        expect(entry.cancelled).toBe(false);
        assertCommonPassthrough(entry);
        expect(propose).toHaveBeenCalledTimes(1);
    });

    test('拒绝：status=rejected、success=false、cancelled=false', async () => {
        propose.mockResolvedValue({ id: 'pending-diff-1', status: 'rejected' });

        const result = await runDeleteCode([{ path: 'sample.ts', start_line: 2, end_line: 3 }], { toolId: 'tool-1' });
        const entry = result.data.results[0];

        expect(result.success).toBe(false);
        expect(result.cancelled).toBe(false);
        expect(result.error).toBe('1 个文件未完成修改。');

        expect(entry).toMatchObject({
            path: 'sample.ts',
            success: false,
            start_line: 2,
            end_line: 3,
            deletedLines: 2,
            status: 'rejected',
            cancelled: false
        });
        expect(entry.error).toBeUndefined();
        expect(entry.autoSaveError).toBeUndefined();
        assertCommonPassthrough(entry);
    });

    test.each([
        ['abort', 'Delete was cancelled by user'],
        ['user', 'Delete was interrupted by user']
    ])('取消/中断（reason=%s）：cancelled=true、status=cancelled、error=%s', async (reason, expectedError) => {
        propose.mockResolvedValue({ id: 'pending-diff-1', status: 'cancelled', error: expectedError });

        const result = await runDeleteCode([{ path: 'sample.ts', start_line: 2, end_line: 3 }], { toolId: 'tool-1' });
        const entry = result.data.results[0];

        expect(result.success).toBe(false);
        expect(result.cancelled).toBe(true);
        expect(result.error).toBe('1 个文件未完成修改。');

        expect(entry).toMatchObject({
            path: 'sample.ts',
            success: false,
            start_line: 2,
            end_line: 3,
            deletedLines: 2,
            status: 'cancelled',
            cancelled: true
        });
        expect(entry.error).toBe(expectedError);
        expect(entry.autoSaveError).toBeUndefined();
        assertCommonPassthrough(entry);
    });

    test('autoSave 失败：success=false、status=rejected、error 透传', async () => {
        const autoSaveError = 'Auto-save failed while accepting diff. The diff was rejected to unblock tool execution.';
        propose.mockResolvedValue({ id: 'pending-diff-1', status: 'rejected', error: autoSaveError });

        const result = await runDeleteCode([{ path: 'sample.ts', start_line: 2, end_line: 3 }], { toolId: 'tool-1' });
        const entry = result.data.results[0];

        expect(result.success).toBe(false);
        expect(result.cancelled).toBe(false);
        expect(result.error).toBe('1 个文件未完成修改。');

        expect(entry).toMatchObject({
            path: 'sample.ts',
            success: false,
            start_line: 2,
            end_line: 3,
            deletedLines: 2,
            status: 'rejected'
        });
        expect(entry.error).toBe(autoSaveError);
        expect(entry.autoSaveError).toBeUndefined();
        expect(entry.cancelled).toBe(false);
        assertCommonPassthrough(entry);
    });

    test('边界：files 为空数组返回非空数组错误', async () => {
        const result = await runDeleteCode([]);
        expect(result).toEqual({ success: false, error: '至少提供一个文件条目。' });
        expect(propose).not.toHaveBeenCalled();
    });

    test('边界：start_line > end_line 返回校验错误（不进入 diff 审阅）', async () => {
        const result = await runDeleteCode([{ path: 'sample.ts', start_line: 3, end_line: 2 }]);
        expect(result.success).toBe(false);
        expect(result.error).toBe('1 个文件未完成修改。');
        expect(result.data.results[0]).toMatchObject({
            path: 'sample.ts',
            success: false,
            error: expect.stringContaining('删除行范围无效')
        });
        expect(propose).not.toHaveBeenCalled();
    });

    test.each(['line1\nline2\n', 'line1\r\nline2\r\n', 'line1\rline2\r', 'line1\nline2'])('删除真实末行并保留前行分隔符：%j', async text => {
        await fixture.setContent(text);
        propose.mockResolvedValue({ id: 'pending-diff-1', status: 'accepted' });
        const result = await runDeleteCode([{ path: 'sample.ts', start_line: 2, end_line: 2 }]);
        expect(result.success).toBe(true);
        expect(propose.mock.calls[0][3]).toBe(text.endsWith('\n') || text.endsWith('\r') ? 'line1\n' : 'line1');
    });

    test('不允许删除最终换行产生的幻影行', async () => {
        const result = await runDeleteCode([{ path: 'sample.ts', start_line: 5, end_line: 5 }]);
        expect(result.success).toBe(false);
        expect(propose).not.toHaveBeenCalled();
    });

    test('异常路径：start_line 越界返回可读错误', async () => {
        const result = await runDeleteCode([{ path: 'sample.ts', start_line: 99, end_line: 99 }]);
        expect(result.success).toBe(false);
        expect(result.data.results[0]).toMatchObject({
            path: 'sample.ts',
            success: false,
            error: expect.stringContaining('删除行范围无效')
        });
        expect(propose).not.toHaveBeenCalled();
    });
});
