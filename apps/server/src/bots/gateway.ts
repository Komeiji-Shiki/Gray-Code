import type { BotChannel, BotGuild, BotUser } from '@graycode/contracts';
export type { BotChannel, BotGuild, BotUser } from '@graycode/contracts';

export interface BotInbound {
  id: string; authorId: string; channelId: string; content: string; mentioned: boolean; direct: boolean; network?: string;
  authorName?: string; repliedToBot?: boolean; guildId?: string;
  automated?: boolean;
  timestamp?: number;
  attachments?: BotAttachment[];
  references?: BotReference[];
}
export interface BotAttachment { name: string; url?: string; fileId?: string; contentType?: string; size?: number }
export interface BotReference {
  kind: 'reply' | 'forward'; id: string; channelId?: string; authorId?: string; authorName?: string; content?: string;
  timestamp?: number; attachments?: BotAttachment[]; references?: BotReference[]; unavailable?: string;
}
export interface BotButton { id: string; label: string; style?: 'primary' | 'secondary' | 'danger'; disabled?: boolean }
export interface BotSelectOption { label: string; value: string; description?: string; selected?: boolean }
export type BotPanelRow = { buttons: BotButton[] } | { select: { id: string; placeholder: string; options: BotSelectOption[] } };
export interface BotPanel { content: string; rows?: BotPanelRow[]; files?: Array<{ name: string; data: Uint8Array }> }
export interface BotReply { content?: string; files?: Array<{ name: string; data: Uint8Array }> }
export interface BotMessageReceipt { id: string }
export interface BotModal { id: string; title: string; fields: Array<{ id: string; label: string; value?: string; placeholder?: string; required?: boolean }> }
export interface BotInteraction {
  id: string; authorId: string; channelId: string; direct: boolean; guildId?: string;
  kind: 'command' | 'button' | 'select' | 'modal'; customId?: string; values?: string[]; fields?: Record<string, string>;
  defer(): Promise<void>;
  respond(panel: BotPanel): Promise<void>;
  showModal(modal: BotModal): Promise<void>;
}
export interface BotIdentity { id: string; name: string; avatarUrl?: string; controlsReady?: boolean; warning?: string }
export interface BotGateway {
  connect(token: string, allMessages: boolean, receive: (message: BotInbound) => void, state: (status: string) => void): Promise<BotIdentity>;
  send(channelId: string, content: string): Promise<void>;
  disconnect(): Promise<void>;
  setInteractionHandler?(handler: (interaction: BotInteraction) => Promise<void>): void;
  listGuilds?(): Promise<BotGuild[]>;
  listChannels?(guildId: string): Promise<BotChannel[]>;
  getChannel?(channelId: string): Promise<BotChannel>;
  getUser?(userId: string): Promise<BotUser>;
  sendReply?(channelId: string, reply: BotReply, nonce?: string): Promise<BotMessageReceipt>;
  editReply?(channelId: string, messageId: string, reply: BotReply): Promise<void>;
  /** 仅由发件箱使用自己保存的回执，移除流式排版收缩后多余的消息。 */
  deleteReply?(channelId: string, messageId: string): Promise<void>;
  hydrate?(message: BotInbound): Promise<BotInbound>;
}
