import type { ComputerObservation } from '@graycode/contracts';
import { DesktopComputerCapture } from '../../../apps/desktop/src/computerCapture';

const mockGetSources = jest.fn();
jest.mock('electron', () => ({ desktopCapturer: { getSources: (...args: unknown[]) => mockGetSources(...args) } }));

// 0x0 目录不含图像；带尺寸的调用为每个窗口返回缩略图，与 Electron 的 getSources 行为一致。
let windows: string[] = [];
function sources(options: { thumbnailSize: { width: number; height: number } }) {
  const catalog = options.thumbnailSize.width === 0 || options.thumbnailSize.height === 0;
  return Promise.resolve(windows.map(id => ({ id: `window:${id}:0`, thumbnail: {
    isEmpty: () => catalog, getSize: () => ({ width: 1600, height: 1000 }),
    toPNG: () => Buffer.from(`png-${id}`), toJPEG: () => Buffer.from(`jpeg-${id}`),
  } })));
}
const observation = (id: string, minimized = false) => ({ window: { id, minimized, monitorId: 'monitor', dpi: 96,
  captureBounds: { x: 0, y: 0, width: 1600, height: 1000 } } }) as unknown as ComputerObservation;
const size = { width: 1600, height: 1200 };
const sizes = () => mockGetSources.mock.calls.map(([options]) => `${options.thumbnailSize.width}x${options.thumbnailSize.height}`);

beforeEach(() => { windows = ['100', '200']; mockGetSources.mockReset().mockImplementation(sources); });
afterEach(() => { jest.restoreAllMocks(); });

test('目标不在窗口目录时只做 0x0 枚举，不为所有窗口生成缩略图', async () => {
  await expect(new DesktopComputerCapture().capture(observation('300'), size)).rejects.toMatchObject({ code: 'CAPTURE_UNAVAILABLE' });
  expect(sizes()).toEqual(['0x0']);
  expect(mockGetSources.mock.calls[0][0]).toMatchObject({ types: ['window'], fetchWindowIcons: false });
});

test('目录短时复用，采集结果刷新目录；过期后重新枚举，图像每次都重新采集', async () => {
  let now = 1_000_000; jest.spyOn(Date, 'now').mockImplementation(() => now);
  const capture = new DesktopComputerCapture();
  expect(await capture.capture(observation('100'), size)).toMatchObject({ windowId: '100', method: 'window', width: 1600, height: 1000,
    mimeType: 'image/png', data: Buffer.from('png-100').toString('base64') });
  now += 1500;
  await capture.capture(observation('200'), { ...size, format: 'jpeg' });
  expect(sizes()).toEqual(['0x0', '1600x1200', '1600x1200']);
  now += 2000;
  await capture.capture(observation('100'), size);
  expect(sizes()).toEqual(['0x0', '1600x1200', '1600x1200', '0x0', '1600x1200']);
});

test('缓存目录没有新窗口时重新枚举一次，不把新窗口误判为不可采集', async () => {
  const capture = new DesktopComputerCapture();
  await capture.capture(observation('100'), size);
  windows.push('300');
  await expect(capture.capture(observation('300'), size)).resolves.toMatchObject({ windowId: '300' });
  expect(sizes()).toEqual(['0x0', '1600x1200', '0x0', '1600x1200']);
});

test('并发观察共用同一次目录枚举；目录有目标但图像为空仍报告不可采集', async () => {
  const capture = new DesktopComputerCapture();
  const results = await Promise.allSettled([capture.capture(observation('300'), size), capture.capture(observation('400'), size)]);
  expect(results.map(result => result.status)).toEqual(['rejected', 'rejected']);
  expect(sizes()).toEqual(['0x0']);
  mockGetSources.mockImplementation(async options => (await sources(options)).map(source => ({ ...source, thumbnail: { ...source.thumbnail, isEmpty: () => true } })));
  await expect(capture.capture(observation('100'), size)).rejects.toMatchObject({ code: 'CAPTURE_UNAVAILABLE' });
  await expect(capture.capture(observation('100', true), size)).rejects.toMatchObject({ code: 'WINDOW_MINIMIZED' });
  // 100 仍在刚枚举的目录里，直接采集；最小化窗口不调用 desktopCapturer。
  expect(sizes()).toEqual(['0x0', '1600x1200']);
});
