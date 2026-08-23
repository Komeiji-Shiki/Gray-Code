import { describe, expect, test } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import { join, relative } from 'path'

/**
 * 静态断言：防止前端样式/交互回归。
 * 这些规则在源码层面扫描，不依赖运行时渲染。
 */

const COMPONENTS_DIR = join(__dirname, '../../components')

function collectVueFiles(): string[] {
  const out: string[] = []
  const stack = [COMPONENTS_DIR]
  while (stack.length > 0) {
    const dir = stack.pop()!
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name)
      if (entry.isDirectory()) stack.push(p)
      else if (entry.name.endsWith('.vue')) out.push(p)
    }
  }
  return out
}

function collectScriptFiles(): string[] {
  const out: string[] = []
  const stack = [COMPONENTS_DIR]
  while (stack.length > 0) {
    const dir = stack.pop()!
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name)
      if (entry.isDirectory()) stack.push(p)
      else if (entry.name.endsWith('.ts') || entry.name.endsWith('.vue')) out.push(p)
    }
  }
  return out
}

function lineOf(src: string, index: number): number {
  return src.slice(0, index).split('\n').length
}

describe('frontend 静态守卫', () => {
  test('禁止 rgba(var(--vscode-*)) 这类失效的 CSS 写法', () => {
    const offenders: string[] = []
    for (const file of collectVueFiles()) {
      const src = readFileSync(file, 'utf8')
      const re = /rgba\(\s*var\(--vscode-/g
      let m: RegExpExecArray | null
      while ((m = re.exec(src)) !== null) {
        offenders.push(`${relative(process.cwd(), file)}:${lineOf(src, m.index)}`)
      }
    }
    expect(offenders).toEqual([])
  })

  test('禁止原生 alert()', () => {
    const offenders: string[] = []
    for (const file of collectScriptFiles()) {
      const src = readFileSync(file, 'utf8')
      // 排除注释行：仅匹配非注释上下文中的 alert( 调用
      let m: RegExpExecArray | null
      const re = /\balert\s*\(/g
      while ((m = re.exec(src)) !== null) {
        const lineStart = src.lastIndexOf('\n', m.index) + 1
        const lineText = src.slice(lineStart, m.index)
        const isComment = /^\s*\/\//.test(lineText) || /^\s*\*/.test(lineText)
        if (!isComment) {
          offenders.push(`${relative(process.cwd(), file)}:${lineOf(src, m.index)}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  test('禁止业务组件自建弹窗遮罩（统一由 Modal 提供）', () => {
    const FORBIDDEN = ['dialog-overlay', 'config-dialog', 'manifest-overlay', 'dialog-backdrop']
    const offenders: string[] = []
    for (const file of collectVueFiles()) {
      const src = readFileSync(file, 'utf8')
      const styleRe = /<style[\s\S]*?<\/style>/g
      let m: RegExpExecArray | null
      while ((m = styleRe.exec(src)) !== null) {
        const style = m[0]
        for (const name of FORBIDDEN) {
          if (style.includes(name)) {
            offenders.push(relative(process.cwd(), file))
          }
        }
      }
    }
    expect(offenders).toEqual([])
  })

  test('纯图标按钮必须提供可访问名称（aria-label / title）', () => {
    const offenders: string[] = []
    for (const file of collectVueFiles()) {
      const src = readFileSync(file, 'utf8')
      const btnRe = /<button\b[\s\S]*?<\/button>/g
      let m: RegExpExecArray | null
      while ((m = btnRe.exec(src)) !== null) {
        const block = m[0]
        const openTag = block.slice(0, block.indexOf('>') + 1)
        const inner = block.slice(block.indexOf('>') + 1, block.lastIndexOf('</button>'))
        const hasLabel = /aria-label\s*=\s*["'][^"']+["']/.test(openTag)
          || /aria-labelledby\s*=/.test(openTag)
          || /title\s*=\s*["'][^"']+["']/.test(openTag)
        const text = inner.replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#8203;/g, '').trim()
        const hasVueText = /\{\{/.test(inner)
        if (!hasLabel && text === '' && !hasVueText) {
          offenders.push(`${relative(process.cwd(), file)}:${lineOf(src, m.index)}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  test('禁止 rg/raw 残留：rgba(var(--gc-lightness)) 等畸形函数', () => {
    // 防止手滑引入无法编译的 CSS color-mix 占位
    const offenders: string[] = []
    for (const file of collectVueFiles()) {
      const src = readFileSync(file, 'utf8')
      const styleRe = /<style[\s\S]*?<\/style>/g
      let m: RegExpExecArray | null
      while ((m = styleRe.exec(src)) !== null) {
        const style = m[0]
        if (/rgba\(\s*[^)]*--gc-lightness/.test(style)) {
          offenders.push(relative(process.cwd(), file))
        }
      }
    }
    expect(offenders).toEqual([])
  })
})
