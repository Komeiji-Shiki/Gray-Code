import type { PlatformStorage } from '@graycode/core';
import { AppearanceImages, type BackgroundImage } from '../../../apps/server/src/settings/images';

const service = new AppearanceImages({} as PlatformStorage);
const image = (id: string, bytes: Uint8Array): BackgroundImage => ({ id, name: id, bytes, mimeType: 'image/png', thumbnail: '', width: 1, height: 1 });

test('预览仅编码 Uint8Array 视图内的字节，不包含缓冲区两侧内容', () => {
  const buffer = Buffer.from('hidden-left|picture|hidden-right');
  const value = image('photo', buffer.subarray(12, 19));
  expect(service.previewUrl(value)).toBe(`data:image/png;base64,${Buffer.from('picture').toString('base64')}#photo`);
});

test('普通地址及其他草稿图片不触发无关图片正文读取', () => {
  const unrelated = image('unrelated', new Uint8Array());
  Object.defineProperty(unrelated, 'bytes', { get: () => { throw new Error('不应读取未选中图片'); } });
  const selected = image('selected', Buffer.from('selected'));
  const pending = { images: [unrelated, selected], removeIds: [] };
  expect(service.savedUrl('https://example.test/background.png', pending)).toBe('https://example.test/background.png');
  expect(service.savedUrl('graycode://app/assets/background/saved', pending)).toBe('graycode://app/assets/background/saved');
  expect(service.savedUrl('data:image/png;base64,cGljdHVyZQ==#unknown', pending)).toBe('data:image/png;base64,cGljdHVyZQ==#unknown');
  expect(service.savedUrl(service.previewUrl(selected), pending)).toBe('graycode://app/assets/background/selected');
});

test('命中图片身份后仍校验正文，不把另一个 data URL 错绑到已导入图片', () => {
  const selected = image('selected', Buffer.from('original'));
  const forged = 'data:image/png;base64,ZGlmZmVyZW50#selected';
  expect(service.savedUrl(forged, { images: [selected], removeIds: [] })).toBe(forged);
  selected.bytes = Buffer.from('updated');
  expect(service.savedUrl(service.previewUrl(selected), { images: [selected], removeIds: [] })).toBe('graycode://app/assets/background/selected');
});
