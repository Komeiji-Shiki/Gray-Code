import type { ChatMessage, TaggedContent } from './types';

import { detectMessageFormat, type MessageFormat, type MessageInput } from './channels/detect';
import { toInternalFromGemini, fromInternalToGemini } from './channels/gemini';
import { toInternalFromOpenAI, fromInternalToOpenAI } from './channels/openai';
import { toInternalFromTagged } from './channels/tagged';
import { toInternalFromText, fromInternalToText, isTextInput } from './channels/text';

export { detectMessageFormat };
export type { MessageFormat, MessageInput };

/**
 * 将任意输入历史统一转换为内部格式：ChatMessage(parts)[]。
 * - openai: system/user/assistant -> system/user/model
 */
export function convertMessagesIn(
  input: MessageInput,
  format: MessageFormat = 'auto'
): { detected: Exclude<MessageFormat, 'auto'>; internal: ChatMessage[] } {
  const detected = (format === 'auto'
    ? detectMessageFormat(input)
    : (format as Exclude<MessageFormat, 'auto'>));

  if (detected === 'text') {
    // 兼容：string | string[]
    return { detected, internal: toInternalFromText(input as any) };
  }

  if (detected === 'gemini') {
    return { detected, internal: toInternalFromGemini(input as any) };
  }

  if (detected === 'openai') {
    return { detected, internal: toInternalFromOpenAI(input as any) };
  }

  if (detected === 'tagged') {
    return { detected, internal: toInternalFromTagged(input as any) };
  }
  return { detected: 'gemini', internal: toInternalFromGemini(input as any) };
}

export function convertMessagesOut(
  internal: ChatMessage[],
  format: Exclude<MessageFormat, 'auto'>
): ChatMessage[] | TaggedContent[] | string {
  if (format === 'gemini') return fromInternalToGemini(internal);
  if (format === 'openai') return fromInternalToOpenAI(internal);
  if (format === 'text') return fromInternalToText(internal);

  // tagged 无法从 internal 逆向恢复 tag/target（见 channels/tagged.ts 说明）
  return internal;
}

/** 小工具：兼容外部直接判断 text 输入 */
export { isTextInput };
