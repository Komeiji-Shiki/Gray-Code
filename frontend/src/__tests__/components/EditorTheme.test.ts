import { describe, expect, test } from 'vitest'
import { terminalThemeData, workbenchThemeData } from '../../../../apps/client/src/editorTheme'
import { resolveAppearancePalette } from '../../../../shared/appearance'

describe('编辑器主题', () => {
  test('底色、选区与语法色取自当前色板与品牌代码配色', () => {
    const palette = resolveAppearancePalette('dark', {}, false, 'graphite')
    const theme = workbenchThemeData(palette, false)
    expect(theme.base).toBe('vs-dark')
    expect(theme.colors['editor.background']).toBe('#181817')
    expect(theme.colors['editor.selectionBackground']).toBe(palette.selection)
    expect(theme.rules).toContainEqual({ token: 'keyword', foreground: 'b3a8ec' })
    expect(theme.rules).toContainEqual({ token: 'comment', foreground: '7f8391', fontStyle: 'italic' })
  })

  test('浅色使用纸上墨语法色', () => {
    const theme = workbenchThemeData(resolveAppearancePalette('light'), true)
    expect(theme.base).toBe('vs')
    expect(theme.rules).toContainEqual({ token: 'keyword', foreground: '5b4bb3' })
  })

  test('终端使用当前色板底色与品牌 ANSI 颜色', () => {
    const palette = resolveAppearancePalette('dark', {}, false, 'indigo')
    const theme = terminalThemeData(palette, false)
    expect(theme).toMatchObject({ background: '#161a26', foreground: palette.text, cursor: palette.accent, selectionBackground: palette.selection,
      red: '#e8877f', blue: '#93a8e8', brightWhite: '#f7f5ee' })
    expect(terminalThemeData(resolveAppearancePalette('light'), true)).toMatchObject({ green: '#376e49', black: '#232a42' })
  })

  test('非六位十六进制的自定义颜色逐项回落默认色板，透明度拼接仍然合法', () => {
    const palette = { ...resolveAppearancePalette('dark'), background: 'rgb(1, 2, 3)', hover: '#abc' }
    const theme = workbenchThemeData(palette, false)
    expect(theme.colors['editor.background']).toBe(resolveAppearancePalette('dark').background)
    for (const value of Object.values(theme.colors)) expect(value).toMatch(/^#[0-9a-f]{6}([0-9a-f]{2})?$/i)
  })
})
