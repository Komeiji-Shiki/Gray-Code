/**
 * markdownUtils.test.ts - MarkdownRenderer 纯逻辑单元测试
 *
 * 测试 escapeHtml 转义与 renderLatexOnly 行内公式正则在
 * #69 修复后的行为（货币金额不误判、被拒后仍匹配后续公式、含内部空格正常渲染）
 */
import { escapeHtml, RENDER_LATEX_ONLY_INLINE_RE } from '../markdownUtils'

describe('escapeHtml', () => {
    test('转义 & 符号', () => {
        expect(escapeHtml('a & b')).toBe('a &amp; b')
    })

    test('转义 < 和 >', () => {
        expect(escapeHtml('<div>')).toBe('&lt;div&gt;')
    })

    test('转义双引号', () => {
        expect(escapeHtml('"hello"')).toBe('&quot;hello&quot;')
    })

    test('转义单引号', () => {
        expect(escapeHtml("it's")).toBe("it&#039;s")
    })

    test('空字符串返回空', () => {
        expect(escapeHtml('')).toBe('')
    })

    test('无特殊字符的文本原样返回', () => {
        const safe = 'Hello, world! Math: 1 + 2 = 3.'
        expect(escapeHtml(safe)).toBe(safe)
    })

    test('组合转义', () => {
        expect(escapeHtml('<a href="x" title=\'y\'>&</a>'))
            .toBe('&lt;a href=&quot;x&quot; title=&#039;y&#039;&gt;&amp;&lt;/a&gt;')
    })

    test('不双次转义已有实体（escapeHtml 总是从原始文本转义，不会额外转义已编码字符）', () => {
        // escapeHtml 是纯文本 -> HTML 实体转换，不检查已有实体
        const input = '&amp;'
        expect(escapeHtml(input)).toBe('&amp;amp;')
    })
})

describe('RENDER_LATEX_ONLY_INLINE_RE', () => {
    function extractMatches(text: string): string[] {
        RENDER_LATEX_ONLY_INLINE_RE.lastIndex = 0
        const results: string[] = []
        let m: RegExpExecArray | null
        while ((m = RENDER_LATEX_ONLY_INLINE_RE.exec(text))) {
            results.push(m[1]) // 捕获的公式内容
        }
        return results
    }

    test('匹配标准行内公式', () => {
        expect(extractMatches('$x^2 + y^2 = z^2$')).toEqual(['x^2 + y^2 = z^2'])
    })

    test('不匹配货币金额 $100', () => {
        expect(extractMatches('The price is $100.')).toEqual([])
    })

    test('不匹配 $ 后紧接空格的文本', () => {
        expect(extractMatches('$ 100 $')).toEqual([])
    })

    test('不匹配首字符为空的 $ text$', () => {
        expect(extractMatches('$ text$')).toEqual([])
    })

    test('不匹配末字符为空的 $text $', () => {
        expect(extractMatches('$text $')).toEqual([])
    })

    test('含内部空格的公式正常渲染', () => {
        expect(extractMatches('Consider $x + y = z$ here.')).toEqual(['x + y = z'])
    })

    test('$100 和后续真实公式 $x+y$ 共存时只匹配后者', () => {
        const text = 'The price is $100 and the formula is $x+y$.'
        expect(extractMatches(text)).toEqual(['x+y'])
    })

    test('被拒闭合后 $ 能在下一位置重新充当开界定符', () => {
        // 第一个 $ 开头被 $ 100$ 中的空格护栏拒绝，第二个 $ 应成功匹配 $x$"
        const text = '$ 100$ and $x$'
        expect(extractMatches(text)).toEqual(['x'])
    })

    test('LaTeX 命令（反斜杠）在公式内正常工作', () => {
        expect(extractMatches('$\\alpha + \\beta = \\gamma$')).toEqual(['\\alpha + \\beta = \\gamma'])
    })

    test('连续两个 $ 不匹配（留给块级公式）', () => {
        expect(extractMatches('$$x^2$$')).toEqual([])
    })

    test('单行内两个独立公式分别匹配', () => {
        const text = '$a^2$ and $b^3$'
        expect(extractMatches(text)).toEqual(['a^2', 'b^3'])
    })

    test('含转义 \$ 的公式内部不受影响', () => {
        // 内部 \$ 由 \\. 匹配，不视为关闭界定符
        expect(extractMatches('$x = \\$100$')).toEqual(['x = \\$100'])
    })

    test('空内容被拒（\$ 打开后第一个 \$ 立即关闭但内容为空）', () => {
        // 旧正则会匹配 $$（空内容），新正则不应匹配因为第一个 $ 后有 $
        expect(extractMatches('$$')).toEqual([])
    })
})
