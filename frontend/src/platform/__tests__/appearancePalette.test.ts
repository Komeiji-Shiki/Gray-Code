import { describe, expect, test } from 'vitest'
import {
  DARK_PALETTES, DEFAULT_UI_FONT, LEGACY_DEFAULT_UI_FONT, PALETTE_KEYS, SYNTAX_ROLES,
  resolveAppearancePalette, resolveCodePalette, resolveDarkPalette, resolvePaletteName, resolveUiFont
} from '../../../../shared/appearance'

const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(v => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}
const palettes = [
  ...DARK_PALETTES.map(id => [id, resolveAppearancePalette('dark', {}, false, id)] as const),
  ['ivory', resolveAppearancePalette('light')] as const
]

describe('品牌色板', () => {
  test.each(palettes)('%s 与其他色板键集合一致', (_name, palette) => {
    expect(Object.keys(palette).sort()).toEqual([...PALETTE_KEYS].sort())
  })

  test.each(palettes)('%s 关键组合满足对比度要求', (_name, p) => {
    const pairs: Array<[string, string, number]> = [
      ['text', 'background', 7], ['text', 'panel', 7], ['text', 'hover', 7],
      ['muted', 'background', 4.5], ['muted', 'panel', 4.5],
      ['accent', 'background', 4.5], ['accent', 'panel', 4.5],
      ['buttonText', 'button', 7], ['buttonSecondaryText', 'buttonSecondary', 7],
      ['chromeText', 'chrome', 7], ['chromeMuted', 'chrome', 4.5],
      ['danger', 'panel', 4.5], ['success', 'panel', 4.5], ['warning', 'panel', 4.5],
      ['selectionText', 'selection', 7]
    ]
    for (const [fg, bg, min] of pairs) {
      expect.soft(contrast(p[fg], p[bg]), `${fg}/${bg}`).toBeGreaterThanOrEqual(min)
    }
  })

  test('深色按所选配色解析，未知或缺省配色回落藏青外壳', () => {
    expect(resolveAppearancePalette('dark', {}, false, 'graphite').background).toBe('#181817')
    expect(resolveAppearancePalette('dark', {}, false, 'indigo').background).toBe('#161a26')
    expect(resolveAppearancePalette('dark').background).toBe('#17181b')
    expect(resolveAppearancePalette('dark', {}, false, 'unknown').background).toBe('#17181b')
    expect(resolveDarkPalette(undefined)).toBe('shell')
    expect(resolveDarkPalette('indigo')).toBe('indigo')
  })

  test('浅色忽略深色配色；跟随系统按系统明暗选择', () => {
    expect(resolveAppearancePalette('light', {}, false, 'indigo').background).toBe('#f7f5ee')
    expect(resolveAppearancePalette('system', {}, true, 'indigo').background).toBe('#f7f5ee')
    expect(resolveAppearancePalette('system', {}, false, 'indigo').background).toBe('#161a26')
    expect(resolvePaletteName('light', false, 'indigo')).toBe('ivory')
    expect(resolvePaletteName('dark', false, 'graphite')).toBe('graphite')
  })

  test('自定义颜色覆盖所选配色', () => {
    expect(resolveAppearancePalette('dark', { accent: '#a020f0' }, false, 'graphite').accent).toBe('#a020f0')
  })

  test('旧默认界面字体按新默认解析，自定义字体保持不变', () => {
    expect(resolveUiFont(LEGACY_DEFAULT_UI_FONT)).toBe(DEFAULT_UI_FONT)
    expect(resolveUiFont(undefined)).toBe(DEFAULT_UI_FONT)
    expect(resolveUiFont('"LXGW WenKai"')).toBe('"LXGW WenKai"')
  })
})

describe('代码与终端配色', () => {
  test.each([
    ['dark', ['#17181b', '#181817', '#161a26', '#121315', '#121211', '#10131c', '#1f2023', '#1e2333']],
    ['light', ['#f7f5ee', '#efece4', '#fdfcf8']]
  ] as const)('%s 语法色在所有代码底色上可读', (theme, backgrounds) => {
    const { syntax, ansi } = resolveCodePalette(theme)
    expect(Object.keys(syntax).sort()).toEqual([...SYNTAX_ROLES].sort())
    for (const role of SYNTAX_ROLES) for (const background of backgrounds)
      expect.soft(contrast(syntax[role], background), `${role}/${background}`).toBeGreaterThanOrEqual(role === 'comment' ? 3.5 : 4.5)
    const skipped = theme === 'dark' ? 'black' : 'brightWhite'
    for (const [name, color] of Object.entries(ansi)) if (name !== skipped) for (const background of backgrounds.slice(0, 3))
      expect.soft(contrast(color, background), `ansi.${name}/${background}`).toBeGreaterThanOrEqual(4.5)
  })

  test('跟随系统按系统明暗选择代码配色', () => {
    expect(resolveCodePalette('system', true).syntax.keyword).toBe('#5b4bb3')
    expect(resolveCodePalette('system', false).syntax.keyword).toBe('#b3a8ec')
  })
})
