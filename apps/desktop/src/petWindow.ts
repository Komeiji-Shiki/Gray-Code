import { BrowserWindow, screen } from 'electron';
import type { PlatformApplication } from '../../server/src/application';
import type { ClientSession } from '../../server/src/transport/router';

export class DesktopPetWindow {
  private window?: BrowserWindow;
  private sequence = 0;
  private disposed = false;
  private expanded = false;
  private followPointer = false;
  private positionTimer?: NodeJS.Timeout;
  private pointerTimer?: NodeJS.Timeout;

  constructor(
    private readonly app: PlatformApplication,
    private readonly client: ClientSession,
    private readonly preload: string,
    private readonly trust: (window: BrowserWindow) => void,
  ) {
    app.pets.attachHost({
      floatingAvailable: true,
      changed: () => {
        void this.synchronize().catch(error => app.publish({
          type: 'notification', severity: 'warning', message: '桌宠悬浮窗口：' + String(error),
        }));
      },
    });
  }

  async expand(expanded: boolean) {
    this.expanded = expanded;
    await this.synchronize();
    return { success: true };
  }

  private trackPointer() {
    clearInterval(this.pointerTimer);
    this.pointerTimer = setInterval(() => {
      if (!this.followPointer || !this.window || this.window.isDestroyed() || this.disposed) return;
      const cursor = screen.getCursorScreenPoint();
      const bounds = this.window.getContentBounds();
      // 只把光标相对于本窗口的位置送给自己的播放器，桌面截图与服务器模型请求均不参与。
      this.window.webContents.send('graycode:event', {
        type: 'pets.pointer', x: cursor.x - bounds.x, y: cursor.y - bounds.y,
      });
    }, 100);
    this.pointerTimer.unref();
  }

  private async synchronize() {
    const sequence = ++this.sequence;
    if (this.disposed) return;
    const { configuration } = await this.app.pets.snapshot();
    if (sequence !== this.sequence || this.disposed) return;
    this.followPointer = configuration.followPointer === true && !configuration.stopped;
    if (!configuration.visible || configuration.surface !== 'floating' || !configuration.resourceId) {
      clearInterval(this.pointerTimer);
      this.window?.destroy();
      this.window = undefined;
      return;
    }
    if (!this.window || this.window.isDestroyed()) {
      const window = new BrowserWindow({
        width: 280, height: 320, frame: false, transparent: true, hasShadow: false,
        alwaysOnTop: true, skipTaskbar: true, resizable: false, show: false,
        webPreferences: {
          preload: this.preload, nodeIntegration: false, contextIsolation: true,
          sandbox: true, backgroundThrottling: true,
        },
      });
      this.window = window;
      this.trust(window);
      window.setTitle('GrayCode 桌宠');
      window.on('moved', () => {
        clearTimeout(this.positionTimer);
        this.positionTimer = setTimeout(() => {
          if (window.isDestroyed() || this.disposed) return;
          const [x, y] = window.getPosition();
          void this.app.pets.call(this.client, 'pets.position', { position: { x, y } }).catch(() => {});
        }, 200);
        this.positionTimer.unref();
      });
      window.on('closed', () => {
        if (this.window === window) {
          this.window = undefined;
          clearInterval(this.pointerTimer);
        }
      });
      try {
        await window.loadURL('graycode://app/pet.html');
      } catch (error) {
        // 主动关闭或被新窗口替代时，迟到的加载失败不再通知；真正失败则释放窗口供下次重试。
        if (this.disposed || window.isDestroyed() || this.window !== window) return;
        window.destroy();
        throw error;
      }
      if (window.isDestroyed() || this.disposed || this.window !== window) return;
      window.showInactive();
      this.trackPointer();
    }
    if (sequence !== this.sequence || !this.window || this.window.isDestroyed()) return;
    const position = configuration.position;
    const area = (position ?
      screen.getDisplayNearestPoint({ x: Math.round(position.x), y: Math.round(position.y) }) : screen.getPrimaryDisplay()).workArea;
    const width = Math.min(area.width, this.expanded ? 440 : Math.max(280, Math.round(240 * configuration.scale)));
    const height = Math.min(area.height, this.expanded ? 650 : Math.round(260 * configuration.scale + 40));
    const x = Math.max(area.x, Math.min(area.x + area.width - width, position?.x ?? area.x + area.width - width - 30));
    const y = Math.max(area.y, Math.min(area.y + area.height - height, position?.y ?? area.y + area.height - height - 30));
    const current = this.window.getBounds();
    if (current.x !== Math.round(x) || current.y !== Math.round(y) || current.width !== width || current.height !== height) {
      this.window.setBounds({ x: Math.round(x), y: Math.round(y), width, height });
    }
  }

  dispose() {
    this.disposed = true;
    this.sequence++;
    clearTimeout(this.positionTimer);
    clearInterval(this.pointerTimer);
    this.window?.destroy();
    this.window = undefined;
  }
}
