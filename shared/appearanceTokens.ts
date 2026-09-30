import type { AppearanceSettings } from '../packages/contracts/src/settings';
import { resolveAppearancePalette, resolveAppearanceTheme, resolvePaletteName, resolveUiFont } from './appearance';

/** 色板键 → 组件唯一引用的语义 token。 */
export const semanticTokens: Record<string, string[]> = {
  chrome: ['--gc-surface-chrome'], chromeHover: ['--gc-surface-chrome-hover'], chromeBorder: ['--gc-border-chrome'],
  chromeText: ['--gc-text-on-chrome'], chromeMuted: ['--gc-text-on-chrome-muted'],
  background: ['--gc-surface-base', '--gc-surface-panel'], panel: ['--gc-surface-raised', '--gc-surface-overlay'],
  surface: ['--gc-surface-sunken'], input: ['--gc-surface-input'],
  text: ['--gc-text-primary'], muted: ['--gc-text-muted'], disabled: ['--gc-text-disabled'],
  accent: ['--gc-accent', '--gc-link', '--gc-focus-border'], linkActive: ['--gc-link-active'],
  border: ['--gc-border-subtle', '--gc-border-control'], hover: ['--gc-surface-hover'],
  selection: ['--gc-surface-selected', '--gc-surface-active'], selectionText: ['--gc-text-selected'],
  button: ['--gc-button-primary'], buttonHover: ['--gc-button-primary-hover'], buttonText: ['--gc-text-on-primary'],
  buttonSecondary: ['--gc-button-secondary'], buttonSecondaryHover: ['--gc-button-secondary-hover'], buttonSecondaryText: ['--gc-text-on-secondary'],
  danger: ['--gc-danger'], success: ['--gc-success'], warning: ['--gc-warning'],
  scrollbar: ['--gc-scrollbar'], scrollbarHover: ['--gc-scrollbar-hover'],
};

/** 兼容别名：保留的 VS Code 宿主入口与用户自定义 CSS 仍可使用这些变量。 */
export const appearanceTokens: Record<string, string[]> = {
  background: ['--vscode-editor-background', '--vscode-sideBar-background'], panel: ['--vscode-editorWidget-background'], input: ['--vscode-input-background'],
  text: ['--vscode-foreground', '--vscode-input-foreground'], muted: ['--vscode-descriptionForeground'], disabled: ['--vscode-disabledForeground'],
  accent: ['--vscode-textLink-foreground', '--vscode-focusBorder', '--vscode-charts-blue'],
  border: ['--vscode-panel-border', '--vscode-input-border', '--vscode-widget-border', '--vscode-editorWidget-border'],
  hover: ['--vscode-list-hoverBackground', '--vscode-toolbar-hoverBackground', '--vscode-editor-inactiveSelectionBackground'],
  selection: ['--vscode-list-activeSelectionBackground', '--vscode-editor-selectionBackground', '--vscode-toolbar-activeBackground'],
  selectionText: ['--vscode-list-activeSelectionForeground'], button: ['--vscode-button-background'], buttonHover: ['--vscode-button-hoverBackground'],
  buttonText: ['--vscode-button-foreground'], linkActive: ['--vscode-textLink-activeForeground'],
  buttonSecondary: ['--vscode-button-secondaryBackground'], buttonSecondaryHover: ['--vscode-button-secondaryHoverBackground'], buttonSecondaryText: ['--vscode-button-secondaryForeground'],
  danger: ['--vscode-errorForeground'], success: ['--vscode-testing-iconPassed', '--vscode-charts-green'], warning: ['--vscode-editorWarning-foreground', '--vscode-charts-yellow'],
  scrollbar: ['--vscode-scrollbarSlider-background'], scrollbarHover: ['--vscode-scrollbarSlider-hoverBackground', '--vscode-scrollbarSlider-activeBackground'],
};

/** 外壳、聊天和自定义主题共用同一张变量表：语义 token 为唯一引用入口，其余为兼容别名。 */
export function appearanceCssVariables(palette: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(palette).flatMap(([name, value]) => [
    ['--' + name.replace(/[A-Z]/g, match => '-' + match.toLowerCase()), value],
    ...(semanticTokens[name] ?? []).map(token => [token, value]),
    ...(appearanceTokens[name] ?? []).map(token => [token, value]),
  ]));
}

export function appearanceFontVariables(config: Pick<AppearanceSettings, 'uiFont' | 'textFont' | 'codeFont' | 'fontSize' | 'codeFontSize' | 'lineHeight'>): Record<string, string> {
  const ui = resolveUiFont(config.uiFont);
  const text = config.textFont === 'inherit' ? ui : config.textFont;
  return {
    '--gc-font-ui': ui, '--gc-font-text': text, '--gc-font-code': config.codeFont,
    '--gc-font-size-ui': `${config.fontSize}px`, '--gc-font-size-code': `${config.codeFontSize}px`,
    '--gc-font-size-body': `${config.fontSize}px`, '--gc-font-size-control': `${config.fontSize}px`,
    '--gc-line-height-normal': String(config.lineHeight),
    '--vscode-font-family': ui, '--vscode-editor-font-family': config.codeFont,
    '--vscode-font-size': `${config.fontSize}px`, '--vscode-editor-font-size': `${config.codeFontSize}px`,
    '--platform-text-font': config.textFont,
    '--ui-font': ui, '--text-font': config.textFont, '--code-font': config.codeFont,
    '--font-size': `${config.fontSize}px`, '--line-height': String(config.lineHeight),
  };
}

/** 写到文档根元素：tokens.css 的派生色在 :root 计算，基础值必须落在同一元素上。 */
export function applyAppearanceVariables(target: HTMLElement, config: AppearanceSettings, systemLight: boolean): void {
  const palette = resolveAppearancePalette(config.theme, config.colors, systemLight, config.darkPalette);
  for (const [token, value] of Object.entries(appearanceFontVariables(config))) target.style.setProperty(token, value);
  for (const [token, value] of Object.entries(appearanceCssVariables(palette)))
    if (CSS.supports('color', value)) target.style.setProperty(token, value);
  const theme = resolveAppearanceTheme(config.theme, systemLight);
  target.dataset.theme = theme;
  target.dataset.palette = resolvePaletteName(config.theme, systemLight, config.darkPalette);
  target.style.setProperty('color-scheme', theme);
}
