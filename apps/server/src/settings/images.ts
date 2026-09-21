import { randomUUID } from 'node:crypto';
import type { PlatformStorage } from '@graycode/core';

export interface BackgroundImage { id: string; name: string; mimeType: string; thumbnail: string; width: number; height: number; bytes: Uint8Array }
export type BackgroundImageSummary = Omit<BackgroundImage, 'bytes'> & { url: string };
/** 图片正文单独存储，普通设置只保存资源地址。 */
export class AppearanceImages {
  constructor(private readonly storage: PlatformStorage, private readonly changed?: () => Promise<void>) {}
  async list() {
    const result: BackgroundImageSummary[] = [];
    for (const id of await this.storage.listRecords('appearance-image-info')) {
      const metadata = await this.storage.getRecord('appearance-image-info', id) as Omit<BackgroundImage, 'bytes'>;
      result.push({ ...metadata, url: `graycode://app/assets/background/${id}` });
    }
    return result;
  }
  async add(input: { name: string; dataUrl: string; thumbnail: string; width: number; height: number }, restoredId?: string) {
    if (restoredId !== undefined && !/^[0-9a-f-]{36}$/i.test(restoredId)) throw new Error('背景图片标识无效。');
    const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(input.dataUrl);
    if (!match) throw new Error('请选择 JPG、PNG 或 WebP 图片。');
    const bytes = Buffer.from(match[2], 'base64');
    if (bytes.length > 10 * 1024 * 1024) throw new Error('图片不能超过 10 MB。');
    const image: BackgroundImage = { id: restoredId ?? randomUUID(), name: String(input.name).slice(0, 160), mimeType: match[1], bytes,
      thumbnail: /^data:image\/(png|jpeg|webp);base64,/.test(input.thumbnail) && input.thumbnail.length < 500_000 ? input.thumbnail : '',
      width: input.width, height: input.height };
    const { bytes: _bytes, ...metadata } = image;
    await this.storage.commitRecords([{ namespace: 'appearance-images', id: image.id, value: image },
      { namespace: 'appearance-image-info', id: image.id, value: metadata }]);
    await this.changed?.();
    return { id: image.id, url: `graycode://app/assets/background/${image.id}` };
  }
  get(id: string) { return this.storage.getRecord('appearance-images', id) as Promise<BackgroundImage | null>; }
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
