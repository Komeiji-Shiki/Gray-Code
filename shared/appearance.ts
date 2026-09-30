import type { AppearanceSettings } from '../packages/contracts/src/settings';

export const DARK_PALETTES = ['shell', 'graphite', 'indigo'] as const;
export type DarkPaletteId = typeof DARK_PALETTES[number];
export const DEFAULT_DARK_PALETTE: DarkPaletteId = 'shell';
/** 旧版本写入的默认界面字体；仍是该值时按新默认解析，不改写用户存储。 */
export const LEGACY_DEFAULT_UI_FONT = 'Segoe UI, Microsoft YaHei, sans-serif';
export const DEFAULT_UI_FONT = '"Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif';

export function resolveAppearanceTheme(theme: AppearanceSettings['theme'] = 'dark', systemLight = false): 'dark' | 'light' {
  return theme === 'light' || theme === 'system' && systemLight ? 'light' : 'dark';
}

export function resolveDarkPalette(id: unknown): DarkPaletteId {
  return (DARK_PALETTES as readonly unknown[]).includes(id) ? id as DarkPaletteId : DEFAULT_DARK_PALETTE;
}

export function resolveUiFont(uiFont?: string): string {
  return !uiFont || uiFont.trim() === LEGACY_DEFAULT_UI_FONT ? DEFAULT_UI_FONT : uiFont;
}

// 品牌色：藏青 #232A42、象牙白 #F7F5EE、石板灰 #727682。工作台、聊天、原生标题栏与对话框共用。
// chrome 系用于标题栏、导航侧栏与标签栏；surface 为凹陷底（代码与命令块）。
const darkPalettes: Record<DarkPaletteId, Record<string, string>> = {
  shell: {
    chrome: '#1a2033', chromeHover: '#232a42', chromeBorder: '#262d45', chromeText: '#e9e6de', chromeMuted: '#9aa0b5',
    background: '#17181b', panel: '#1f2023', surface: '#121315', input: '#1f2023', text: '#ece9e1', muted: '#9c9a94', disabled: '#6e6c67',
    border: '#2c2d31', hover: '#26272b', selection: '#2a3350', selectionText: '#f7f5ee', accent: '#9fb0e8', linkActive: '#c3cdf2',
    button: '#f2eee5', buttonHover: '#faf8f2', buttonText: '#232a42',
    buttonSecondary: '#2a2b2f', buttonSecondaryHover: '#323338', buttonSecondaryText: '#e3e0d8',
    danger: '#e8877f', success: '#8dc4a0', warning: '#e3b566', scrollbar: '#6b6d7340', scrollbarHover: '#8a8c9270',
  },
  graphite: {
    chrome: '#121211', chromeHover: '#1c1c1a', chromeBorder: '#242422', chromeText: '#ece9e1', chromeMuted: '#9a978e',
    background: '#181817', panel: '#21211f', surface: '#121211', input: '#21211f', text: '#ece9e1', muted: '#9a978e', disabled: '#6c6a64',
    border: '#2e2e2b', hover: '#282826', selection: '#2d3348', selectionText: '#f7f5ee', accent: '#8fa2e0', linkActive: '#b9c5ef',
    button: '#ece9e1', buttonHover: '#f7f5ee', buttonText: '#1b1b1a',
    buttonSecondary: '#2b2b28', buttonSecondaryHover: '#333330', buttonSecondaryText: '#e3e0d8',
    danger: '#e5857d', success: '#8cc19e', warning: '#e0b263', scrollbar: '#6b6a6540', scrollbarHover: '#8a887f70',
  },
  indigo: {
    chrome: '#10131c', chromeHover: '#1a1f2e', chromeBorder: '#1f2536', chromeText: '#ece8df', chromeMuted: '#8e93a3',
    background: '#161a26', panel: '#1e2333', surface: '#10131c', input: '#1e2333', text: '#ece8df', muted: '#8e93a3', disabled: '#666b7c',
    border: '#2a3044', hover: '#242a3c', selection: '#2e3a5e', selectionText: '#f7f5ee', accent: '#9fb0e8', linkActive: '#c3cdf2',
    button: '#f2eee5', buttonHover: '#faf8f2', buttonText: '#232a42',
    buttonSecondary: '#283049', buttonSecondaryHover: '#2f3854', buttonSecondaryText: '#e3e0d8',
    danger: '#e8877f', success: '#8dc4a0', warning: '#e3b566', scrollbar: '#6b738a40', scrollbarHover: '#8a92a870',
  },
};
const ivory: Record<string, string> = {
  chrome: '#efece4', chromeHover: '#e5e1d6', chromeBorder: '#ddd8cc', chromeText: '#232a42', chromeMuted: '#5e6270',
  background: '#f7f5ee', panel: '#fdfcf8', surface: '#efece4', input: '#fdfcf8', text: '#232a42', muted: '#636776', disabled: '#9a9ca5',
  border: '#e0dbcf', hover: '#efebe1', selection: '#dfe3f3', selectionText: '#1b2135', accent: '#3b4f9a', linkActive: '#2a3b7c',
  button: '#232a42', buttonHover: '#2f3756', buttonText: '#f7f5ee',
  buttonSecondary: '#ebe7dc', buttonSecondaryHover: '#e2ddd0', buttonSecondaryText: '#232a42',
  danger: '#b3413a', success: '#3d7a52', warning: '#8a6015', scrollbar: '#7a7d8a40', scrollbarHover: '#5f627080',
};

export const PALETTE_KEYS: readonly string[] = Object.keys(ivory);

export function resolvePaletteName(theme: AppearanceSettings['theme'] = 'dark', systemLight = false, darkPalette?: unknown): DarkPaletteId | 'ivory' {
  return resolveAppearanceTheme(theme, systemLight) === 'light' ? 'ivory' : resolveDarkPalette(darkPalette);
}

export function resolveAppearancePalette(theme: AppearanceSettings['theme'] = 'dark', colors: Record<string, string> = {}, systemLight = false, darkPalette?: unknown): Record<string, string> {
  const name = resolvePaletteName(theme, systemLight, darkPalette);
  return { ...(name === 'ivory' ? ivory : darkPalettes[name]), ...colors };
}
