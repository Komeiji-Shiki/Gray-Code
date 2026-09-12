import { nativeTheme, type BrowserWindow } from 'electron';
import type { PlatformApplication } from '../../server/src/application';
import type { AppearanceSettings } from '../../../packages/contracts/src/settings';
import { resolveAppearancePalette } from '../../../shared/appearance';

/** 原生标题栏和菜单跟随应用选择，系统主题变化只触发重新绘制。 */
export function bindDesktopAppearance(window: BrowserWindow, application: PlatformApplication): void {
  let current = application.settings.snapshot().settings.appearance;
  const paint = () => {
    if (window.isDestroyed()) return;
    const defaults = resolveAppearancePalette(current.theme, {}, !nativeTheme.shouldUseDarkColors);
    const colors = { ...defaults, ...current.colors };
    try {
      if (process.platform === 'win32' || process.platform === 'linux') window.setTitleBarOverlay({ color: colors.background, symbolColor: colors.text, height: 38 });
      window.setBackgroundColor(colors.background);
    } catch {
      // 手动输入的颜色尚不完整时，保持原生窗口可用。
      if (process.platform === 'win32' || process.platform === 'linux') window.setTitleBarOverlay({ color: defaults.background, symbolColor: defaults.text, height: 38 });
      window.setBackgroundColor(defaults.background);
    }
  };
  const apply = (config: AppearanceSettings) => { current = config; nativeTheme.themeSource = config.theme; paint(); };
  apply(current);
  nativeTheme.on('updated', paint);
  const unsubscribe = application.subscribe(event => {
    if (event.type === 'settings.changed') apply(application.settings.snapshot().settings.appearance);
    if (event.type === 'ui.message' && (event.message as any)?.command === 'platform.appearance') apply((event.message as any).data);
  });
  window.on('closed', () => { unsubscribe(); nativeTheme.removeListener('updated', paint); });
}
