import type { ToolOutcome } from './runtime';

export type PetKind = 'sprite' | 'live2d';
export type PetAnimation = 'idle' | 'running-right' | 'running-left' | 'waving' | 'jumping' | 'failed' | 'waiting' | 'running' | 'review';
export type PetChannel = 'motion' | 'expression' | 'look' | 'parameters';
export const PET_CHANNELS: readonly PetChannel[] = ['motion', 'expression', 'look', 'parameters'];
export const PET_DEFAULT_DURATION_MS = 6000;
export const PET_APPLY_TIMEOUT_MS = 5000;
export const PET_HEARTBEAT_INTERVAL_MS = 5000;
export const PET_HEARTBEAT_TIMEOUT_MS = 20_000;
export const PET_SPRITE_CELL_WIDTH = 192;
export const PET_SPRITE_CELL_HEIGHT = 208;

export interface PetAction {
  id: string;
  name: string;
  description?: string;
  group?: string;
  index?: number;
  durationMs?: number;
}
export interface PetExpression { id: string; name: string; description?: string }
export interface PetParameter { id: string; name?: string; min: number; max: number; default: number }
export interface PetFile { path: string; data: string }
export interface PetImport { entry: string; files: PetFile[]; name?: string; source?: string; license?: string }
export interface PetResource {
  id: string;
  kind: PetKind;
  name: string;
  description: string;
  entry: string;
  source: string;
  license: string;
  sha256: string;
  createdAt: number;
  files: { path: string; mimeType: string; bytes: number; sha256: string }[];
  actions: PetAction[];
  expressions: PetExpression[];
  hitAreas?: { id: string; name: string; motion?: string }[];
  sprite?: { version: 1 | 2; atlas: string; width: number; height: number; neutral: boolean };
}
export interface PetConfiguration {
  resourceId?: string;
  visible: boolean;
  surface: 'app' | 'floating';
  scale: number;
  reducedMotion: boolean;
  stopped: boolean;
  taskAnimations: boolean;
  soundEnabled?: boolean;
  speechEnabled?: boolean;
  followPointer?: boolean;
  mappings: Partial<Record<PetAnimation, string>>;
  position?: { x: number; y: number };
}
export interface PetCommandInput {
  action: 'play' | 'expression' | 'look' | 'parameters' | 'set' | 'cancel' | 'resume';
  id?: string;
  motion?: string;
  expression?: string | null;
  angle?: number | null;
  parameters?: Record<string, number>;
  durationMs?: number;
}
export interface PetCommand extends PetCommandInput {
  requestId: string;
  generation: string;
  resourceId: string;
  source: 'task' | 'model' | 'manual';
  actorId: string;
  runId?: string;
  createdAt: number;
  expiresAt: number;
}
export type PetControls = Partial<Record<PetChannel, PetCommand>>;
export interface PetRenderState {
  generation: string;
  resourceId?: string;
  rendererId?: string;
  phase: 'unloaded' | 'loading' | 'ready' | 'failed';
  parameters: PetParameter[];
  error?: string;
  /** 四个通道分别覆盖和过期；current 仅记录最近一次指令，供旧客户端读取。 */
  channels?: PetControls;
  current?: PetCommand;
  applied?: { requestId: string; action: PetCommandInput['action']; id?: string; at: number };
}
export interface PetRuntime { name: string; sha256: string; bytes: number }
export interface PetSnapshot {
  configuration: PetConfiguration;
  revision: number | null;
  state: PetRenderState;
  resource?: PetResource;
  runtime?: PetRuntime;
  floatingAvailable: boolean;
}
/** 发给模型的目录不包含二进制资源、内部路径和内容校验值。 */
export interface PetModelCatalog {
  resource?: Pick<PetResource, 'id' | 'kind' | 'name' | 'description'> & {
    actions: Pick<PetAction, 'id' | 'name' | 'description'>[];
    expressions: PetExpression[];
  };
  parameters: PetParameter[];
  state: {
    phase: PetRenderState['phase'];
    stopped: boolean;
    channels: Partial<Record<PetChannel, Pick<PetCommand, 'requestId' | 'id' | 'angle' | 'parameters' | 'source' | 'expiresAt'>>>;
    applied?: PetRenderState['applied'];
  };
}
export interface PetResourceAnnotation {
  id: string;
  description?: string;
  actions?: { id: string; description: string }[];
  expressions?: { id: string; description: string }[];
  hitAreas?: { id: string; motion?: string }[];
}
export interface PetRendererIdentity { rendererId: string; generation: string }
type PetMethod<P, R> = { params: P; result: R };
type Empty = Record<string, never>;
type Success = { success: true };
export interface PetRpcMethods {
  'pets.position': PetMethod<{ position: { x: number; y: number } }, Success>;
  'pets.list': PetMethod<Empty, PetResource[]>;
  'pets.status': PetMethod<Empty, PetSnapshot>;
  'pets.import': PetMethod<PetImport, PetResource>;
  'pets.bundle': PetMethod<{ id: string }, PetImport>;
  'pets.resource.annotate': PetMethod<PetResourceAnnotation, PetResource>;
  'pets.remove': PetMethod<{ id: string; revision: number | null }, Success>;
  'pets.configure': PetMethod<{ configuration: PetConfiguration; revision: number | null }, PetSnapshot>;
  'pets.runtime.import': PetMethod<{ data: string; name: string }, PetSnapshot>;
  'pets.runtime.get': PetMethod<Empty, (PetRuntime & { data: string }) | null>;
  'pets.runtime.remove': PetMethod<Empty, PetSnapshot>;
  'pets.renderer.claim': PetMethod<PetRendererIdentity & { surface: PetConfiguration['surface'] }, PetSnapshot>;
  'pets.renderer.ready': PetMethod<PetRendererIdentity & { parameters: PetParameter[] }, Success>;
  'pets.renderer.heartbeat': PetMethod<PetRendererIdentity, Success>;
  'pets.renderer.closed': PetMethod<PetRendererIdentity, Success>;
  'pets.renderer.failed': PetMethod<PetRendererIdentity & { error: string }, Success>;
  'pets.renderer.applied': PetMethod<PetRendererIdentity & { requestId: string; success: boolean; error?: string },
    { success: boolean; stale?: true }>;
  'pets.command': PetMethod<{ command: PetCommandInput }, ToolOutcome>;
}
export type PetRpcRequest = {
  [M in keyof PetRpcMethods]: { method: M; input: PetRpcMethods[M]['params'] }
}[keyof PetRpcMethods];
