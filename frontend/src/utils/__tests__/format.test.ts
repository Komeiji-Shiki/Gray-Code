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
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { copyToClipboard } from '../format'

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

  it('clipboard API 可用时优先走 writeText，不触发 execCommand', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    mockClipboard({ writeText })

    const ok = await copyToClipboard('hello 世界')

    expect(ok).toBe(true)
    expect(writeText).toHaveBeenCalledWith('hello 世界')
    expect(execCommandMock).not.toHaveBeenCalled()
  })

  it('clipboard API 缺失（Webview 非 secure context）时回退 execCommand', async () => {
    mockClipboard(undefined)

    const ok = await copyToClipboard('fallback text')

    expect(ok).toBe(true)
    // 临时 textarea 已被清理
    expect(document.querySelector('textarea')).toBeNull()
    expect(execCommandMock).toHaveBeenCalledWith('copy')
  })

  it('clipboard API 抛错时回退 execCommand', async () => {
    mockClipboard({ writeText: vi.fn().mockRejectedValue(new Error('NotAllowedError')) })

    const ok = await copyToClipboard('retry text')

    expect(ok).toBe(true)
    expect(execCommandMock).toHaveBeenCalled()
  })

  it('两条路径都失败时返回 false', async () => {
    mockClipboard({ writeText: vi.fn().mockRejectedValue(new Error('denied')) })
    execCommandMock.mockReturnValue(false)

    const ok = await copyToClipboard('both fail')

    expect(ok).toBe(false)
    expect(document.querySelector('textarea')).toBeNull()
  })

  it('回退路径恢复用户原有文本选区', async () => {
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
