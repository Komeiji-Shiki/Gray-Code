export type ProviderProtocol =
  | "openai"
  | "openai-responses"
  | "anthropic"
  | "gemini"
  | "gemini-interactions";
export type OutputTokenParameter =
  | "protocol_default"
  | "max_tokens"
  | "max_completion_tokens"
  | "max_output_tokens";
export type ReasoningParameter =
  | "protocol_default"
  | "reasoning_effort"
  | "reasoning.effort"
  | "output_config.effort"
  | "thinking_level"
  | "disabled";

/** Explicit endpoint/model capabilities; model names are not authorization or capability signals. */
export interface ProviderCapabilities {
  /** 缺省保留 HTTP 和同步工具；仅 Responses 渠道使用。 */
  responsesWebSocket?: boolean;
  responsesAsyncTools?: boolean;
  outputTokenParameter: OutputTokenParameter;
  strictTools: "protocol_default" | "enabled" | "disabled";
  reasoningParameter: ReasoningParameter;
  reasoningLevels: string[];
  reasoningSignature: "none" | "native" | "codex" | "deepseek";
  compatibility: {
    deepSeekUserId: boolean;
    openCodeSession: boolean;
    deepSeekVision: boolean;
    nativePdf: boolean;
  };
}
export interface ProviderModel {
  id: string;
  name?: string;
  capabilities?: Partial<ProviderCapabilities>;
}
export interface ChatGPTAuthStatus {
  storageAvailable: boolean;
  activeClientId?: string;
  accounts: { clientId: string; email?: string; name?: string; connected: boolean; planEnabled: boolean }[];
  usageUrl: string;
  needsUsageNotice: boolean;
  login?: { state: 'pending' | 'exchanging' | 'completed' | 'failed' | 'cancelled'; error?: string };
}
export interface ProviderDefinition {
  id: string;
  name: string;
  protocol: ProviderProtocol;
  endpoint: string;
  model: string;
  models: ProviderModel[];
  credentialRef?: string;
  /** 缺省使用 API Key；ChatGPT 订阅凭据独立保存在加密存储中。 */
  authMode?: 'api-key' | 'chatgpt';
  stream: boolean;
  timeoutMs: number;
  capabilities: ProviderCapabilities;
  generation: {
    maxOutputTokens?: number;
    temperature?: number;
    reasoningEffort?: string;
  };
  customHeaders?: Record<string, string>;
  customBody?: Record<string, unknown>;
}
