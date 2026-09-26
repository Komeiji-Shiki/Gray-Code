import { splitTextLines } from '../../../shared/textLines';

/** 两个宿主共用原行插入与删除算法；lines 保留 split 的尾分隔符，避免编辑丢失最终换行。 */
export function insertAtLine(lines: string[], line: number, content: string): string {
    const insertLines = splitContentLines(content);
    const idx = line - 1; // 转为 0-based
    const newLines = [
        ...lines.slice(0, idx),
        ...insertLines,
        ...lines.slice(idx)
    ];
    return newLines.join('\n');
}

export function splitContentLines(content: string): string[] {
    return content === '' ? [] : splitTextLines(content);
}

export function deleteLineRange(lines: string[], startLine: number, endLine: number): string {
    const newLines = [
        ...lines.slice(0, startLine - 1),
        ...lines.slice(endLine)
    ];
    return newLines.join('\n');
}
