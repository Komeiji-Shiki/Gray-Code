import type { ComputerCapture, ComputerDisplay, ComputerWindow, ComputerWindows, RunStatus } from './index';
export type ScreenSenseTarget = { kind: 'window'; window: Pick<ComputerWindow, 'id' | 'title' | 'className' | 'processId' | 'processStartedAt' | 'executable'> }
  | { kind: 'display'; display: ComputerDisplay };
export interface ScreenSensePrices { currency: string; input: number; output: number; cacheRead: number; cacheWrite: number }
export interface ScreenSenseConfiguration {
  target: ScreenSenseTarget;
  trigger: 'manual' | 'interval';
  intervalSeconds?: number;
  delivery: 'preview' | 'automatic';
  maxCaptures: number;
  conversationId: string;
  prompt: string;
  /** 老配置继续可读，旧主模型选择不自动作为识图授权。 */
  providerId?: string;
  modelId?: string;
  visionProviderId?: string;
  visionModelId?: string;
  allowSilent?: boolean;
  /** 仅在绑定的陪伴对话完成界面初始化后自动开启，旧配置默认关闭。 */
  autoStartOnOpen?: boolean;
  prices?: ScreenSensePrices;
}
export type ScreenSenseVisionDefaults = Pick<ScreenSenseConfiguration, 'visionProviderId' | 'visionModelId'>;
/** 尚未选择采集范围时，同一配置记录只保存默认识图选择。 */
export type ScreenSenseStoredConfiguration = ScreenSenseConfiguration | (ScreenSenseVisionDefaults & { target?: never });
export interface ScreenSenseRecord {
  id: string;
  sessionId: string;
  createdAt: number;
  target: string;
  conversationId: string;
  providerId: string;
  modelId?: string;
  prices?: ScreenSensePrices;
  runId?: string;
  error?: string;
  summary?: string;
  silent?: boolean;
  visionUsage?: ScreenSenseUsage;
}
export interface ScreenSenseUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  requests: number;
  unknownRequests: number;
  estimatedCost?: number;
}
export interface ScreenSenseStatus {
  active: boolean;
  capturing: boolean;
  target?: string;
  captures: number;
  skipped?: number;
  maxCaptures?: number;
  nextCaptureAt?: number;
  error?: string;
  lastRunId?: string;
}
export interface ScreenSenseSnapshot {
  revision: number | null;
  configuration?: ScreenSenseConfiguration;
  visionDefaults: ScreenSenseVisionDefaults;
  status: ScreenSenseStatus;
  preview?: { id: string; capture: ComputerCapture; target: string; summary?: string };
  history: (ScreenSenseRecord & { status?: RunStatus; usage: ScreenSenseUsage; mainUsage?: ScreenSenseUsage })[];
}

export interface ScreenSenseOptions {
  targets: ComputerWindows;
  conversations: { id: string; title: string }[];
  providers: { id: string; name: string; model: string; models: { id: string; name?: string }[] }[];
}
export interface ScreenSenseRpcMethods {
  'screenSense.status': { params: Record<string, never>; result: ScreenSenseStatus };
  'screenSense.get': { params: Record<string, never>; result: ScreenSenseSnapshot };
  'screenSense.options': { params: { includeTargets?: boolean }; result: ScreenSenseOptions };
  'screenSense.configure': { params: { configuration: ScreenSenseConfiguration; revision: number | null }; result: ScreenSenseSnapshot };
  'screenSense.defaults.save': { params: { defaults: ScreenSenseVisionDefaults; revision: number | null }; result: ScreenSenseSnapshot };
  'screenSense.conversationOpened': { params: { conversationId: string }; result: ScreenSenseStatus };
  'screenSense.start': { params: Record<string, never>; result: ScreenSenseStatus };
  'screenSense.stop': { params: Record<string, never>; result: ScreenSenseStatus };
  'screenSense.capture': { params: Record<string, never>; result: ScreenSenseSnapshot };
  'screenSense.send': { params: { previewId: string }; result: { runId?: string; summary: string; silent: boolean } };
  'screenSense.cancelRun': { params: Record<string, never>; result: { success: true } };
}
