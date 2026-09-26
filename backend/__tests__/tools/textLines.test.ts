import { countSplitTextLines, normalizeLineEndingsToLF, splitTextLines, TextLineCounter } from '../../../shared/textLines';

const cases: Array<[string, string[]]> = [
    ['', ['']],
    ['one', ['one']],
    ['one\n', ['one']],
    ['one\n\n', ['one', '']],
    ['\n', ['']],
    ['\n\n', ['', '']],
    ['one\ntwo', ['one', 'two']],
    ['one\r\ntwo\r\n', ['one', 'two']],
    ['one\rtwo\r', ['one', 'two']],
    ['one\rtwo', ['one', 'two']],
    ['\r\n', ['']],
    ['\r\r\n', ['', '']],
    ['首😀\r\n中\r末\n\n', ['首😀', '中', '末', '']],
];

describe('工具共享文本行语义', () => {
    test.each(cases)('文本 %j 不把最终换行作为额外行', (text, expected) => {
        expect(splitTextLines(text)).toEqual(expected);
        expect(countSplitTextLines(normalizeLineEndingsToLF(text).split('\n'))).toBe(expected.length);
        const preserved = splitTextLines(text, true);
        expect(preserved).toHaveLength(expected.length);
        expect(preserved.join('')).toBe(text);
        expect(preserved.map(line => line.replace(/(?:\r\n|\r|\n)$/, ''))).toEqual(expected);
    });

    test.each(cases)('字节流 %j 在任意分块边界都与读取一致', (text, expected) => {
        const bytes = Buffer.from(text);
        for (let boundary = 0; boundary <= bytes.length; boundary++) {
            const counter = new TextLineCounter();
            counter.push(bytes.subarray(0, boundary));
            counter.push(new Uint8Array());
            counter.push(bytes.subarray(boundary));
            expect(counter.lineCount).toBe(expected.length);
        }
        const bytewise = new TextLineCounter();
        for (const byte of bytes) bytewise.push(Uint8Array.of(byte));
        expect(bytewise.lineCount).toBe(expected.length);
    });

    test('只统计缓冲区有效字节，不读取上一次块留下的尾部内容', () => {
        const counter = new TextLineCounter();
        counter.push(Buffer.from('a\rignored\n'), 2);
        counter.push(Buffer.from('\n尾\n'));
        expect(counter.lineCount).toBe(2);
        counter.push(Buffer.from('\n'), 0);
        expect(counter.lineCount).toBe(2);
    });
});
