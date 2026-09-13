export type PetKind = 'sprite' | 'live2d';
export type PetAnimation = 'idle' | 'running-right' | 'running-left' | 'waving' | 'jumping' | 'failed' | 'waiting' | 'running' | 'review';
export interface PetAction { id: string; name: string; group?: string; index?: number; durationMs?: number }
export interface PetParameter { id: string; name?: string; min: number; max: number; default: number }
export interface PetFile { path: string; data: string }
export interface PetImport { entry: string; files: PetFile[]; name?: string; source?: string; license?: string }
export interface PetResource {
  id: string; kind: PetKind; name: string; description: string; entry: string;
  source: string; license: string; sha256: string; createdAt: number;
  files: { path: string; mimeType: string; bytes: number; sha256: string }[];
  actions: PetAction[]; expressions: { id: string; name: string }[];
  sprite?: { version: 1 | 2; atlas: string; width: number; height: number; neutral: boolean };
}
export interface PetConfiguration {
  resourceId?: string; visible: boolean; surface: 'app' | 'floating'; scale: number;
  reducedMotion: boolean; stopped: boolean; taskAnimations: boolean;
  mappings: Partial<Record<PetAnimation, string>>;
  position?: { x: number; y: number };
}
export interface PetCommandInput {
  action: 'play' | 'expression' | 'look' | 'parameters' | 'cancel' | 'resume';
  id?: string; angle?: number | null; parameters?: Record<string, number>;
  durationMs?: number;
}
export interface PetCommand extends PetCommandInput {
  requestId: string; generation: string; resourceId: string;
  source: 'task' | 'model' | 'manual'; actorId: string; runId?: string;
  createdAt: number; expiresAt: number;
}
export interface PetRenderState {
  generation: string; resourceId?: string; rendererId?: string;
  phase: 'unloaded' | 'loading' | 'ready' | 'failed';
  parameters: PetParameter[]; error?: string; current?: PetCommand;
  applied?: { requestId: string; action: PetCommandInput['action']; id?: string; at: number };
}
export interface PetSnapshot {
  configuration: PetConfiguration; revision: number | null; state: PetRenderState;
  resource?: PetResource; runtime?: { name: string; sha256: string; bytes: number };
  floatingAvailable: boolean;
}
