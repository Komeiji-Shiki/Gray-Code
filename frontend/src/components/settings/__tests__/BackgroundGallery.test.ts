import { mount, flushPromises } from '@vue/test-utils';
import { afterEach, expect, test, vi } from 'vitest';
import BackgroundGallery from '../BackgroundGallery.vue';
const mocks = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('@/utils/vscode', () => ({ sendToExtension: mocks.send }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
test.each([
  { name: '长截图', width: 1080, height: 24000, previewWidth: 14, previewHeight: 320 },
  { name: '横向图片', width: 1920, height: 1080, previewWidth: 320, previewHeight: 180 },
  { name: '小图标', width: 32, height: 16, previewWidth: 32, previewHeight: 16 },
])('$name 的预览限制宽高，上传的原图内容和尺寸保持完整', async ({ width, height, previewWidth, previewHeight }) => {
  const original = 'data:image/png;base64,b3JpZ2luYWw=';
  const thumbnail = 'data:image/jpeg;base64,cHJldmlldw==';
  vi.stubGlobal('FileReader', class { result = original; onload?: () => void; readAsDataURL() { queueMicrotask(() => this.onload?.()); } });
  vi.stubGlobal('Image', class { width = width; height = height; src = ''; decode() { return Promise.resolve(); } });
  const draw = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: draw } as unknown as CanvasRenderingContext2D);
  let canvasSize: number[] = [];
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(function (this: HTMLCanvasElement) { canvasSize = [this.width, this.height]; return thumbnail; });
  mocks.send.mockReset().mockImplementation(async type => type === 'appearance.images.list' ? [] : { url: 'graycode://app/assets/background/fixture' });
  const wrapper = mount(BackgroundGallery, { props: { visible: true, value: '', opacity: 0.12 }, global: { stubs: { Teleport: true } } });
  try {
    const input = wrapper.get('input[type="file"]');
    Object.defineProperty(input.element, 'files', { value: [new File(['source'], 'image.png', { type: 'image/png' })] });
    await input.trigger('change'); await flushPromises();
    expect(canvasSize).toEqual([previewWidth, previewHeight]); expect(draw).toHaveBeenCalledOnce();
    expect(mocks.send).toHaveBeenCalledWith('appearance.images.add', { name: 'image.png', dataUrl: original, thumbnail, width, height });
  } finally { wrapper.unmount(); }
});
