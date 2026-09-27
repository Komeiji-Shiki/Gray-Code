import { randomUUID } from 'node:crypto';
import type { PlatformStorage } from '@graycode/core';
import type { RecordMutation } from '@graycode/contracts';

export interface BackgroundImage { id: string; name: string; mimeType: string; thumbnail: string; width: number; height: number; bytes: Uint8Array }
export type BackgroundImageSummary = Omit<BackgroundImage, 'bytes'> & { url: string };
export interface PendingBackgroundImages { images: BackgroundImage[]; removeIds: string[] }
/** 图片正文单独存储，普通设置只保存资源地址。 */
export class AppearanceImages {
  constructor(private readonly storage: PlatformStorage, private readonly changed?: () => Promise<void>) {}
  async list(pending?: PendingBackgroundImages) {
    const result: BackgroundImageSummary[] = [];
    for (const id of await this.storage.listRecords('appearance-image-info')) {
      if (pending?.removeIds.includes(id) || pending?.images.some(image => image.id === id)) continue;
      const metadata = await this.storage.getRecord('appearance-image-info', id) as Omit<BackgroundImage, 'bytes'>;
      result.push({ ...metadata, url: `graycode://app/assets/background/${id}` });
    }
    for (const image of pending?.images ?? []) {
      const { bytes, ...metadata } = image;
      result.push({ ...metadata, url: this.previewUrl(image) });
    }
    return result;
  }
  prepare(input: { name: string; dataUrl: string; thumbnail: string; width: number; height: number }, restoredId?: string): BackgroundImage {
    if (restoredId !== undefined && !/^[0-9a-f-]{36}$/i.test(restoredId)) throw new Error('背景图片标识无效。');
    const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(input.dataUrl);
    if (!match) throw new Error('请选择 JPG、PNG 或 WebP 图片。');
    const bytes = Buffer.from(match[2], 'base64');
    if (bytes.length > 10 * 1024 * 1024) throw new Error('图片不能超过 10 MB。');
    return { id: restoredId ?? randomUUID(), name: String(input.name).slice(0, 160), mimeType: match[1], bytes,
      thumbnail: /^data:image\/(png|jpeg|webp);base64,/.test(input.thumbnail) && input.thumbnail.length < 500_000 ? input.thumbnail : '',
      width: input.width, height: input.height };
  }
  previewUrl(image: BackgroundImage) {
    // 只读取当前视图的字节，避免复制整张图片，也不能把底层缓冲区中视图外的内容带入预览。
    const bytes = Buffer.from(image.bytes.buffer, image.bytes.byteOffset, image.bytes.byteLength);
    // fragment 保留草稿图片身份；两张内容相同但名称不同的图片不能在保存时互相替换。
    return `data:${image.mimeType};base64,${bytes.toString('base64')}#${image.id}`;
  }
  savedUrl(url: string, pending?: PendingBackgroundImages) {
    if (!pending || !url.startsWith('data:')) return url;
    const id = url.slice(url.lastIndexOf('#') + 1);
    // 先定位身份再验证正文，保存普通网址或检查其他草稿时不用遍历编码整个图库。
    const image = pending.images.find(image => image.id === id);
    return image && this.previewUrl(image) === url ? `graycode://app/assets/background/${image.id}` : url;
  }
  records(pending?: PendingBackgroundImages): RecordMutation[] {
    const records: RecordMutation[] = [];
    for (const image of pending?.images ?? []) {
      const { bytes, ...metadata } = image;
      records.push({ namespace: 'appearance-images', id: image.id, value: image },
        { namespace: 'appearance-image-info', id: image.id, value: metadata });
    }
    for (const id of pending?.removeIds ?? []) if (!pending?.images.some(image => image.id === id))
      records.push({ namespace: 'appearance-images', id, delete: true }, { namespace: 'appearance-image-info', id, delete: true });
    return records;
  }
  async add(input: { name: string; dataUrl: string; thumbnail: string; width: number; height: number }, restoredId?: string) {
    const image = this.prepare(input, restoredId);
    await this.storage.commitRecords(this.records({ images: [image], removeIds: [] }));
    await this.changed?.();
    return { id: image.id, url: `graycode://app/assets/background/${image.id}` };
  }
  async get(id: string, pending?: PendingBackgroundImages): Promise<BackgroundImage | null> {
    const staged = pending?.images.find(image => image.id === id);
    if (staged) return structuredClone(staged);
    if (pending?.removeIds.includes(id)) return null;
    return this.storage.getRecord('appearance-images', id) as Promise<BackgroundImage | null>;
  }
  async remove(id: string) {
    await this.storage.commitRecords([{ namespace: 'appearance-images', id, delete: true }, { namespace: 'appearance-image-info', id, delete: true }]);
    await this.changed?.();
  }
  async rename(id: string, name: string) {
    const image = await this.get(id); if (!image) throw new Error('背景图片不存在。');
    const value = { ...image, name: name.trim().slice(0, 160) || image.name }; const { bytes, ...metadata } = value;
    await this.storage.commitRecords([{ namespace: 'appearance-images', id, value }, { namespace: 'appearance-image-info', id, value: metadata }]);
    await this.changed?.();
  }
}
