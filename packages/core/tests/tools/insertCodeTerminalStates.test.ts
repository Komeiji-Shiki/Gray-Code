/** 平台插入代码的 Diff 终态、参数边界与换行行为。 */
import { createMutationToolFixture } from '../support/mutationToolFixture';

const fixture = createMutationToolFixture('insert_code');
const propose = fixture.propose;

describe('insert_code 终态语义（diff 审阅）', () => {
    beforeEach(async () => {
        await fixture.reset('line1\nline2\nline3\n');
    });
    afterEach(async () => { await fixture.restore(); });

    async function runInsertCode(files: any[], context?: Record<string, unknown>) {
        return fixture.run({ files });
    }

    function assertCommonPassthrough(entry: any) {
        expect(entry.diffContentId).toBe('pending-diff-1');
        expect(entry.pendingDiffId).toBe('pending-diff-1');
        expect(entry.path).toBe('sample.ts');
        expect(entry.line).toBe(2);
        expect(entry.insertedLines).toBe(1);
    }

    test('接受：status=accepted、success=true、无 error', async () => {
        propose.mockResolvedValue({ id: 'pending-diff-1', status: 'accepted' });

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
        expect(entry.cancelled).toBe(false);
        assertCommonPassthrough(entry);
        expect(propose).toHaveBeenCalledTimes(1);
    });

    test('拒绝：status=rejected、success=false、cancelled=false', async () => {
        propose.mockResolvedValue({ id: 'pending-diff-1', status: 'rejected' });

        const result = await runInsertCode([{ path: 'sample.ts', line: 2, content: 'X' }], { toolId: 'tool-1' });
        const entry = result.data.results[0];

        expect(result.success).toBe(false);
        expect(result.cancelled).toBe(false);
        expect(result.error).toBe('1 个文件未完成修改。');

        expect(entry).toMatchObject({
            path: 'sample.ts',
            success: false,
            line: 2,
            insertedLines: 1,
            status: 'rejected',
            cancelled: false
        });
        expect(entry.error).toBeUndefined();
        expect(entry.autoSaveError).toBeUndefined();
        assertCommonPassthrough(entry);
    });

    test.each([
        ['abort', 'Insert was cancelled by user'],
        ['user', 'Insert was interrupted by user']
    ])('取消/中断（reason=%s）：cancelled=true、status=cancelled、error=%s', async (reason, expectedError) => {
        propose.mockResolvedValue({ id: 'pending-diff-1', status: 'cancelled', error: expectedError });

        const result = await runInsertCode([{ path: 'sample.ts', line: 2, content: 'X' }], { toolId: 'tool-1' });
        const entry = result.data.results[0];

        expect(result.success).toBe(false);
        expect(result.cancelled).toBe(true);
        expect(result.error).toBe('1 个文件未完成修改。');

        expect(entry).toMatchObject({
            path: 'sample.ts',
            success: false,
            line: 2,
            insertedLines: 1,
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

        const result = await runInsertCode([{ path: 'sample.ts', line: 2, content: 'X' }], { toolId: 'tool-1' });
        const entry = result.data.results[0];

        expect(result.success).toBe(false);
        expect(result.cancelled).toBe(false);
        expect(result.error).toBe('1 个文件未完成修改。');

        expect(entry).toMatchObject({
            path: 'sample.ts',
            success: false,
            line: 2,
            insertedLines: 1,
            status: 'rejected'
        });
        expect(entry.error).toBe(autoSaveError);
        expect(entry.autoSaveError).toBeUndefined();
        expect(entry.cancelled).toBe(false);
        assertCommonPassthrough(entry);
    });

    test('边界：files 为空数组返回非空数组错误', async () => {
        const result = await runInsertCode([]);
        expect(result).toEqual({ success: false, error: '至少提供一个文件条目。' });
        expect(propose).not.toHaveBeenCalled();
    });

    test('边界：line 非正整数返回校验错误（不进入 diff 审阅）', async () => {
        const result = await runInsertCode([{ path: 'sample.ts', line: 0, content: 'X' }]);
        expect(result.success).toBe(false);
        expect(result.error).toContain('1 个条目未完成');
        expect(result.data.results[0]).toMatchObject({
            path: 'sample.ts',
            success: false,
            error: expect.stringContaining('files[0]/line')
        });
        expect(propose).not.toHaveBeenCalled();
    });

    test.each([
        ['line1\nline2\n', 3, 'line1\nline2\nX\n'],
        ['line1\r\nline2\r\n', 3, 'line1\nline2\nX\n'],
        ['line1\rline2\r', 3, 'line1\nline2\nX\n'],
        ['line1\nline2', 3, 'line1\nline2\nX'],
    ] as Array<[string, number, string]>)('用真实末行 + 1 追加且不引入空行：%j', async (text, line, expected) => {
        await fixture.setContent(text);
        propose.mockResolvedValue({ id: 'pending-diff-1', status: 'accepted' });
        const result = await runInsertCode([{ path: 'sample.ts', line, content: 'X\r\n' }]);
        expect(result.success).toBe(true);
        expect(result.data.results[0].insertedLines).toBe(1);
        expect(propose.mock.calls[0][3]).toBe(expected);
    });

    test('不允许在最终换行之后再跳过一个幻影行插入', async () => {
        const result = await runInsertCode([{ path: 'sample.ts', line: 5, content: 'X' }]);
        expect(result.success).toBe(false);
        expect(propose).not.toHaveBeenCalled();
    });

    test('异常路径：插入行号越界返回可读错误', async () => {
        const result = await runInsertCode([{ path: 'sample.ts', line: 99, content: 'X' }]);
        expect(result.success).toBe(false);
        expect(result.data.results[0]).toMatchObject({
            path: 'sample.ts',
            success: false,
            error: expect.stringContaining('插入行号或内容无效')
        });
        expect(propose).not.toHaveBeenCalled();
    });
});
