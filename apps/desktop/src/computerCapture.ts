import { desktopCapturer } from 'electron';
import type { ComputerCapture, ComputerObservation } from '@graycode/contracts';
import type { ComputerScreenPort } from '../../server/src/computer/port';
import { ComputerError } from '../../server/src/computer/port';

export class DesktopComputerCapture implements ComputerScreenPort {
  async capture(observation: ComputerObservation, size: { width: number; height: number; format?: 'png' | 'jpeg'; quality?: number }): Promise<ComputerCapture> {
    if (observation.window.minimized) throw new ComputerError('WINDOW_MINIMIZED', '请恢复窗口后再采集画面。');
    const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: size.width, height: size.height }, fetchWindowIcons: false });
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
