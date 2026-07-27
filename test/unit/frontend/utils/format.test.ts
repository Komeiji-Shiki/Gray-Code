/**
 * decodeUnicodeEscapes 单元测试
 *
 * 背景：部分模型在 function calling 中以 ASCII-safe 形式输出 JSON
 * （等价 ensure_ascii=True），中文变成 \uXXXX 转义。该函数用于
 * 工具参数流式预览的实时解码，只影响展示层。
 */
import { decodeUnicodeEscapes } from '../../../../frontend/src/utils/format'

describe('decodeUnicodeEscapes', () => {
    it('无转义序列时原样返回（引用不变，零开销短路）', () => {
        const text = '{"path": "src/main.ts", "content": "hello 中文"}'
        expect(decodeUnicodeEscapes(text)).toBe(text)
    })

    it('解码基本中文转义序列', () => {
        expect(decodeUnicodeEscapes('\\u4e2d\\u6587')).toBe('中文')
    })

    it('解码混合在 JSON 文本中的转义序列', () => {
        const input = '{"oldContent": "\\u5468\\u56f4\\u5168\\u5728", "path": "a.ts"}'
        expect(decodeUnicodeEscapes(input)).toBe('{"oldContent": "周围全在", "path": "a.ts"}')
    })

    it('支持大写十六进制', () => {
        expect(decodeUnicodeEscapes('\\u4E2D')).toBe('中')
    })

    it('流式截断的尾部保持原样，完整部分正常解码', () => {
        expect(decodeUnicodeEscapes('\\u4e2d\\u65')).toBe('中\\u65')
        expect(decodeUnicodeEscapes('\\u')).toBe('\\u')
    })

    it('成对反斜杠后的 uXXXX 是字面量，不被解码', () => {
        // JSON 里的 "\\u0041" 表示字面文本 \u0041，不是转义
        expect(decodeUnicodeEscapes('\\\\u0041')).toBe('\\\\u0041')
    })

    it('奇数个反斜杠：前两个保留，剩余的 \\uXXXX 正常解码', () => {
        // \\\u0041 = 字面反斜杠 + 字符 A
        expect(decodeUnicodeEscapes('\\\\\\u0041')).toBe('\\\\A')
    })

    it('代理对解码为完整 emoji', () => {
        expect(decodeUnicodeEscapes('\\ud83d\\ude00')).toBe('😀')
    })

    it('非十六进制的 \\u 序列保持原样', () => {
        expect(decodeUnicodeEscapes('\\uzzzz')).toBe('\\uzzzz')
    })
})
