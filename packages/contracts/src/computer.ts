export interface ComputerRect { x: number; y: number; width: number; height: number }
export interface ComputerWindow {
  id: string; title: string; className: string; processId: number; executable?: string | null; commandLine?: string | null;
  processStartedAt?: string | null; ownerId?: string; monitorId: string; dpi: number; minimized: boolean; foreground: boolean;
  bounds: ComputerRect; captureBounds: ComputerRect;
}
export interface ComputerDisplay { id: string; bounds: ComputerRect; workArea: ComputerRect; scaleFactor: number; primary: boolean }
export interface ComputerWindows { capturedAt: number; windows: ComputerWindow[]; displays: ComputerDisplay[]; coordinateSystem: 'physical-screen-pixels' }
export interface ComputerElement {
  id: string; runtimeId: string; parentId?: string; name: string; type: string; automationId: string; value?: string;
  enabled: boolean; offscreen: boolean; password: boolean; focused: boolean; bounds: ComputerRect; patterns: string[];
}
export interface ComputerCapture {
  capturedAt: number; windowId: string; monitorId: string; dpi: number; bounds: ComputerRect;
  width: number; height: number; mimeType: 'image/png'; data: string;
  method?: 'window' | 'visible-screen-region';
}
export interface ComputerObservation {
  id: string; capturedAt: number; window: ComputerWindow; elements: ComputerElement[];
  focusedElementId?: string; truncated: boolean; accessibilityError?: string; screenshot?: ComputerCapture;
}
export type ComputerActionName = 'focusWindow' | 'focusElement' | 'invoke' | 'setValue' | 'select' | 'toggle' | 'expand' | 'collapse'
  | 'click' | 'type' | 'key' | 'scroll' | 'drag';
export interface ComputerAction {
  observationId: string; action: ComputerActionName; elementId?: string; text?: string; key?: string;
  /** 图像坐标按该观察实际返回的图片像素计算；屏幕坐标为物理像素。 */
  coordinateSpace?: 'image' | 'screen'; x?: number; y?: number; toX?: number; toY?: number;
  button?: 'left' | 'middle' | 'right'; clickCount?: number; scrollX?: number; scrollY?: number; durationMs?: number;
}
export interface ComputerController { actorId: string; runId?: string; clientId?: string; windowIds: string[]; acquiredAt: number }
export interface ComputerStatus {
  available: boolean; screenshotAvailable: boolean; platform: string; active: boolean; reason: string; error?: string;
  stopShortcut: string; stopShortcutRegistered?: boolean; controller?: ComputerController;
  pausedRunId?: string; host?: { pid: number; executable: string; startedAt: number };
}
export interface ComputerOperation {
  id: string; actorId: string; runId?: string; clientId?: string; requestedAt: number; finishedAt?: number;
  action: ComputerActionName; window: ComputerWindow; observationId: string;
  /** 输入正文与截图不进入操作摘要，模型工具的原始结果仍由既有任务记录管理。 */
  input: { textLength?: number; elementId?: string; key?: string; x?: number; y?: number; toX?: number; toY?: number };
  status: 'dispatching' | 'completed' | 'failed' | 'unknown'; result?: Record<string, unknown>; error?: string; code?: string;
}
