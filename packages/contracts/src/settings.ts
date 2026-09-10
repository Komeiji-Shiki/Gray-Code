import type { DevelopmentSettings } from './development';
import type { RemoteAccessSettings } from './remote';
import type { CharacterChatConfig } from './characters';
import type {
  ActorIdentity,
  AgentDefinition,
  WorkspaceDefinition,
} from "./runtime";
import type { ProviderDefinition } from "./providers";

export interface AppearanceSettings {
  theme: "dark" | "light" | "system";
  uiFont: string;
  textFont: string;
  codeFont: string;
  fontSize: number;
  codeFontSize: number;
  lineHeight: number;
  density: "compact" | "comfortable";
  colors: Record<string, string>;
  backgroundImage: string;
  backgroundOpacity: number;
  customCss: string;
}
export interface PlatformBinding {
  id: string;
  platform: "discord" | "onebot";
  platformUserId: string;
  accountId: string;
  /** OneBot 12 的平台标识；旧 QQ 绑定对应 qq。 */
  network?: string;
}
export interface BotConnectionSettings {
  enabled: boolean;
  /** 已启用的 Bot 默认随应用启动连接，可单独关闭。 */
  autoConnect?: boolean;
  credentialRef?: string;
  allowedChannelIds: string[];
  agentId: string;
  workspaceId?: string;
  mentionOnly: boolean;
  defaultProfile?: DiscordReplyProfile;
}
export interface BotEnvironmentEntry {
  enabled: boolean;
  content: string;
  /** 随本轮输入固定保存，允许改写说明文字；实际身份仍由后端注入。 */
  identityTemplate: string;
}
export interface BotAutoSummarySettings {
  /** 缺省保留已有时间总结；常规方式按模型渠道的上下文阈值触发。 */
  method?: 'time' | 'summary' | 'notes';
  enabled: boolean;
  trigger: 'idle' | 'interval';
  minutes: number;
  percent: number;
  prompt: string;
}
export type DiscordTrigger = 'mention' | 'reply' | 'mention_or_reply' | 'keyword' | 'all' | 'command';
export interface DiscordReplyProfile {
  environmentEntry?: BotEnvironmentEntry;
  autoSummary?: BotAutoSummarySettings;
  output?: Partial<DiscordOutputSettings>;
  agentId?: string;
  providerId?: string;
  modelId?: string;
  promptModeId?: string;
  workspaceId?: string | null;
  character?: CharacterChatConfig | null;
  toolsEnabled?: boolean;
  maxIterations?: number;
  /** 旧设置仅保留兼容导出，新版固定频道会话不再按此字段自动新建。 */
  idleMinutes?: number;
}
export interface DiscordChannelSettings {
  guildId?: string;
  guildName?: string;
  name?: string;
  trigger?: DiscordTrigger;
  keywords?: string[];
  profile?: DiscordReplyProfile;
}
export interface DiscordOutputSettings {
  streaming: boolean;
  updateIntervalMs: number;
  showThoughts: boolean;
  showToolStatus: boolean;
  longReplies: 'split' | 'file';
}
export interface DiscordSettings extends BotConnectionSettings {
  defaultTrigger?: DiscordTrigger;
  defaultProfile?: DiscordReplyProfile;
  channels?: Record<string, DiscordChannelSettings>;
  /** 私聊始终只允许绑定到主人身份的账号。 */
  directMessages?: { enabled: boolean; profile?: DiscordReplyProfile };
  output?: DiscordOutputSettings;
}
export interface OneBotSettings extends BotConnectionSettings {
  channels?: Record<string, { name?: string; profile?: DiscordReplyProfile }>;
  directMessages?: { profile?: DiscordReplyProfile };
  /** OneBot 11 正向 WebSocket 的通用接口地址。 */
  endpoint: string;
  protocolVersion?: 11 | 12;
  self?: { platform: string; userId: string };
}
export interface AppSettings {
  remoteAccess?: RemoteAccessSettings;
  development?: DevelopmentSettings;
  modeProfiles?: Partial<Record<'chat' | 'code' | 'character', { promptModeId?: string; toolNames?: string[] }>>;
  toolCatalogVersion?: number;
  version: 1;
  appearance: AppearanceSettings;
  providers: ProviderDefinition[];
  agents: AgentDefinition[];
  workspaces: WorkspaceDefinition[];
  accounts: ActorIdentity[];
  bindings: PlatformBinding[];
  discord: DiscordSettings;
  onebot?: OneBotSettings;
}
export interface SettingsSnapshot {
  settings: AppSettings;
  revision: number;
  credentialIds: string[];
  /** Settings committed successfully, but a runtime integration needs attention. */
  activationWarnings?: string[];
}
export interface SettingsDraft {
  settings: AppSettings;
  expectedRevision: number;
  /** Only changes are submitted. Stored secrets are never sent back to a client. */
  credentials?: Record<string, string | null>;
}
export interface DocumentState {
  workspaceId: string;
  path: string;
  text: string;
  baseHash: string | null;
  version: number;
  dirty: boolean;
  clientId: string;
}
export interface DirectoryEntry {
  name: string;
  path: string;
  kind: "file" | "directory" | "symlink";
}
