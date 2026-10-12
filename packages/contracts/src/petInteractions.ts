import type { ApprovalRequest, QuestionRequest, RunRecord } from './runtime';
import type { ProviderDefinition } from './providers';
import type { PlatformConversation, PlatformMessage } from './index';

export interface PetChatInput {
  conversationId: string;
  message: string;
  streamId: string;
  configId?: string;
  modelOverride?: string;
  attachments?: { mimeType: string; data: string; name?: string }[];
}

export interface PetInbox {
  conversations: { id: string; title?: string }[];
  selectedConversationId?: string;
  selection?: { configId: string; modelId: string; reasoningEffort?: string };
  providers: Pick<ProviderDefinition, 'id' | 'name' | 'model' | 'models'>[];
  history: { id?: string; role: string; text: string }[];
  runs: (RunRecord & { title: string })[];
  approvals: ApprovalRequest[];
  questions: QuestionRequest[];
}

export interface PetChatResult {
  success: true;
  runId: string;
  userContent?: PlatformMessage;
}

export interface PetInteractionRpcMethods {
  'pets.chat.create': { params: Record<string, never>; result: PlatformConversation };
  'pets.chat.send': { params: PetChatInput; result: PetChatResult };
  'pets.inbox': { params: { conversationId?: string }; result: PetInbox };
}

export type PetInteractionRequest = {
  [M in keyof PetInteractionRpcMethods]: { method: M; input: PetInteractionRpcMethods[M]['params'] }
}[keyof PetInteractionRpcMethods];
