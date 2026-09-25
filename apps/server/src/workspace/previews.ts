import { randomUUID } from 'node:crypto';
import type { PlatformApplication } from '../application';
import type { ClientSession } from '../transport/router';

interface Preview { id: string; clientId: string; expiresAt: number; size: number; title: string; content?: string; language?: string; data?: string; mimeType?: string; groupId?: string }
/** base64 编码下 50 MiB 原始数据的字符长度上限（4 字符/3 字节）。 */
const MAX_ATTACHMENT_BASE64_LENGTH = Math.ceil(50 * 1024 * 1024 / 3) * 4;
/** 单次图片组注册的 base64 总长度上限；超出直接拒绝，避免静默裁剪导致组内索引错位。 */
const MAX_GALLERY_BASE64_LENGTH = 96 * 1024 * 1024;
/** 同时保留的预览组数（无组单项各自算一组）与全部预览的总长度上限。 */
const MAX_PREVIEW_GROUPS = 8;
const MAX_PREVIEW_TOTAL_LENGTH = 128 * 1024 * 1024;
const PREVIEW_TTL_MS = 600_000;

/** 临时预览不写入会话；事件只携带标识，大附件按请求读取，避免撑大重连事件缓存。 */
export class ContentPreviews {
  private readonly values = new Map<string, Preview>();
  constructor(private readonly app: PlatformApplication) {}
  show(client: ClientSession, data: Record<string, any>, attachment: boolean) {
    this.app.requireOwner(client.actorId);
    if (attachment && Array.isArray(data.gallery)) this.registerGallery(client, data);
    else if (attachment) this.registerSingle(client, data);
    else this.registerText(client, data);
    this.evict();
    return { success: true };
  }
  get(client: ClientSession, id: string) {
    this.app.requireOwner(client.actorId);
    const item = this.values.get(id);
    if (!item || item.clientId !== client.clientId || item.expiresAt < Date.now()) throw new Error('预览已经过期，请重新打开。');
    const { clientId: _client, expiresAt: _expires, size: _size, groupId, ...value } = item;
    if (!groupId) return value;
    // 组信息供查看器多图切换；组内图片数据仍按请求读取，不在列表中复制。
    const items: { id: string; title: string; mimeType?: string }[] = [];
    let index = 0;
    for (const entry of this.values.values()) {
      if (entry.groupId !== groupId || entry.clientId !== client.clientId || entry.expiresAt < Date.now()) continue;
      if (entry.id === id) index = items.length;
      items.push({ id: entry.id, title: entry.title, mimeType: entry.mimeType });
    }
    return { ...value, group: { index, items } };
  }
  close(client: ClientSession, id: string) { if (this.values.get(id)?.clientId === client.clientId) this.values.delete(id); return { success: true }; }

  /** 单个附件：文件名做标题，校验 base64 与 50 MiB 上限。 */
  private registerSingle(client: ClientSession, data: Record<string, any>) {
    if (typeof data.data !== 'string' || data.data.length > MAX_ATTACHMENT_BASE64_LENGTH) throw new Error('附件超过 50 MiB 或格式无效。');
    const bytes = Buffer.from(data.data, 'base64');
    if (!bytes.length || bytes.toString('base64') !== data.data) throw new Error('附件 Base64 格式无效。');
    const value: Preview = { id: randomUUID(), clientId: client.clientId, expiresAt: Date.now() + PREVIEW_TTL_MS,
      title: String(data.title ?? data.name ?? '预览').slice(0, 500), data: data.data,
      mimeType: typeof data.mimeType === 'string' ? data.mimeType : 'application/octet-stream', size: data.data.length };
    this.values.set(value.id, value);
    this.app.publish({ type: 'workspace.preview', clientId: client.clientId, previewId: value.id });
  }

  /** 图片组：同一条消息的多张图片一次注册，共享 groupId，事件只通知当前查看的那张。 */
  private registerGallery(client: ClientSession, data: Record<string, any>) {
    const gallery: unknown[] = data.gallery;
    const index = data.index;
    if (!gallery.length || !Number.isInteger(index) || index < 0 || index >= gallery.length) throw new Error('预览数据无效。');
    let total = 0;
    const items: { title: string; mimeType: string; data: string }[] = [];
    for (const entry of gallery) {
      const raw = (entry ?? {}) as Record<string, unknown>;
      if (typeof raw.data !== 'string' || !raw.data.length || raw.data.length > MAX_ATTACHMENT_BASE64_LENGTH) throw new Error('附件超过 50 MiB 或格式无效。');
      const bytes = Buffer.from(raw.data, 'base64');
      if (!bytes.length || bytes.toString('base64') !== raw.data) throw new Error('附件 Base64 格式无效。');
      total += raw.data.length;
      if (total > MAX_GALLERY_BASE64_LENGTH) throw new Error('预览内容过大，请单张打开。');
      items.push({ title: String(raw.name ?? '预览').slice(0, 500),
        mimeType: typeof raw.mimeType === 'string' ? raw.mimeType : 'application/octet-stream', data: raw.data });
    }
    const groupId = randomUUID();
    const expiresAt = Date.now() + PREVIEW_TTL_MS;
    const ids = items.map(item => {
      const value: Preview = { id: randomUUID(), clientId: client.clientId, expiresAt, size: item.data.length,
        title: item.title, data: item.data, mimeType: item.mimeType, groupId };
      this.values.set(value.id, value);
      return value.id;
    });
    this.app.publish({ type: 'workspace.preview', clientId: client.clientId, previewId: ids[index] });
  }

  private registerText(client: ClientSession, data: Record<string, any>) {
    if (typeof data.content !== 'string' || Buffer.byteLength(data.content) > 10 * 1024 * 1024) throw new Error('预览文本超过 10 MiB 或格式无效。');
    const value: Preview = { id: randomUUID(), clientId: client.clientId, expiresAt: Date.now() + PREVIEW_TTL_MS,
      title: String(data.title ?? data.name ?? '预览').slice(0, 500), content: data.content,
      language: typeof data.language === 'string' ? data.language : 'plaintext', size: Buffer.byteLength(data.content) };
    this.values.set(value.id, value);
    this.app.publish({ type: 'workspace.preview', clientId: client.clientId, previewId: value.id });
  }

  /**
   * 过期清理与容量淘汰：以组为单位保留（同组图片一起保留、一起淘汰），
   * 从最早注册的组开始整体删除，直到组数与总长度都回到上限内；至少保留最新一组。
   */
  private evict() {
    const now = Date.now();
    for (const [id, item] of this.values) if (item.expiresAt < now) this.values.delete(id);
    const groups = new Map<string, { size: number; ids: string[] }>();
    for (const [id, item] of this.values) {
      const key = item.groupId ?? `single:${id}`;
      const group = groups.get(key);
      if (group) { group.size += item.size; group.ids.push(id); }
      else groups.set(key, { size: item.size, ids: [id] });
    }
    let total = [...groups.values()].reduce((sum, group) => sum + group.size, 0);
    while (groups.size > 1 && (groups.size > MAX_PREVIEW_GROUPS || total > MAX_PREVIEW_TOTAL_LENGTH)) {
      const [key, group] = groups.entries().next().value!;
      for (const id of group.ids) this.values.delete(id);
      groups.delete(key); total -= group.size;
    }
  }
}
