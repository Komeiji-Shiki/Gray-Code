import { randomUUID } from 'node:crypto';

/** 文件和设置分别回执；任何失败或失联都禁止进入退出清理。 */
export class DesktopSaveAll {
  private pending?: { id: string; sender: number; remaining: Set<string>; failures: string[]; finish(error?: Error): void };
  request(sender: number, send: (id: string) => void): Promise<void> {
    if (this.pending) return Promise.reject(new Error('正在保存，请稍候。'));
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const finish = (error?: Error) => {
        if (this.pending?.id !== id) return;
        clearTimeout(timer); this.pending = undefined;
        if (error) reject(error); else resolve();
      };
      const timer = setTimeout(() => finish(new Error('保存确认超时，应用保持打开。请检查文件和设置后重试。')), 30_000);
      this.pending = { id, sender, remaining: new Set(['documents', 'settings']), failures: [], finish };
      try { send(id); } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    });
  }
  complete(sender: number, input: { requestId?: string; participant?: string; error?: string }): void {
    const pending = this.pending;
    if (!pending || pending.id !== input.requestId || pending.sender !== sender || !pending.remaining.delete(input.participant ?? '')) return;
    if (input.error) pending.failures.push(input.error);
    if (!pending.remaining.size) pending.finish(pending.failures.length ? new Error(pending.failures.join('\n')) : undefined);
  }
}
