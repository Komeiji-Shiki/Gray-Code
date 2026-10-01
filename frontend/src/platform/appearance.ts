import type { AppearanceSettings } from '../../../packages/contracts/src/settings';
import { applyAppearanceVariables } from '../../../shared/appearanceTokens';
import { resourceUrl } from './resources';
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
  const root = document.documentElement;
  applyAppearanceVariables(root, config, systemScheme.matches);
  const image = config.backgroundImage;
  const allowedImage = !image || /^(https?:\/\/|graycode:\/\/app\/assets\/background\/|data:image\/(?:png|jpeg|webp);base64,)/i.test(image);
  root.style.setProperty('--platform-background-image', image && allowedImage ? `url(${JSON.stringify(resourceUrl(image))})` : 'none');
  root.style.setProperty('--platform-background-opacity', String(Math.max(0, Math.min(1, config.backgroundOpacity))));
  root.dataset.density = config.density;
  document.body.classList.toggle('vscode-light', root.dataset.theme === 'light');
  document.body.classList.toggle('vscode-dark', root.dataset.theme === 'dark');
  if (!customStyle) { customStyle = document.createElement('style'); customStyle.dataset.graycode = 'custom'; document.head.appendChild(customStyle); }
  customStyle.textContent = config.customCss;
}
