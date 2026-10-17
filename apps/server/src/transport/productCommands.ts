import { randomUUID } from 'node:crypto';
import type { ClientSession } from './router';

interface Command { type: 'command'; command: string; data?: unknown }
interface CommandView {
  viewId?: string;
  ready: boolean;
  connected: boolean;
  announced: boolean;
  pending: Command[];
}

/** 主聊天握手与事件连接分别就绪；设置通知和流式事件仍使用原投递路径。 */
export class ProductCommands {
  private readonly views = new Map<string, CommandView>();
  constructor(private readonly publish: (event: Record<string, unknown>) => void) {}
  private view(clientId: string): CommandView {
    let view = this.views.get(clientId);
    if (!view) {
      view = { ready: false, connected: false, announced: false, pending: [] };
      this.views.set(clientId, view);
    }
    return view;
  }
  prepare(client: ClientSession, resumeViewId?: string): { accepted: boolean; viewId: string } {
    const view = this.view(client.clientId);
    if (resumeViewId && view.viewId && view.viewId !== resumeViewId) return { accepted: false, viewId: view.viewId };
    const viewId = resumeViewId || randomUUID();
    if (view.viewId !== viewId) {
      view.viewId = viewId;
      view.ready = false;
      view.announced = false;
    }
    if (client.uiStateKey === 'desktop') view.connected = true;
    return { accepted: true, viewId };
  }
  ready(clientId: string, viewId: string): { success: boolean; reason?: 'missing' | 'replaced' } {
    const view = this.view(clientId);
    if (!view.viewId) return { success: false, reason: 'missing' };
    if (view.viewId !== viewId) return { success: false, reason: 'replaced' };
    view.ready = true;
    this.flush(clientId, view);
    return { success: true };
  }
  send(clientId: string, command: Command): void {
    const view = this.view(clientId);
    view.pending.push(command);
    this.flush(clientId, view);
  }
  connected(clientId: string): void {
    const view = this.view(clientId);
    view.connected = true;
    this.flush(clientId, view);
  }
  disconnected(clientId: string): void {
    const view = this.views.get(clientId);
    if (!view) return;
    view.connected = false;
    view.ready = false;
    view.announced = false;
  }
  invalidate(clientId: string): void {
    this.disconnected(clientId);
    const view = this.views.get(clientId);
    if (view) view.viewId = undefined;
  }
  private flush(clientId: string, view: CommandView): void {
    if (!view.viewId || !view.ready || !view.connected) return;
    for (const message of view.pending.splice(0)) this.publish({ type: 'ui.message', clientId, viewId: view.viewId, message });
    if (!view.announced) {
      view.announced = true;
      this.publish({ type: 'ui.ready', clientId, viewId: view.viewId });
    }
  }
}
