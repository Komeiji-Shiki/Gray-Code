import type { AppearanceSettings } from '../../../packages/contracts/src/settings';
import { resourceUrl } from './resources';
let customStyle: HTMLStyleElement | undefined;
export function applyDesktopAppearance(config: AppearanceSettings): void {
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
  const light = config.theme === 'light' || (config.theme === 'system' && matchMedia('(prefers-color-scheme: light)').matches);
  const defaults = light ? { background:'#f5f6f8', panel:'#fff', text:'#242832', accent:'#2464bd', border:'#d5dbe5' }
    : { background:'#17191e', panel:'#22252c', text:'#dedee3', accent:'#6ba6ff', border:'#323742' };
  const tokens: Record<string,string[]> = { background:['--vscode-editor-background','--vscode-sideBar-background'], panel:['--vscode-editorWidget-background','--vscode-input-background'],
    text:['--vscode-foreground','--vscode-input-foreground'], accent:['--vscode-textLink-foreground','--vscode-focusBorder','--gc-accent'], border:['--vscode-panel-border','--vscode-input-border'] };
  for (const [key, value] of Object.entries({ ...defaults, ...config.colors }))
    if (CSS.supports('color', value)) for (const token of tokens[key] ?? []) style.setProperty(token, value);
  style.setProperty('color-scheme', light ? 'light' : 'dark');
  if (!customStyle) { customStyle = document.createElement('style'); customStyle.dataset.graycode = 'custom'; document.head.appendChild(customStyle); }
  customStyle.textContent = config.customCss;
}
