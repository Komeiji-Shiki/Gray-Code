import * as iconv from 'iconv-lite';
import { decodeTextBytes, detectTextEncoding, encodeTextBytes, findUnencodableCharacter, normalizeTextEncodingName, roundTripsExactly } from '../../tools/search/textEncodingRuntime';

describe('文本编码检测', () => {
    test.each([
        ['gbk', '@echo off\r\nrem 启动游戏并等待退出\r\nset 游戏目录=%~dp0\r\n'],
        ['gb18030', '表情 😀 与生僻字 𠀀\n'],
        ['shift_jis', 'echo 日本語のテキストです。ゲームを起動します\r\n'],
        ['big5', 'echo 這是繁體中文的設定檔，請勿修改\r\n'],
        ['windows-1252', 'café résumé naïve — “quoted”\n'],
    ])('无 BOM 的 %s 文本按内容识别并逐字节还原', (encoding, text) => {
        const bytes = iconv.encode(text, encoding);
        const detection = detectTextEncoding(bytes);
        expect(detection).toMatchObject({ isText: true, encoding, source: 'guess' });
        expect(decodeTextBytes(bytes, detection)).toBe(text);
        expect(roundTripsExactly(bytes, detection)).toBe(true);
    });

    test('UTF-8、BOM、UTF-16 与二进制保持原有判定', () => {
        expect(detectTextEncoding(Buffer.from('普通 UTF-8 文本'))).toMatchObject({ encoding: 'utf-8', bomLength: 0, source: 'utf8' });
        expect(detectTextEncoding(Buffer.from('\ufeffabc'))).toMatchObject({ encoding: 'utf-8', bomLength: 3, source: 'bom' });
        const wide = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from('中文', 'utf16le').swap16()]);
        expect(decodeTextBytes(wide, detectTextEncoding(wide))).toBe('中文');
        expect(detectTextEncoding(Buffer.from('\0hit')).isText).toBe(false);
        expect(detectTextEncoding(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 1, 0, 0, 0, 1, 0])).isText).toBe(false);
    });

    test('显式编码跳过推测，别名统一，不支持的名称报错', () => {
        const korean = iconv.encode('안녕하세요', 'euc-kr');
        expect(detectTextEncoding(korean, 'EUC_KR')).toMatchObject({ encoding: 'euc-kr', source: 'explicit' });
        expect(decodeTextBytes(korean, detectTextEncoding(korean, 'euc-kr'))).toBe('안녕하세요');
        expect(normalizeTextEncodingName('CP936')).toBe('gbk');
        expect(normalizeTextEncodingName('SJIS')).toBe('shift_jis');
        expect(() => normalizeTextEncodingName('klingon')).toThrow('不支持的编码');
    });

    test('写回前报告无法用原编码表示的字符，编码函数拒绝静默替换', () => {
        expect(findUnencodableCharacter('第一行\n含有 😀 表情', 'gbk')).toEqual({ character: '😀', line: 2 });
        expect(findUnencodableCharacter('全部可编码', 'gbk')).toBeUndefined();
        expect(findUnencodableCharacter('😀', 'utf-8')).toBeUndefined();
        expect(() => encodeTextBytes('✅', { isText: true, encoding: 'shift_jis', bomLength: 0 })).toThrow('ENCODING_UNREPRESENTABLE');
        expect(Buffer.from(encodeTextBytes('中文', { isText: true, encoding: 'gbk', bomLength: 0 }))).toEqual(iconv.encode('中文', 'gbk'));
    });
});
