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
// border 是输入框等控件的描边；divider 是半透明分割线，叠在任何底色上都只比底色亮一点。
// 藏青外壳：外壳用饱和藏青，内容区取同一色相的低饱和石板色，避免冷外壳配暖灰内容。
const darkPalettes: Record<DarkPaletteId, Record<string, string>> = {
  shell: {
    chrome: '#1a2033', chromeHover: '#232a42', chromeBorder: '#262d45', chromeText: '#e9e6de', chromeMuted: '#9aa0b5',
    background: '#17191f', panel: '#1f222a', surface: '#121419', input: '#1f222a', text: '#ece9e1', muted: '#9da2b0', disabled: '#6d7280',
    border: '#2b2f39', divider: '#9da2b017', hover: '#252933', selection: '#2a3350', selectionText: '#f7f5ee', accent: '#9fb0e8', linkActive: '#c3cdf2',
    button: '#f2eee5', buttonHover: '#faf8f2', buttonText: '#232a42',
    buttonSecondary: '#282c37', buttonSecondaryHover: '#30343f', buttonSecondaryText: '#e3e0d8',
    danger: '#e8877f', success: '#8dc4a0', warning: '#e3b566', scrollbar: '#6d728040', scrollbarHover: '#8b90a070',
  },
  graphite: {
    chrome: '#121211', chromeHover: '#1c1c1a', chromeBorder: '#242422', chromeText: '#ece9e1', chromeMuted: '#9a978e',
    background: '#181817', panel: '#21211f', surface: '#121211', input: '#21211f', text: '#ece9e1', muted: '#9a978e', disabled: '#6c6a64',
    border: '#2e2e2b', divider: '#9a978e17', hover: '#282826', selection: '#2d3348', selectionText: '#f7f5ee', accent: '#8fa2e0', linkActive: '#b9c5ef',
    button: '#ece9e1', buttonHover: '#f7f5ee', buttonText: '#1b1b1a',
    buttonSecondary: '#2b2b28', buttonSecondaryHover: '#333330', buttonSecondaryText: '#e3e0d8',
    danger: '#e5857d', success: '#8cc19e', warning: '#e0b263', scrollbar: '#6b6a6540', scrollbarHover: '#8a887f70',
  },
  indigo: {
    chrome: '#10131c', chromeHover: '#1a1f2e', chromeBorder: '#1f2536', chromeText: '#ece8df', chromeMuted: '#8e93a3',
    background: '#161a26', panel: '#1e2333', surface: '#10131c', input: '#1e2333', text: '#ece8df', muted: '#8e93a3', disabled: '#666b7c',
    border: '#2a3044', divider: '#8e93a317', hover: '#242a3c', selection: '#2e3a5e', selectionText: '#f7f5ee', accent: '#9fb0e8', linkActive: '#c3cdf2',
    button: '#f2eee5', buttonHover: '#faf8f2', buttonText: '#232a42',
    buttonSecondary: '#283049', buttonSecondaryHover: '#2f3854', buttonSecondaryText: '#e3e0d8',
    danger: '#e8877f', success: '#8dc4a0', warning: '#e3b566', scrollbar: '#6b738a40', scrollbarHover: '#8a92a870',
  },
};
const ivory: Record<string, string> = {
  chrome: '#efece4', chromeHover: '#e5e1d6', chromeBorder: '#ddd8cc', chromeText: '#232a42', chromeMuted: '#5e6270',
  background: '#f7f5ee', panel: '#fdfcf8', surface: '#efece4', input: '#fdfcf8', text: '#232a42', muted: '#636776', disabled: '#9a9ca5',
  border: '#e0dbcf', divider: '#63677624', hover: '#efebe1', selection: '#dfe3f3', selectionText: '#1b2135', accent: '#3b4f9a', linkActive: '#2a3b7c',
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

export const SYNTAX_ROLES = ['keyword', 'string', 'number', 'function', 'type', 'comment', 'variable', 'property', 'tag', 'attribute', 'regexp', 'operator', 'constant'] as const;
export type SyntaxRole = typeof SYNTAX_ROLES[number];
type AnsiName = 'black' | 'red' | 'green' | 'yellow' | 'blue' | 'magenta' | 'cyan' | 'white'
  | 'brightBlack' | 'brightRed' | 'brightGreen' | 'brightYellow' | 'brightBlue' | 'brightMagenta' | 'brightCyan' | 'brightWhite';

// 编辑器、Markdown 代码块与终端共用：深色「墨上彩」，浅色「纸上墨」；三套深色配色共用同一组，保证代码观感一致。
const codePalettes: Record<'dark' | 'light', { syntax: Record<SyntaxRole, string>; ansi: Record<AnsiName, string> }> = {
  dark: {
    syntax: { keyword: '#b3a8ec', string: '#a9cb98', number: '#e5b27c', function: '#8fc8d8', type: '#e2c88c', comment: '#7f8391', variable: '#dcd7cc',
      property: '#c9c3b6', tag: '#e89a8f', attribute: '#d9b98a', regexp: '#dca6c8', operator: '#aba89f', constant: '#e5b27c' },
    ansi: { black: '#2a2d35', red: '#e8877f', green: '#8dc4a0', yellow: '#e3b566', blue: '#93a8e8', magenta: '#c4a8e4', cyan: '#8fc8d8', white: '#d9d5cb',
      brightBlack: '#7f8391', brightRed: '#f0a49d', brightGreen: '#a9d6b8', brightYellow: '#eecb8c', brightBlue: '#b0c0f0', brightMagenta: '#d6c0ee', brightCyan: '#abd8e5', brightWhite: '#f7f5ee' },
  },
  light: {
    syntax: { keyword: '#5b4bb3', string: '#44703a', number: '#a3551b', function: '#1d6b82', type: '#835f0c', comment: '#74778a', variable: '#232a42',
      property: '#3d4460', tag: '#a3413a', attribute: '#86560f', regexp: '#94397a', operator: '#5e6270', constant: '#a3551b' },
    ansi: { black: '#232a42', red: '#b3413a', green: '#376e49', yellow: '#8a6015', blue: '#3b4f9a', magenta: '#7d3f8f', cyan: '#1d6b82', white: '#60647a',
      brightBlack: '#5e6270', brightRed: '#9c342e', brightGreen: '#316a44', brightYellow: '#74500f', brightBlue: '#2f4185', brightMagenta: '#69327a', brightCyan: '#175a6e', brightWhite: '#232a42' },
  },
};

export function resolveCodePalette(theme: AppearanceSettings['theme'] = 'dark', systemLight = false) {
  return codePalettes[resolveAppearanceTheme(theme, systemLight)];
}
