import sharp from 'sharp';
import { withDependencyRuntime } from '../../../modules/dependencies/runtime';
import { createCropImageRuntime } from '../../../tools/media/crop_imageRuntime';
import { createResizeImageRuntime } from '../../../tools/media/resize_imageRuntime';
import { createRotateImageRuntime } from '../../../tools/media/rotate_imageRuntime';
import type { MediaToolHost } from '../../../tools/media/host';
import type { ToolContext } from '../../../tools/types';

let source: Buffer;
beforeAll(async () => {
  // 高对比细节经过重复 JPEG 编码会改变，用真实编码器验证处理结果。
  const pixels = Buffer.alloc(96 * 72 * 3);
  for (let y = 0; y < 72; y++) for (let x = 0; x < 96; x++) {
    const index = (y * 96 + x) * 3;
    pixels[index] = (x * 19 + y * 7) % 256; pixels[index + 1] = (x * 3 + y * 23) % 256; pixels[index + 2] = (x * 29 + y * 11) % 256;
  }
  source = await sharp(pixels, { raw: { width: 96, height: 72, channels: 3 } }).jpeg({ quality: 98, chromaSubsampling: '4:4:4' }).toBuffer();
});
const cases = (['crop', 'resize', 'rotate'] as const).flatMap(operation => (['png', 'jpg', 'webp'] as const).map(format => ({ operation, format })));
test.each(cases)('$operation JPEG 原图直接生成 $format，尺寸、内容和工具附件一致', async ({ operation, format }) => {
  let saved: Buffer | undefined;
  const host: MediaToolHost = {
    getAllWorkspaces: () => [], readImageFile: async () => ({ data: source, mimeType: 'image/jpeg', ext: '.jpg' }),
    saveImage: async buffer => { saved = buffer; },
    tasks: { getTasksByType: () => [], generateTaskId: () => `image-${operation}-${format}`, cancelTask: () => ({ success: false }),
      registerTask: jest.fn(), unregisterTask: jest.fn(), onTaskEventByType: () => () => {} },
  };
  const output = `result.${format}`;
  const base = { image_path: 'source.jpg', output_path: output };
  const tool = operation === 'crop' ? createCropImageRuntime(host).createCropImageTool(10, { useNormalizedCoordinates: false })
    : operation === 'resize' ? createResizeImageRuntime(host).createResizeImageTool() : createRotateImageRuntime(host).createRotateImageTool();
  const args = operation === 'crop' ? { ...base, x1: 8, y1: 6, x2: 72, y2: 54 }
    : operation === 'resize' ? { ...base, width: 48, height: 36 } : { ...base, angle: 33 };
  const result = await withDependencyRuntime({ getDependencyPath: () => null, load: async () => sharp }, () => tool.handler(args,
    { config: { returnImageToAI: true } } as ToolContext));
  expect(result.success).toBe(true); expect(saved).toBeDefined();
  let expected = sharp(source);
  if (operation === 'crop') expected = expected.extract({ left: 8, top: 6, width: 64, height: 48 });
  else if (operation === 'resize') expected = expected.resize(48, 36, { fit: 'fill', kernel: 'lanczos3' });
  else expected = expected.rotate(33, { background: { r: 0, g: 0, b: 0, alpha: format === 'jpg' ? 1 : 0 } });
  const wanted = await (format === 'jpg' ? expected.jpeg({ quality: 90 }) : format === 'webp' ? expected.webp({ quality: 90 }) : expected.png()).toBuffer();
  // 编码结果与只做一次目标格式编码完全一致，额外压缩会使此断言失败。
  expect(saved!.equals(wanted)).toBe(true);
  const metadata = await sharp(saved!).metadata();
  expect(metadata.format).toBe(format === 'jpg' ? 'jpeg' : format);
  if (operation === 'crop') expect([metadata.width, metadata.height]).toEqual([64, 48]);
  if (operation === 'resize') expect([metadata.width, metadata.height]).toEqual([48, 36]);
  if (operation === 'rotate' && format !== 'jpg') {
    expect(metadata.hasAlpha).toBe(true);
    const pixel = await sharp(saved!).ensureAlpha().raw().toBuffer(); expect(pixel[3]).toBe(0);
  }
  expect(result.multimodal).toEqual([{ mimeType: format === 'jpg' ? 'image/jpeg' : `image/${format}`, data: saved!.toString('base64'), name: output }]);
  expect((result.data as { paths: string[] }).paths).toEqual([output]);
});
