import { BrowserWindow, screen } from 'electron';
import type { PlatformApplication } from '../../server/src/application';
import type { ClientSession } from '../../server/src/transport/router';

export class DesktopPetWindow {
  private window?: BrowserWindow;
  private sequence = 0; private disposed = false; private expanded = false;
  private positionTimer?: NodeJS.Timeout;
  constructor(private readonly app: PlatformApplication, private readonly client: ClientSession, private readonly preload: string, private readonly trust: (window: BrowserWindow) => void) {
    app.pets.attachHost({ floatingAvailable: true, changed: () => { void this.synchronize().catch(error => app.publish({ type: 'notification', severity: 'warning', message: `桌宠悬浮窗口：${String(error)}` })); } });
  }
  async expand(expanded: boolean) { this.expanded = expanded; await this.synchronize(); return { success: true }; }
  private async synchronize() {
    const sequence = ++this.sequence; if (this.disposed) return;
    const { configuration } = await this.app.pets.snapshot(); if (sequence !== this.sequence || this.disposed) return;
    if (!configuration.visible || configuration.surface !== 'floating' || !configuration.resourceId) { this.window?.destroy(); this.window = undefined; return; }
    if (!this.window || this.window.isDestroyed()) {
      const window = new BrowserWindow({ width: 280, height: 320, frame: false, transparent: true, hasShadow: false, alwaysOnTop: true, skipTaskbar: true, resizable: false, show: false,
        webPreferences: { preload: this.preload, nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: true } });
      this.window = window; this.trust(window); window.setTitle('GrayCode 桌宠');
      window.on('moved', () => {
        clearTimeout(this.positionTimer);
        this.positionTimer = setTimeout(() => { if (!window.isDestroyed() && !this.disposed) {
          const [x, y] = window.getPosition(); void this.app.pets.call(this.client, 'pets.position', { position: { x, y } }).catch(() => {});
        } }, 200); this.positionTimer.unref();
      });
      window.on('closed', () => { if (this.window === window) this.window = undefined; });
      await window.loadURL('graycode://app/pet.html'); if (window.isDestroyed() || this.disposed) return;
      window.showInactive();
    }
    if (sequence !== this.sequence || !this.window || this.window.isDestroyed()) return;
    const position = configuration.position;
    const area = (position ? screen.getDisplayNearestPoint({ x: Math.round(position.x), y: Math.round(position.y) }) : screen.getPrimaryDisplay()).workArea;
    const width = Math.min(area.width, this.expanded ? 440 : Math.max(280, Math.round(240 * configuration.scale)));
    const height = Math.min(area.height, this.expanded ? 650 : Math.round(260 * configuration.scale + 40));
    const x = Math.max(area.x, Math.min(area.x + area.width - width, position?.x ?? area.x + area.width - width - 30));
    const y = Math.max(area.y, Math.min(area.y + area.height - height, position?.y ?? area.y + area.height - height - 30));
    const current = this.window.getBounds();
    if (current.x !== Math.round(x) || current.y !== Math.round(y) || current.width !== width || current.height !== height) this.window.setBounds({ x: Math.round(x), y: Math.round(y), width, height });
  }
  dispose() { this.disposed = true; this.sequence++; clearTimeout(this.positionTimer); this.window?.destroy(); this.window = undefined; }
}
