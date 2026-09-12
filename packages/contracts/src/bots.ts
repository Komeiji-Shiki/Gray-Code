export interface BotGuild { id: string; name: string; iconUrl?: string; unavailable: boolean }
export interface BotChannel { id: string; guildId?: string; name: string; category?: string; type: string; available: boolean; direct: boolean }
export interface BotUser { id: string; name: string; displayName: string; avatarUrl?: string; bot: boolean }
export interface BotStatus {
  status: string; botId?: string; name?: string; avatarUrl?: string; error?: string; pendingMessages?: number;
  controlsReady?: boolean; warning?: string; needsReconnect?: boolean; deliveryError?: string; retryAt?: number;
}

export interface BotDeliverySummary {
  id: string; phase: 'queued' | 'sending' | 'editing' | 'unknown'; channelId: string; conversationId: string;
  createdAt: number; error?: string; preview: string; completedParts: number; totalParts: number;
}
