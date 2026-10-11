/** 平台完整写入的 Diff 终态、参数边界与换行行为。 */
import { createMutationToolFixture } from '../__fixtures__/mutationToolFixture';

const fixture = createMutationToolFixture('write_file');
const propose = fixture.propose;

describe('write_file 终态语义（diff 审阅）', () => {
    beforeEach(async () => {
        await fixture.reset('original content');
    });
    afterEach(async () => { await fixture.restore(); });

    async function runWriteFile(args: Record<string, unknown>, context?: Record<string, unknown>) {
        return fixture.run(args);
    }

    function assertCommonPassthrough(entry: any) {
        // 平台提案同时作为内容和待审阅标识。
        expect(entry.diffContentId).toBe('pending-diff-1');
        expect(entry.pendingDiffId).toBe('pending-diff-1');
        expect(entry.path).toBe('sample.ts');
    }

    test('接受：status=accepted、success=true、无 error、action=modified', async () => {
        propose.mockResolvedValue({ id: 'pending-diff-1', status: 'accepted' });

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
        expect(entry.cancelled).toBe(false);
        assertCommonPassthrough(entry);
        expect(propose).toHaveBeenCalledTimes(1);
    });

    test('拒绝：status=rejected、success=false、cancelled=false', async () => {
        propose.mockResolvedValue({ id: 'pending-diff-1', status: 'rejected' });

        const result = await runWriteFile({ path: 'sample.ts', content: 'new content' }, { toolId: 'tool-1' });
        const entry = result.data.results[0];

        expect(result.success).toBe(false);
        expect(result.cancelled).toBe(false);
        expect(result.error).toBe('1 个文件未完成修改。');

        expect(entry).toMatchObject({
            path: 'sample.ts',
            success: false,
            action: 'modified',
            status: 'rejected',
            cancelled: false
        });
        expect(entry.error).toBeUndefined();
        expect(entry.autoSaveError).toBeUndefined();
        assertCommonPassthrough(entry);
    });

    test('新文件在审阅前不预创建，拒绝后仍然不存在', async () => {
        await fixture.setContent(null);
        propose.mockImplementation(async () => {
            expect(await fixture.exists()).toBe(false);
            return { id: 'pending-diff-1', status: 'rejected' };
        });

        const result = await runWriteFile({ path: 'sample.ts', content: 'new content' }, { toolId: 'tool-1' });
        const entry = result.data.results[0];

        expect(result.success).toBe(false);
        expect(entry.status).toBe('rejected');
        expect(await fixture.exists()).toBe(false);
    });

    test.each([
        ['abort', 'Write was cancelled by user'],
        ['user', 'Write was interrupted by user']
    ])('取消/中断（reason=%s）：cancelled=true、status=cancelled、error=%s', async (reason, expectedError) => {
        propose.mockResolvedValue({ id: 'pending-diff-1', status: 'cancelled', error: expectedError });
        // 取消回执保留审阅端口附带的原因。

        const result = await runWriteFile({ path: 'sample.ts', content: 'new content' }, { toolId: 'tool-1' });
        const entry = result.data.results[0];

        expect(result.success).toBe(false);
        expect(result.cancelled).toBe(true);
        expect(result.error).toBe('1 个文件未完成修改。');

        expect(entry).toMatchObject({
            path: 'sample.ts',
            success: false,
            action: 'modified',
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

        const result = await runWriteFile({ path: 'sample.ts', content: 'new content' }, { toolId: 'tool-1' });
        const entry = result.data.results[0];

        expect(result.success).toBe(false);
        expect(result.cancelled).toBe(false);
        expect(result.error).toBe('1 个文件未完成修改。');

        expect(entry).toMatchObject({
            path: 'sample.ts',
            success: false,
            status: 'rejected'
        });
        // 保存失败使用审阅回执的 error。
        expect(entry.error).toBe(autoSaveError);
        expect(entry.autoSaveError).toBeUndefined();
        expect(entry.cancelled).toBe(false);
        assertCommonPassthrough(entry);
    });

    test('边界：缺少 path 返回参数错误且不进入审阅', async () => {
        const result = await runWriteFile({ content: 'x' });
        expect(result).toMatchObject({ success: false, data: { results: [{ error: expect.stringContaining('需要 path 和完整 content') }] } });
        expect(propose).not.toHaveBeenCalled();
    });

    test('边界：content 非字符串返回参数错误且不进入审阅', async () => {
        const result = await runWriteFile({ path: 'sample.ts', content: 123 });
        expect(result).toMatchObject({ success: false, data: { results: [{ error: expect.stringContaining('需要 path 和完整 content') }] } });
        expect(propose).not.toHaveBeenCalled();
    });

    test('工具契约说明在内存中预览，用户接受后才创建文件', () => {
        const description = fixture.tool.declaration.description;
        expect(description).toContain('只在内存中预览');
        expect(description).toContain('用户接受后才创建文件和所需的父目录');
        expect(description).not.toContain('确认前先创建一个空文件');
    });
});
