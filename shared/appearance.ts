import type { AppearanceSettings } from '../packages/contracts/src/settings';

export function resolveAppearanceTheme(theme: AppearanceSettings['theme'] = 'dark', systemLight = false): 'dark' | 'light' {
  return theme === 'light' || theme === 'system' && systemLight ? 'light' : 'dark';
}

// 工作台、聊天和原生控件共用配色，避免同一窗口出现两套明暗状态。
const palettes = {
  dark: {
    background: '#17191e', panel: '#22252c', surface: '#101217', input: '#2a2e36', text: '#dedee3', muted: '#969ba6', disabled: '#747a85',
    accent: '#6ba6ff', border: '#323742', hover: '#2c3340', selection: '#27466d', selectionText: '#ffffff',
    button: '#2674cd', buttonHover: '#3585df', buttonText: '#ffffff', linkActive: '#a2c7ff',
    danger: '#f08080', success: '#88c7a2', warning: '#e8bc72', scrollbar: '#5b63714d', scrollbarHover: '#78839680',
  },
  light: {
    background: '#f5f6f8', panel: '#ffffff', surface: '#ffffff', input: '#ffffff', text: '#242832', muted: '#586373', disabled: '#858c98',
    accent: '#2464bd', border: '#d5dbe5', hover: '#e8edf5', selection: '#d5e5fb', selectionText: '#163e76',
    button: '#2464bd', buttonHover: '#1b519d', buttonText: '#ffffff', linkActive: '#17498f',
    danger: '#b52f39', success: '#287d46', warning: '#8a5d10', scrollbar: '#69798d55', scrollbarHover: '#52647c88',
  },
};

export function resolveAppearancePalette(theme: AppearanceSettings['theme'] = 'dark', colors: Record<string, string> = {}, systemLight = false): Record<string, string> {
  return { ...palettes[resolveAppearanceTheme(theme, systemLight)], ...colors };
}
