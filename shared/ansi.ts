/**
 * 终端颜色与光标控制序列只服务于界面渲染；发给模型或写入任务记录的文本去掉它们，
 * 避免 PowerShell 7 的 Format-Table、错误记录等输出把 `\x1b[32;1m` 之类的噪声带进上下文。
 * 覆盖 CSI（ESC [ … 终止字节）、OSC（ESC ] … BEL/ST）、字符集切换（ESC ( B 等）和单字节 ESC 序列。
 */
// eslint-disable-next-line no-control-regex
const ansiPattern = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[()*+][0-~]|\u001b[@-Z\\-_]|\u009b[0-?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex
const incompleteTail = /(?:\u001b(?:\[[0-?]*[ -/]*|\][^\u0007\u001b]*|[()*+])?|\u009b[0-?]*[ -/]*)$/;

export function stripAnsi(text: string): string {
    return text.includes('\u001b') || text.includes('\u009b') ? text.replace(ansiPattern, '') : text;
}

/** 流式输出可能在控制序列中间分块：未完成的序列尾部暂存到下一块再去除，最长暂存 256 个字符。 */
export class AnsiStreamStripper {
    private pending = '';
    push(chunk: string): string {
        const text = this.pending + chunk;
        const tail = text.match(incompleteTail);
        const cut = tail && tail[0].length <= 256 ? text.length - tail[0].length : text.length;
        this.pending = text.slice(cut);
        return stripAnsi(text.slice(0, cut));
    }
    flush(): string {
        // 输出结束仍未闭合的序列没有可显示内容，整段丢弃。
        const rest = stripAnsi(this.pending).replace(incompleteTail, '');
        this.pending = '';
        return rest;
    }
}
