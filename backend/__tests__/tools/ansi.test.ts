import { AnsiStreamStripper, stripAnsi } from '../../../shared/ansi';

describe('终端控制序列去除', () => {
    test('去掉颜色、OSC 标题和字符集切换，保留正文与换行', () => {
        expect(stripAnsi('\u001b[32;1m   Id\u001b[0m Name\r\n')).toBe('   Id Name\r\n');
        expect(stripAnsi('\u001b]0;title\u0007body')).toBe('body');
        expect(stripAnsi('\u001b(Bplain\u001b[?25l')).toBe('plain');
        expect(stripAnsi('无控制序列')).toBe('无控制序列');
    });

    test('流式分块在序列中间断开时暂存尾部，不留下残片', () => {
        const stripper = new AnsiStreamStripper();
        expect(stripper.push('ok \u001b[3')).toBe('ok ');
        expect(stripper.push('1;1mred\u001b')).toBe('red');
        expect(stripper.push('[0m done')).toBe(' done');
        expect(stripper.flush()).toBe('');
    });

    test('结束时冲刷未完成的尾部，不吞掉普通文本', () => {
        const stripper = new AnsiStreamStripper();
        expect(stripper.push('tail')).toBe('tail');
        expect(stripper.push('\u001b[')).toBe('');
        expect(stripper.flush()).toBe('');
    });
});
