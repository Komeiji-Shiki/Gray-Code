import type { ComputerCapture, ComputerObservation } from '@graycode/contracts';

export interface NativeComputerStatus { active: boolean; leaseId?: string | null; owner?: string | null; reason: string; generation: number; stopShortcutRegistered?: boolean }
export interface ComputerNativePort {
  readonly available: boolean;
  readonly identity?: { pid: number; executable: string; startedAt: number };
  request<T>(method: string, params?: Record<string, unknown>, signal?: AbortSignal): Promise<T>;
  subscribe(listener: (status: NativeComputerStatus) => void): () => void;
  stop(reason: string): Promise<void>;
  close(): Promise<void>;
}
/** 屏幕采集由设备宿主实现，服务层不导入 Electron。 */
export interface ComputerScreenPort {
  capture(observation: ComputerObservation, size: { width: number; height: number }): Promise<ComputerCapture>;
}
export class ComputerError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'ComputerError'; }
}
