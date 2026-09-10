/** 两个宿主共用原行插入与删除算法。 */
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
    if (content === '') {
        return [];
    }
    const lines = content.split('\n');
    if (content.length > 0 && lines[lines.length - 1] === '') {
        lines.pop();
    }
    return lines;
}

export function deleteLineRange(lines: string[], startLine: number, endLine: number): string {
    const newLines = [
        ...lines.slice(0, startLine - 1),
        ...lines.slice(endLine)
    ];
    return newLines.join('\n');
}
