import type { PetChannel, PetCommandInput, PetConfiguration, PetControls, PetParameter, PetResource } from '@graycode/contracts';
import type { CubismGpuDiagnostics } from './cubismCompatibility';
export interface PetRenderPayload {
  resource: PetResource;
  bundle: { entry: string; files: { path: string; bytes: ArrayBuffer }[] };
  runtime?: ArrayBuffer;
}
export type PetRendererMessage = { type: 'graycode.pet.renderer'; sessionId?: string } & (
  { event: 'connected' } |
  { event: 'ready'; parameters: PetParameter[] } |
  { event: 'closed' } |
  { event: 'failed'; error: string } |
  { event: 'applied'; requestId?: string; success: boolean; error?: string } |
  { event: 'hit'; areas: string[] } |
  { event: 'diagnostics'; requestId: string; data?: PetRendererDiagnostics }
);
export interface PetRendererDiagnostics {
  frames: number;
  channels: Partial<Record<PetChannel, { id?: string; requestId: string }>>;
  parameters: Record<string, number>;
  focus?: { x: number; y: number };
  lipSyncIds?: string[];
  audio?: { paused: boolean; readyState: number; currentTime: number; error?: number };
  gpu?: CubismGpuDiagnostics;
}
export interface PetRenderer {
  parameters: PetParameter[];
  apply(command: PetCommandInput | null, configuration: Pick<PetConfiguration,
    'stopped' | 'reducedMotion' | 'soundEnabled' | 'followPointer'>, controls?: PetControls): Promise<void>;
  pointer?(x: number, y: number, leave: boolean): void;
  hitTest?(x: number, y: number): string[];
  mouth?(value: number): void;
  inspect?(gpu?: boolean): PetRendererDiagnostics;
  resize(width: number, height: number): void;
  destroy(): void;
}
