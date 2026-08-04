/**
 * 基础语法检查工具测试
 */
import { describe, expect, it } from 'vitest'
import { checkSyntax, supportsSyntaxCheck, issuesByLine } from '@/utils/syntaxCheck'

describe('checkSyntax - JSON', () => {
  it('detects valid JSON as clean', () => {
    expect(checkSyntax('{"a": 1, "b": [1, 2]}', 'json')).toEqual([])
  })

  it('reports invalid JSON with position', () => {
    const issues = checkSyntax('{\n  "a": 1,\n}', 'json')
    expect(issues.length).toBe(1)
    expect(issues[0].severity).toBe('error')
    expect(issues[0].line).toBeGreaterThanOrEqual(1)
  })

  it('skips check for oversized content', () => {
    const big = `{"x":"${'a'.repeat(600 * 1024)}"}`
    expect(checkSyntax(big, 'json')).toEqual([])
  })
})

describe('checkSyntax - JS/TS bracket balance', () => {
  it('accepts balanced code', () => {
    const code = `
function foo(a: number) {
  const s = ")}]";
  const t = \`hello \${bar({ x: 1 })}\`;
  // comment with ( unmatched
  /* block ( comment */
  return a > 0 ? [a] : [];
}
`
    expect(checkSyntax(code, 'typescript')).toEqual([])
  })

  it('detects missing closing brace', () => {
    const issues = checkSyntax('function foo() {\n  return 1;\n', 'javascript')
    expect(issues.length).toBe(1)
    expect(issues[0].message).toContain('未闭合')
  })

  it('detects extra closing paren', () => {
    const issues = checkSyntax('const x = (1 + 2));', 'javascript')
    expect(issues.length).toBe(1)
    expect(issues[0].message).toContain('多余')
  })

  it('detects mismatched brackets', () => {
    const issues = checkSyntax('const x = [1, 2);', 'javascript')
    expect(issues.some(i => i.message.includes('不匹配'))).toBe(true)
  })

  it('detects unterminated string', () => {
    const issues = checkSyntax("const s = 'abc;", 'javascript')
    expect(issues.length).toBe(1)
    expect(issues[0].message).toContain('字符串未闭合')
  })
})

describe('checkSyntax - Python', () => {
  it('accepts balanced python', () => {
    const code = `
def foo(a):
    """doc string with ( parens"""
    s = 'it\\'s fine'
    return [x for x in range(a)]
`
    expect(checkSyntax(code, 'python')).toEqual([])
  })

  it('detects missing close bracket', () => {
    const issues = checkSyntax('data = [1, 2, 3', 'python')
    expect(issues.length).toBe(1)
    expect(issues[0].message).toContain('未闭合')
  })
})

describe('checkSyntax - HTML/XML', () => {
  it('accepts well-formed html', () => {
    const html = `<!DOCTYPE html>
<html>
  <head><title>t</title></head>
  <body>
    <div class="x"><br/><img src="a.png"></div>
  </body>
</html>`
    expect(checkSyntax(html, 'html')).toEqual([])
  })

  it('detects unclosed tag', () => {
    const issues = checkSyntax('<div><span>text</div>', 'html')
    expect(issues.some(i => i.message.includes('不匹配'))).toBe(true)
  })

  it('detects unterminated comment', () => {
    const issues = checkSyntax('<div><!-- comment', 'html')
    expect(issues.some(i => i.message.includes('注释未闭合'))).toBe(true)
  })
})

describe('checkSyntax - CSS', () => {
  it('accepts balanced css', () => {
    const css = '.a { color: red; }\n.b { content: "}"; }'
    expect(checkSyntax(css, 'css')).toEqual([])
  })

  it('detects unclosed brace', () => {
    const issues = checkSyntax('.a { color: red;', 'css')
    expect(issues.length).toBe(1)
    expect(issues[0].message).toContain('未闭合')
  })
})

describe('checkSyntax - unsupported languages', () => {
  it('returns no issues for unsupported languages', () => {
    expect(checkSyntax('随便什么内容', 'markdown')).toEqual([])
    expect(checkSyntax('foo: bar', 'yaml')).toEqual([])
    expect(supportsSyntaxCheck('markdown')).toBe(false)
    expect(supportsSyntaxCheck('typescript')).toBe(true)
  })
})

describe('issuesByLine', () => {
  it('groups issues by line', () => {
    const issues = [
      { line: 1, column: 2, message: 'a', severity: 'error' as const },
      { line: 1, column: 5, message: 'b', severity: 'error' as const },
      { line: 3, column: 1, message: 'c', severity: 'error' as const }
    ]
    const grouped = issuesByLine(issues)
    expect(grouped.get(1)?.length).toBe(2)
    expect(grouped.get(3)?.length).toBe(1)
  })
})
