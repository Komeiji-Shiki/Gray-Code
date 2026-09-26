/** 工具行号约定：LF、CRLF、孤立 CR 都分行；末尾换行不增加一行，空文本仍可读取第 1 行。 */
export function normalizeLineEndingsToLF(text: string): string {
    // 常见 LF 文本不需要替换扫描；CRLF 与孤立 CR 在一次扫描中处理。
    return text.includes('\r') ? text.replace(/\r\n?/g, '\n') : text;
}

/** 输入为规范化文本 split('\n') 的结果；编辑时保留尾分隔符，但范围校验不把它算作一行。 */
export function countSplitTextLines(lines: readonly string[]): number {
    return Math.max(1, lines.length - (lines[lines.length - 1] === '' ? 1 : 0));
}

/** preserveLineEndings 用于精确文本编辑接口，避免读取 CRLF 后再用 oldText 编辑时失配。 */
export function splitTextLines(text: string, preserveLineEndings = false): string[] {
    const lines = preserveLineEndings
        ? text.match(/[^\r\n]*(?:\r\n?|\n|$)/g)!
        : normalizeLineEndingsToLF(text).split('\n');
    lines.length = countSplitTextLines(lines);
    return lines;
}

/**
 * 与 splitTextLines 相同的 UTF-8 字节流计数，不解码、不保留完整内容。
 * CR/LF 不会出现在 UTF-8 多字节字符内部；仅需保留前一个字节以合并跨块 CRLF。
 */
export class TextLineCounter {
    private lineBreaks = 0;
    private previousByte = -1;

    push(bytes: Uint8Array, length = bytes.length): void {
        for (let index = 0; index < length; index++) {
            const byte = bytes[index];
            if (byte === 13 || byte === 10 && this.previousByte !== 13) this.lineBreaks++;
            this.previousByte = byte;
        }
    }

    get lineCount(): number {
        const hasUnterminatedLine = this.previousByte !== -1 && this.previousByte !== 10 && this.previousByte !== 13;
        return Math.max(1, this.lineBreaks + Number(hasUnterminatedLine));
    }
}
