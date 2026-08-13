/**
 * 行级原语（从 DiffManager 抽离的纯函数层）。
 *
 * 只包含与 VSCode 无关的字符串/整数运算：行切分与行内容整数 ID 化。
 * 供 diff 算法（diffAlgorithm.ts）与摘要统计（summaryStats.ts）复用，
 * 不 import vscode，不读写文件，不做任何副作用编排。
 */

/**
 * 把文本按行切分。
 *
 * 统一处理 CRLF/CR 换行与尾部换行，避免行号统计偏差。
 */
export function splitLines(text: string): string[] {
    const normalized = text.replace(/\r\n?/g, '\n');
    const lines = normalized.split('\n');
    // 如果文本以换行结尾，split 会产生最后一个空行，这里去掉，避免行号计算偏差
    if (lines.length > 0 && lines[lines.length - 1] === '') {
        lines.pop();
    }
    return lines;
}

/**
 * 行内容映射为整数 id，把差分内层循环的逐字符字符串比较降为整数比较。
 */
export function toLineIds(a: string[], b: string[]): { aIds: Int32Array; bIds: Int32Array } {
    const idMap = new Map<string, number>();
    const assign = (line: string): number => {
        let id = idMap.get(line);
        if (id === undefined) {
            id = idMap.size;
            idMap.set(line, id);
        }
        return id;
    };

    const aIds = new Int32Array(a.length);
    for (let i = 0; i < a.length; i++) {
        aIds[i] = assign(a[i]);
    }
    const bIds = new Int32Array(b.length);
    for (let i = 0; i < b.length; i++) {
        bIds[i] = assign(b[i]);
    }
    return { aIds, bIds };
}
