import { desktopCapturer } from 'electron';
import type { ComputerCapture, ComputerObservation } from '@graycode/contracts';
import type { ComputerScreenPort } from '../../server/src/computer/port';
import { ComputerError } from '../../server/src/computer/port';

/** 窗口目录的复用时间；只决定是否值得为某个窗口生成图像，过期或未命中都会重新枚举。 */
const catalogLifetime = 2000;

export class DesktopComputerCapture implements ComputerScreenPort {
  private catalog?: { ids: Set<string>; at: number };
  private refreshing?: Promise<Set<string>>;
  /**
   * thumbnailSize 为 0 时 Electron 只枚举可共享窗口、不采集内容，开销远小于生成全部缩略图。
   * 并发观察共用同一次枚举；结果只用来提前排除不可共享的窗口，图像始终来自之后的新采集。
   */
  private async windows(): Promise<Set<string>> {
    this.refreshing ??= desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false })
      .then(sources => this.remember(sources.map(source => source.id)))
      .finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }
  private remember(ids: string[]): Set<string> {
    const value = new Set(ids.map(id => id.split(':')[1]));
    this.catalog = { ids: value, at: Date.now() };
    return value;
  }
  async capture(observation: ComputerObservation, size: { width: number; height: number; format?: 'png' | 'jpeg'; quality?: number }): Promise<ComputerCapture> {
    if (observation.window.minimized) throw new ComputerError('WINDOW_MINIMIZED', '请恢复窗口后再采集画面。');
    // 只信任缓存的命中；未命中时重新枚举，新打开的窗口不能因为旧目录被误判为不可采集。
    const cached = this.catalog && Date.now() - this.catalog.at < catalogLifetime ? this.catalog.ids : undefined;
    if (!cached?.has(observation.window.id) && !(await this.windows()).has(observation.window.id)) throw new ComputerError('CAPTURE_UNAVAILABLE', '没有取得这个窗口的画面，请检查窗口是否可见或受系统保护。');
    // desktopCapturer 没有按 source id 取单个窗口图像的接口，带尺寸的调用仍会为每个窗口生成缩略图；
    // 目录省掉的是目标不可共享时的全量采集；采集结果本身也刷新目录，连续观察同一窗口不再额外枚举。
    const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: size.width, height: size.height }, fetchWindowIcons: false });
    this.remember(sources.map(value => value.id));
    const source = sources.find(value => value.id.split(':')[1] === observation.window.id);
    if (!source || source.thumbnail.isEmpty()) throw new ComputerError('CAPTURE_UNAVAILABLE', '没有取得这个窗口的画面，请检查窗口是否可见或受系统保护。');
    const image = source.thumbnail, actual = image.getSize(), bounds = observation.window.captureBounds;
    if (bounds.width <= 0 || bounds.height <= 0 || Math.abs(actual.width / actual.height - bounds.width / bounds.height) > 0.035)
      throw new ComputerError('CAPTURE_GEOMETRY_CHANGED', '采集图像和窗口边界不一致，请重新观察窗口。');
    const jpeg = size.format === 'jpeg';
    return { capturedAt: Date.now(), windowId: observation.window.id, monitorId: observation.window.monitorId, dpi: observation.window.dpi,
      bounds: { ...bounds }, width: actual.width, height: actual.height, mimeType: jpeg ? 'image/jpeg' : 'image/png',
      data: (jpeg ? image.toJPEG(Math.max(50, Math.min(95, size.quality ?? 85))) : image.toPNG()).toString('base64'), method: 'window' };
  }
}
