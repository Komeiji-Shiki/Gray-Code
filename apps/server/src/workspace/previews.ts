import { randomUUID } from 'node:crypto';
import type { PlatformApplication } from '../application';
import type { ClientSession } from '../transport/router';

interface Preview { id: string; clientId: string; expiresAt: number; size: number; title: string; content?: string; language?: string; data?: string; mimeType?: string }
/** 临时预览不写入会话；事件只携带标识，大附件按请求读取，避免撑大重连事件缓存。 */
export class ContentPreviews {
  private readonly values = new Map<string, Preview>();
  constructor(private readonly app: PlatformApplication) {}
  show(client: ClientSession, data: Record<string, any>, attachment: boolean) {
    this.app.requireOwner(client.actorId);
    const title = String(data.title ?? data.name ?? '预览').slice(0, 500);
    let value: Preview;
    if (attachment) {
      if (typeof data.data !== 'string' || data.data.length > Math.ceil(50 * 1024 * 1024 / 3) * 4) throw new Error('附件超过 50 MiB 或格式无效。');
      const bytes = Buffer.from(data.data, 'base64');
      if (!bytes.length || bytes.toString('base64') !== data.data) throw new Error('附件 Base64 格式无效。');
      value = { id: randomUUID(), clientId: client.clientId, expiresAt: Date.now() + 600_000, title, data: data.data,
        mimeType: typeof data.mimeType === 'string' ? data.mimeType : 'application/octet-stream', size: data.data.length };
    } else {
      if (typeof data.content !== 'string' || Buffer.byteLength(data.content) > 10 * 1024 * 1024) throw new Error('预览文本超过 10 MiB 或格式无效。');
      value = { id: randomUUID(), clientId: client.clientId, expiresAt: Date.now() + 600_000, title, content: data.content,
        language: typeof data.language === 'string' ? data.language : 'plaintext', size: Buffer.byteLength(data.content) };
    }
    for (const [id, item] of this.values) if (item.expiresAt < Date.now()) this.values.delete(id);
    let total = [...this.values.values()].reduce((sum, item) => sum + item.size, value.size);
    while (this.values.size && (this.values.size >= 8 || total > 128 * 1024 * 1024)) {
      const item = this.values.values().next().value!; total -= item.size; this.values.delete(item.id);
    }
    this.values.set(value.id, value);
    this.app.publish({ type: 'workspace.preview', clientId: client.clientId, previewId: value.id });
    return { success: true };
  }
  get(client: ClientSession, id: string) {
    this.app.requireOwner(client.actorId);
    const item = this.values.get(id);
    if (!item || item.clientId !== client.clientId || item.expiresAt < Date.now()) throw new Error('预览已经过期，请重新打开。');
    const { clientId: _client, expiresAt: _expires, size: _size, ...value } = item;
    return value;
  }
  close(client: ClientSession, id: string) { if (this.values.get(id)?.clientId === client.clientId) this.values.delete(id); return { success: true }; }
}
