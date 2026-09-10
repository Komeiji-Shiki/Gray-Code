import type { WindowsToastAdapter } from '../../../backend/modules/notifications/types';
import { app, Notification, type BrowserWindow } from 'electron';
import type { PlatformApplication } from '../../server/src/application';
import { WindowsAgentStopNotificationService } from '../../../backend/modules/notifications/AgentStopNotificationRuntime';

export function desktopNotifications(application: PlatformApplication, getWindow: () => BrowserWindow | undefined, open: () => Promise<void>) {
  const adapter: WindowsToastAdapter = { show: async request => {
      if (!Notification.isSupported()) return { shown: false, skippedReason: 'unsupported_platform' };
      return new Promise(resolve => {
        const notification = new Notification({ title: request.title, body: request.message, silent: request.silent });
        const timeout = setTimeout(() => resolve({ shown: false, skippedReason: 'notification_not_shown' }), 5000);
        notification.once('show', () => { clearTimeout(timeout); resolve({ shown: true }); });
        notification.once('failed', (_event, error) => { clearTimeout(timeout); request.onError?.(error); resolve({ shown: false, error }); });
        notification.once('click', () => { void request.onClick?.(); });
        notification.show();
      });
    } };
  application.notifications.connect({ adapter, open });
  return new WindowsAgentStopNotificationService({ settingsManager: { getSettings: () => application.product.runtimeSettings().getSettings() },
    getWindowTitle: () => getWindow()?.getTitle() || 'GrayCode',
    getWindowState: () => ({ focused: !!getWindow()?.isFocused() }),
    onDidChangeWindowState: listener => {
      const changed = () => listener({ focused: !!getWindow()?.isFocused() });
      app.on('browser-window-focus', changed); app.on('browser-window-blur', changed);
      return { dispose: () => { app.removeListener('browser-window-focus', changed); app.removeListener('browser-window-blur', changed); } };
    },
    executeCommand: async () => open(), focusWindow: async () => { const window = getWindow(); if (window?.isMinimized()) window.restore(); window?.show(); window?.focus(); },
    adapter,

  });
}
