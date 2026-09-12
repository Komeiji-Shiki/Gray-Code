import type { AppearanceSettings } from '../../../packages/contracts/src/settings';
import { resourceUrl } from './resources';
import { resolveAppearancePalette, resolveAppearanceTheme } from '../../../shared/appearance';
let customStyle: HTMLStyleElement | undefined;
let currentAppearance: AppearanceSettings | undefined;
let systemScheme: MediaQueryList | undefined;
export function applyDesktopAppearance(config: AppearanceSettings): void {
  currentAppearance = config;
  if (!systemScheme) {
    systemScheme = matchMedia('(prefers-color-scheme: light)');
    systemScheme.addEventListener('change', () => {
      if (currentAppearance?.theme === 'system') applyDesktopAppearance(currentAppearance);
    });
  }
  const style = document.documentElement.style;
  style.setProperty('--vscode-font-family', config.uiFont);
  style.setProperty('--vscode-editor-font-family', config.codeFont);
  style.setProperty('--vscode-font-size', `${config.fontSize}px`);
  style.setProperty('--vscode-editor-font-size', `${config.codeFontSize}px`);
  style.setProperty('--gc-font-size-body', `${config.fontSize}px`);
  style.setProperty('--gc-font-size-control', `${config.fontSize}px`);
  style.setProperty('--gc-line-height-normal', String(config.lineHeight));
  style.setProperty('--platform-text-font', config.textFont);
  const image = config.backgroundImage;
  const allowedImage = !image || /^(https?:\/\/|graycode:\/\/app\/assets\/background\/|data:image\/(?:png|jpeg|webp);base64,)/i.test(image);
  style.setProperty('--platform-background-image', image && allowedImage ? `url(${JSON.stringify(resourceUrl(image))})` : 'none');
  style.setProperty('--platform-background-opacity', String(Math.max(0, Math.min(1, config.backgroundOpacity))));
  document.documentElement.dataset.density = config.density;
  const theme = resolveAppearanceTheme(config.theme, systemScheme.matches);
  document.documentElement.dataset.theme = theme;
  document.body.classList.toggle('vscode-light', theme === 'light');
  document.body.classList.toggle('vscode-dark', theme === 'dark');
  const tokens: Record<string,string[]> = {
    background:['--vscode-editor-background','--vscode-sideBar-background'], panel:['--vscode-editorWidget-background'], input:['--vscode-input-background'],
    text:['--vscode-foreground','--vscode-input-foreground'], muted:['--vscode-descriptionForeground'], disabled:['--vscode-disabledForeground'],
    accent:['--vscode-textLink-foreground','--vscode-focusBorder','--gc-accent','--vscode-charts-blue'],
    border:['--vscode-panel-border','--vscode-input-border','--vscode-widget-border','--vscode-editorWidget-border'],
    hover:['--vscode-list-hoverBackground','--vscode-toolbar-hoverBackground','--vscode-editor-inactiveSelectionBackground'],
    selection:['--vscode-list-activeSelectionBackground','--vscode-editor-selectionBackground','--vscode-toolbar-activeBackground'],
    selectionText:['--vscode-list-activeSelectionForeground'], button:['--vscode-button-background'], buttonHover:['--vscode-button-hoverBackground'],
    buttonText:['--vscode-button-foreground'], linkActive:['--vscode-textLink-activeForeground'],
    danger:['--vscode-errorForeground'], success:['--vscode-testing-iconPassed','--vscode-charts-green'], warning:['--vscode-editorWarning-foreground','--vscode-charts-yellow'],
    scrollbar:['--vscode-scrollbarSlider-background'], scrollbarHover:['--vscode-scrollbarSlider-hoverBackground','--vscode-scrollbarSlider-activeBackground'],
  };
  for (const [key, value] of Object.entries(resolveAppearancePalette(config.theme, config.colors, systemScheme.matches)))
    if (CSS.supports('color', value)) for (const token of tokens[key] ?? []) style.setProperty(token, value);
  style.setProperty('color-scheme', theme);
  if (!customStyle) { customStyle = document.createElement('style'); customStyle.dataset.graycode = 'custom'; document.head.appendChild(customStyle); }
  customStyle.textContent = config.customCss;
}
