import { globPatternToRegExp } from '../../modules/prompt/glob'

function matchFull(pattern: string, path: string): boolean {
    return new RegExp('^' + globPatternToRegExp(pattern) + '$', 'i').test(path)
}

function matchAnywhere(pattern: string, path: string): boolean {
    const src = globPatternToRegExp(pattern)
    return new RegExp(`^${src}$|/${src}$|^${src}/|/${src}/`, 'i').test(path)
}

describe('globPatternToRegExp（gitignore 式语义）', () => {
    // globstar 零段：模式 ** 加 分隔符 加 x 匹配任意层级，含根级（gitignore 语义）
    it('globstar 前缀匹配根级路径（零段展开）', () => {
        expect(matchFull('**/x', 'x')).toBe(true)
        expect(matchFull('**/x', 'a/x')).toBe(true)
        expect(matchFull('**/x', 'a/b/x')).toBe(true)
        expect(matchFull('**/x', 'a/b/y')).toBe(false)
    })

    it('globstar 中间零段：a/**/b 匹配 a/b', () => {
        expect(matchFull('a/**/b', 'a/b')).toBe(true)
        expect(matchFull('a/**/b', 'a/x/b')).toBe(true)
        expect(matchFull('a/**/b', 'a/b/c')).toBe(false)
        expect(matchFull('a/**/b', 'a')).toBe(false)
    })

    it('单星不跨目录段', () => {
        expect(matchFull('*.ts', 'b.ts')).toBe(true)
        expect(matchFull('*.ts', 'a/b.ts')).toBe(false)
        expect(matchFull('src/*.ts', 'src/a.ts')).toBe(true)
        expect(matchFull('src/*.ts', 'src/a/b.ts')).toBe(false)
    })

    it('globstar 后缀匹配目录下所有内容', () => {
        expect(matchFull('x/**', 'x/a')).toBe(true)
        expect(matchFull('x/**', 'x/a/b')).toBe(true)
        expect(matchFull('x/**', 'x')).toBe(false)
    })

    it('裸 globstar 匹配一切', () => {
        expect(matchFull('**', 'anything/at/all')).toBe(true)
    })

    it('元字符不再抛 SyntaxError', () => {
        expect(() => globPatternToRegExp('a[b]')).not.toThrow()
        expect(() => globPatternToRegExp('a(b)')).not.toThrow()
        expect(() => globPatternToRegExp('a+b?')).not.toThrow()
        expect(matchFull('a[b]', 'a[b]')).toBe(true)
        expect(matchFull('a+b?', 'a+b?')).toBe(true)
    })

    it('模式中的反斜杠归一化为正斜杠', () => {
        expect(matchFull('**\\x', 'a/x')).toBe(true)
        expect(matchFull('**\\x', 'x')).toBe(true)
    })

    it('四锚任意位置匹配（忽略模式语义）', () => {
        expect(matchAnywhere('node_modules', 'a/node_modules')).toBe(true)
        expect(matchAnywhere('node_modules', 'a/node_modules/b')).toBe(true)
        expect(matchAnywhere('*.log', 'logs/app.log')).toBe(true)
        expect(matchAnywhere('*.log', 'app.txt')).toBe(false)
    })
})
