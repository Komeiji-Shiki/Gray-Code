import { beforeEach, expect, test, vi } from 'vitest';
import type { AppearanceSettings } from '../../../../packages/contracts/src/settings';

let listener: (() => void) | undefined;
let scheme: { matches: boolean; addEventListener: ReturnType<typeof vi.fn> };
const settings = (theme: AppearanceSettings['theme']): AppearanceSettings => ({ theme, colors: {}, uiFont: 'sans-serif', textFont: 'inherit', codeFont: 'monospace',
  fontSize: 14, codeFontSize: 14, lineHeight: 1.6, density: 'comfortable', backgroundImage: '', backgroundOpacity: 0, customCss: '' });
beforeEach(() => {
  vi.resetModules(); listener = undefined;
  document.documentElement.style.cssText = '';
  scheme = { matches: false, addEventListener: vi.fn((_type, callback) => { listener = callback; }) };
  vi.stubGlobal('matchMedia', vi.fn(() => scheme)); vi.stubGlobal('CSS', { supports: () => true });
});

test('跟随系统会更新聊天及菜单配色，手动选定主题后不再受系统变化影响', async () => {
  const { applyDesktopAppearance } = await import('../appearance');
  applyDesktopAppearance(settings('system'));
  const darkText = document.documentElement.style.getPropertyValue('--vscode-foreground');
  const darkMenu = document.documentElement.style.getPropertyValue('--vscode-list-hoverBackground');
  scheme.matches = true; listener!();
  expect(document.documentElement.dataset.theme).toBe('light');
  expect(document.documentElement.style.getPropertyValue('--vscode-foreground')).not.toBe(darkText);
  expect(document.documentElement.style.getPropertyValue('--vscode-list-hoverBackground')).not.toBe(darkMenu);
  applyDesktopAppearance(settings('dark')); scheme.matches = false; listener!(); scheme.matches = true; listener!();
  expect(document.documentElement.dataset.theme).toBe('dark');
  expect(document.documentElement.style.getPropertyValue('--vscode-foreground')).toBe(darkText);
  expect(scheme.addEventListener).toHaveBeenCalledTimes(1);
});

test('注入写出语义 token 与兼容别名，并随深色配色切换', async () => {
  const { applyDesktopAppearance } = await import('../appearance');
  const style = document.documentElement.style;
  applyDesktopAppearance({ ...settings('dark'), darkPalette: 'graphite' });
  expect(style.getPropertyValue('--gc-surface-base')).toBe('#181817');
  expect(style.getPropertyValue('--gc-button-primary')).toBe('#ece9e1');
  expect(style.getPropertyValue('--vscode-editor-background')).toBe('#181817');
  expect(document.documentElement.dataset.palette).toBe('graphite');
  applyDesktopAppearance({ ...settings('dark'), darkPalette: 'indigo' });
  expect(style.getPropertyValue('--gc-surface-chrome')).toBe('#10131c');
  applyDesktopAppearance({ ...settings('light'), darkPalette: 'indigo' });
  expect(document.documentElement.dataset.palette).toBe('ivory');
});

test('自定义颜色覆盖所选深色配色，旧默认界面字体按新默认写出', async () => {
  const { applyDesktopAppearance } = await import('../appearance');
  const config = { ...settings('dark'), darkPalette: 'graphite' as const, uiFont: 'Segoe UI, Microsoft YaHei, sans-serif', colors: { background: '#000000' } };
  applyDesktopAppearance(config);
  expect(document.documentElement.style.getPropertyValue('--gc-surface-base')).toBe('#000000');
  expect(document.documentElement.style.getPropertyValue('--gc-font-ui')).toContain('Segoe UI Variable Text');
});

test('切换主题保留主动指定的强调色，移除自定义值恢复主题颜色', async () => {
  const { applyDesktopAppearance } = await import('../appearance');
  const config = settings('light'); config.colors.accent = '#a020f0';
  applyDesktopAppearance(config); expect(document.documentElement.style.getPropertyValue('--gc-accent')).toBe('#a020f0');
  applyDesktopAppearance({ ...config, theme: 'dark' }); expect(document.documentElement.style.getPropertyValue('--gc-accent')).toBe('#a020f0');
  applyDesktopAppearance(settings('dark')); expect(document.documentElement.style.getPropertyValue('--gc-accent')).not.toBe('#a020f0');
});
