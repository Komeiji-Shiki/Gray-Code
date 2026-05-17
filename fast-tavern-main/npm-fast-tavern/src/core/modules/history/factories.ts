import type { ChatMessage } from '../../types';

/**
 * 帮助你创建 history（wrapper ChatMessage[]）。
 * 说明：
 * - fast-tavern 作为引擎，直接使用 ChatMessage[]（不再需要旧的 HistoryInput/MessageFormat）。
 */
export const History = {
  /** 直接使用 Gemini(parts) 风格 */
  gemini: (messages: ChatMessage[]): ChatMessage[] => messages,

  /** 直接使用 OpenAI(content) 风格（role 通常为 system/user/assistant） */
  openai: (messages: ChatMessage[]): ChatMessage[] => messages,

  /** 快捷：用文本生成一条 user 消息 */
  text: (text: string | string[]): ChatMessage[] => {
    const joined = Array.isArray(text) ? text.join('\n') : String(text ?? '');
    return [{ role: 'user', parts: [{ text: joined }] }];
  },
} as const;
