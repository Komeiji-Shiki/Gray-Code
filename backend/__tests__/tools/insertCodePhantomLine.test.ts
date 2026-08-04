/**
 * insert_code 幻影尾行回归测试。
 *
 * 修复背景：文件以 \n 结尾时 split('\n') 多出幻影空串行，模型按 last_line+1 在末尾追加
 *          会把内容插到幻影行之后，产生多余空行（"a\nb\n" + 行4 → "a\nb\n\nX"）。
 */

import { insertAtLine } from '../../tools/file/insert_code';

describe('insertAtLine 幻影尾行处理', () => {
    it('文件以换行结尾时，按 totalLines+1 追加不再产生多余空行', () => {
        // "a\nb\n" 的行数组带幻影尾行：["a", "b", ""]，totalLines = 3
        const lines = ['a', 'b', ''];
        const result = insertAtLine(lines, 4, 'X');
        expect(result).toBe('a\nb\nX\n');
    });

    it('文件以换行结尾时，在最后真实行后插入（line = totalLines）结果一致', () => {
        const lines = ['a', 'b', ''];
        const result = insertAtLine(lines, 3, 'X');
        expect(result).toBe('a\nb\nX\n');
    });

    it('文件无尾随换行时，末尾追加保持原语义', () => {
        const lines = ['a', 'b'];
        const result = insertAtLine(lines, 3, 'X');
        expect(result).toBe('a\nb\nX');
    });

    it('文件中段插入不受幻影行影响', () => {
        const lines = ['a', 'b', ''];
        const result = insertAtLine(lines, 2, 'X');
        expect(result).toBe('a\nX\nb\n');
    });

    it('空文件插入首行不再产生前置空行', () => {
        const lines = [''];
        const result = insertAtLine(lines, 1, 'X');
        expect(result).toBe('X\n');
    });

    it('content 自带尾随换行时不重复产生空行', () => {
        const lines = ['a', 'b', ''];
        const result = insertAtLine(lines, 4, 'X\n');
        expect(result).toBe('a\nb\nX\n');
    });
});
