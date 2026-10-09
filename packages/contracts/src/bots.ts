export interface BotGuild { id: string; name: string; iconUrl?: string; unavailable: boolean }
export interface BotChannel { id: string; guildId?: string; name: string; category?: string; type: string; available: boolean; direct: boolean }
export interface BotUser { id: string; name: string; displayName: string; avatarUrl?: string; bot: boolean }
export interface BotStatus {
  status: string; botId?: string; name?: string; avatarUrl?: string; error?: string; pendingMessages?: number;
  controlsReady?: boolean; warning?: string; needsReconnect?: boolean; deliveryError?: string; retryAt?: number;
  lastHeartbeatAt?: number; online?: boolean;
}

export interface BotDeliverySummary {
  id: string; phase: 'queued' | 'sending' | 'editing' | 'unknown' | 'failed'; channelId: string; conversationId: string;
  createdAt: number; error?: string; retryAt?: number; preview: string; completedParts: number; totalParts: number;
}
export type BotMessageStage = 'received' | 'ignored' | 'duplicate' | 'preparing' | 'queued' | 'merged' | 'running' | 'completed' | 'failed' | 'limited' | 'control';
export interface BotMessageDiagnostic {
  id: string; channelId: string; userId: string; preview: string; receivedAt: number; updatedAt: number;
  stage: BotMessageStage; reason?: string; conversationId?: string; runId?: string;
  steps: Array<{ stage: BotMessageStage; at: number; reason?: string }>;
}
export interface BotPermissionDiagnostic { allowed: boolean; reason: string; actorName?: string; trigger: string }
