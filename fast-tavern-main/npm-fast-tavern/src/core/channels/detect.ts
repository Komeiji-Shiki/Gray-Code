import type { ChatMessage, TaggedContent } from '../types';
import { isGeminiMessages } from './gemini';
import { isOpenAIChatMessages } from './openai';
import { isTaggedContents } from './tagged';
import { isTextInput } from './text';

export type MessageFormat = 'auto' | 'gemini' | 'openai' | 'tagged' | 'text';
export type MessageInput = ChatMessage[] | TaggedContent[] | string | string[];

export function detectMessageFormat(input: MessageInput): Exclude<MessageFormat, 'auto'> {
  if (isTextInput(input)) return 'text';
  if (isTaggedContents(input)) return 'tagged';
  if (isGeminiMessages(input)) return 'gemini';
  if (isOpenAIChatMessages(input)) return 'openai';
  return 'gemini';
}
