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

test('切换主题保留主动指定的强调色，移除自定义值恢复主题颜色', async () => {
  const { applyDesktopAppearance } = await import('../appearance');
  const config = settings('light'); config.colors.accent = '#a020f0';
  applyDesktopAppearance(config); expect(document.documentElement.style.getPropertyValue('--gc-accent')).toBe('#a020f0');
  applyDesktopAppearance({ ...config, theme: 'dark' }); expect(document.documentElement.style.getPropertyValue('--gc-accent')).toBe('#a020f0');
  applyDesktopAppearance(settings('dark')); expect(document.documentElement.style.getPropertyValue('--gc-accent')).not.toBe('#a020f0');
});
