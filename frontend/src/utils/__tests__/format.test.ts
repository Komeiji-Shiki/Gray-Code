/**
 * copyToClipboard 复制兜底测试
 *
 * 背景：VSCode Webview（vscode-webview:// 非 secure context）中 navigator.clipboard
 * 可能缺失或被权限策略拒绝，复制必须回退 textarea + document.execCommand('copy')，
 * 否则代码块/消息复制按钮点击后静默失败（用户无感知）。
 *
 * 覆盖：
 * - clipboard API 可用：优先走 writeText
 * - clipboard API 缺失（undefined）：回退 execCommand
 * - clipboard API 抛错：回退 execCommand
 * - 两条路径都失败：返回 false
 * - 回退路径清理临时 textarea 并恢复原选区
 */
import { describe, expect, vi, beforeEach, afterEach } from 'vitest'
import { copyToClipboard, decodeUnicodeEscapes } from '../format'

describe('copyToClipboard', () => {
  const originalClipboard = navigator.clipboard
  let execCommandMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    execCommandMock = vi.fn(() => true)
    document.execCommand = execCommandMock as unknown as typeof document.execCommand
  })

  afterEach(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: originalClipboard
    })
    vi.restoreAllMocks()
  })

  function mockClipboard(writeText: unknown) {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: writeText
    })
  }

  test('clipboard API 可用时优先走 writeText，不触发 execCommand', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    mockClipboard({ writeText })

    const ok = await copyToClipboard('hello 世界')

    expect(ok).toBe(true)
    expect(writeText).toHaveBeenCalledWith('hello 世界')
    expect(execCommandMock).not.toHaveBeenCalled()
  })

  test('clipboard API 缺失（Webview 非 secure context）时回退 execCommand', async () => {
    mockClipboard(undefined)

    const ok = await copyToClipboard('fallback text')

    expect(ok).toBe(true)
    // 临时 textarea 已被清理
    expect(document.querySelector('textarea')).toBeNull()
    expect(execCommandMock).toHaveBeenCalledWith('copy')
  })

  test('clipboard API 抛错时回退 execCommand', async () => {
    mockClipboard({ writeText: vi.fn().mockRejectedValue(new Error('NotAllowedError')) })

    const ok = await copyToClipboard('retry text')

    expect(ok).toBe(true)
    expect(execCommandMock).toHaveBeenCalled()
  })

  test('两条路径都失败时返回 false', async () => {
    mockClipboard({ writeText: vi.fn().mockRejectedValue(new Error('denied')) })
    execCommandMock.mockReturnValue(false)

    const ok = await copyToClipboard('both fail')

    expect(ok).toBe(false)
    expect(document.querySelector('textarea')).toBeNull()
  })

  test('回退路径恢复用户原有文本选区', async () => {
    mockClipboard(undefined)

    // 先制造一个现有选区
    const host = document.createElement('div')
    host.textContent = 'selected text'
    document.body.appendChild(host)
    const range = document.createRange()
    range.selectNodeContents(host)
    const selection = document.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)

    const ok = await copyToClipboard('copy this')

    expect(ok).toBe(true)
    // 原选区恢复（临时 textarea 选中不残留）
    expect(selection.toString()).toBe('selected text')
    document.body.removeChild(host)
  })
})

// 以下用例由 test/unit/frontend/utils/format.test.ts 归位合并（断言/用例零改动）
describe('decodeUnicodeEscapes', () => {
    test('无转义序列时原样返回（引用不变，零开销短路）', () => {
        const text = '{"path": "src/main.ts", "content": "hello 中文"}'
        expect(decodeUnicodeEscapes(text)).toBe(text)
    })

    test('解码基本中文转义序列', () => {
        expect(decodeUnicodeEscapes('\\u4e2d\\u6587')).toBe('中文')
    })

    test('解码混合在 JSON 文本中的转义序列', () => {
        const input = '{"oldContent": "\\u5468\\u56f4\\u5168\\u5728", "path": "a.ts"}'
        expect(decodeUnicodeEscapes(input)).toBe('{"oldContent": "周围全在", "path": "a.ts"}')
    })

    test('支持大写十六进制', () => {
        expect(decodeUnicodeEscapes('\\u4E2D')).toBe('中')
    })

    test('流式截断的尾部保持原样，完整部分正常解码', () => {
        expect(decodeUnicodeEscapes('\\u4e2d\\u65')).toBe('中\\u65')
        expect(decodeUnicodeEscapes('\\u')).toBe('\\u')
    })

    test('成对反斜杠后的 uXXXX 是字面量，不被解码', () => {
        // JSON 里的 "\\\\u0041" 表示字面文本 \\u0041，不是转义
        expect(decodeUnicodeEscapes('\\\\u0041')).toBe('\\\\u0041')
    })

    test('奇数个反斜杠：前两个保留，剩余的 \\uXXXX 正常解码', () => {
        // \\\\u0041 = 字面反斜杠 + 字符 A
        expect(decodeUnicodeEscapes('\\\\\\u0041')).toBe('\\\\A')
    })

    test('代理对解码为完整 emoji', () => {
        expect(decodeUnicodeEscapes('\\ud83d\\ude00')).toBe('😀')
    })

    test('非十六进制的 \\u 序列保持原样', () => {
        expect(decodeUnicodeEscapes('\\uzzzz')).toBe('\\uzzzz')
    })
})
