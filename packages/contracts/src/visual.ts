/** 工具图片中的坐标始终使用这张图片的实际像素尺寸。 */
export interface ScreenshotMetadata {
  mimeType: 'image/png' | 'image/jpeg';
  width: number;
  height: number;
}

export interface VisualObservation {
  id: string;
  capturedAt: number;
  coordinateSpace?: 'image';
  screenshot?: ScreenshotMetadata;
}

export interface VisualActionResult {
  operationId: string;
  status: 'dispatching' | 'completed' | 'failed' | 'unknown';
  repeated?: boolean;
  observation?: VisualObservation;
  /** 动作结果与后续截图结果分别表达，截图失败不意味着可以重做动作。 */
  observationError?: { code: string; message: string };
}
