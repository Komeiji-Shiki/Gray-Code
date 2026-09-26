import type { BrowserWindow } from 'electron';

/** Explicit user activation: restore/show, raise normal z-order, then request keyboard focus. */
export function activateDesktopWindow(window: Pick<BrowserWindow, 'isMinimized' | 'restore' | 'show' | 'moveTop' | 'focus'>): void {
  if (window.isMinimized()) window.restore();
  window.show();
  // Electron maps moveTop to HWND_TOP on Windows, not HWND_TOPMOST / always-on-top.
  window.moveTop();
  window.focus();
}
