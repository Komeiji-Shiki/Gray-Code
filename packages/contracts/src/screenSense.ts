import type { ComputerCapture, ComputerDisplay, ComputerWindow, RunStatus } from './index';
export type ScreenSenseTarget = { kind: 'window'; window: Pick<ComputerWindow, 'id' | 'title' | 'className' | 'processId' | 'processStartedAt' | 'executable'> }
  | { kind: 'display'; display: ComputerDisplay };
export interface ScreenSensePrices { currency: string; input: number; output: number; cacheRead: number; cacheWrite: number }
export interface ScreenSenseConfiguration {
  target: ScreenSenseTarget; trigger: 'manual' | 'interval'; intervalSeconds?: number;
  delivery: 'preview' | 'automatic'; maxCaptures: number; conversationId: string; providerId: string; modelId?: string; prompt: string;
  prices?: ScreenSensePrices;
}
export interface ScreenSenseRecord {
  id: string; sessionId: string; createdAt: number; target: string; conversationId: string; providerId: string; modelId?: string;
  prices?: ScreenSensePrices; runId?: string; error?: string;
}
export interface ScreenSenseUsage {
  inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; requests: number; unknownRequests: number;
  estimatedCost?: number;
}
export interface ScreenSenseStatus {
  active: boolean; capturing: boolean; target?: string; captures: number; maxCaptures?: number; nextCaptureAt?: number; error?: string; lastRunId?: string;
}
export interface ScreenSenseSnapshot {
  revision: number | null; configuration?: ScreenSenseConfiguration; status: ScreenSenseStatus;
  preview?: { id: string; capture: ComputerCapture; target: string };
  history: (ScreenSenseRecord & { status?: RunStatus; usage: ScreenSenseUsage })[];
}
