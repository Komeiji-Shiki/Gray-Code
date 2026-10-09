import type { CharacterChatConfig, CharacterDefinition, CharacterResource, CharacterResourceDetail, CharacterResourceKind,
  CharacterResourceRow, CharacterConversationSettings } from './characters';
import type { ConversationNavigationCursor, ConversationNavigationResult, NavigationOrdering, NavigationOrderKind } from './navigation';

type Request<P, R> = { params: P; result: R };
type Empty = Record<string, never>;
type Id = { id: string };
type ResourceVersion = Id & { revision: number };
type Success = { success: boolean };
export interface ProjectNavigationTarget { workspaceId?: string; workspaceUri?: string }
export type NavigationScope = 'personal' | 'bots';

/** 稳定 UI 操作的参数和结果在这里关联，沿用 ui.request 的 type/data 传输。 */
export interface UiRequests {
  'characters.list': Request<Empty, CharacterResourceRow[]>;
  'characters.original': Request<Id, CharacterResource['source']>;
  'characters.definition': Request<Id, CharacterDefinition>;
  'characters.get': Request<Id, CharacterResourceDetail>;
  'characters.import': Request<{ name: string; data: string }, { id: string; imported: Array<{ id: string; name: string; kind: CharacterResourceKind }> }>;
  'characters.bind': Request<ResourceVersion & { name: string; worldbookIds: string[]; regexIds: string[];
    resolvedReferences?: Record<string, string> }, CharacterResourceDetail>;
  'characters.worldbook.update': Request<ResourceVersion & { raw: CharacterResource['raw']; name?: string }, CharacterResourceDetail>;
  'characters.archive': Request<ResourceVersion, void>;
  'characters.conversation.get': Request<{ conversationId: string }, CharacterConversationSettings>;
  'characters.conversation.create': Request<{ config: CharacterChatConfig }, { conversationId: string }>;
  'characters.conversation.save': Request<{ conversationId: string; config: CharacterChatConfig; metadataToken: string }, Success>;
  'conversation.navigation': Request<{ scope?: NavigationScope; query?: string; cursor?: ConversationNavigationCursor }, ConversationNavigationResult>;
  'conversation.navigation.reorder': Request<{ scope?: NavigationScope; kind: NavigationOrderKind; ids: string[]; revision: number }, NavigationOrdering>;
  'conversation.navigation.pinGroup': Request<{ key: string; pinned: boolean; revision: number }, NavigationOrdering>;
  'projects.rename': Request<ProjectNavigationTarget & { name: string }, Success>;
  'projects.previewRemoval': Request<ProjectNavigationTarget, { count: number; activeCount: number; token: string }>;
  'projects.remove': Request<ProjectNavigationTarget & { deleteConversations?: boolean; token?: string }, Success & { deletedIds: string[] }>;
  'conversation.pin': Request<{ conversationId: string; pinned: boolean }, Success>;
  'conversation.rename': Request<{ conversationId: string; title: string }, Success>;
  'conversation.deleteConversation': Request<{ conversationId: string }, Success>;
  'ui.mode.new': Request<{ mode: 'chat' | 'code' | 'character'; workspaceId?: string; automaticWorkspace?: boolean }, { conversationId: string }>;
}
export type UiRequestName = keyof UiRequests;
export type UiRequestParams<M extends UiRequestName> = UiRequests[M]['params'];
export type UiRequestResult<M extends UiRequestName> = UiRequests[M]['result'];
export type UiRequestArguments<M extends UiRequestName> = {} extends UiRequestParams<M>
  ? [data?: UiRequestParams<M>] : [data: UiRequestParams<M>];
export type UiRequestCall = <M extends UiRequestName>(type: M, ...args: UiRequestArguments<M>) => Promise<UiRequestResult<M>>;
export type UiRequestEnvelope = { [M in UiRequestName]: { type: M; data: UiRequestParams<M> } }[UiRequestName];
export type UiRequestHandlers = { [M in UiRequestName]: (data: UiRequestParams<M>) => UiRequestResult<M> | Promise<UiRequestResult<M>> };
