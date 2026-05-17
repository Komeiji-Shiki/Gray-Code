import type { ChatMessage } from '../types';

export function isOpenAIChatMessages(v: unknown): v is ChatMessage[] {
  return (
    Array.isArray(v) &&
    v.every(
      (x) =>
        typeof x === 'object' &&
        x !== null &&
        'role' in x &&
        'content' in x &&
        typeof (x as any).content === 'string'
    )
  );
}

/**
 * openai: system/user/assistant 都保留。
 * - assistant -> model（内部）
 */
export function toInternalFromOpenAI(input: ChatMessage[]): ChatMessage[] {
  return (input || []).map((m) => ({
    role: String(m.role || '') === 'assistant' ? 'model' : String(m.role || 'user'),
    ...(m.name ? { name: m.name } : {}),
    ...(typeof m.swipeId === 'number' ? { swipeId: m.swipeId } : {}),
    parts: [{ text: String(('content' in m ? m.content : '') ?? '') }],
  }));
}

export function fromInternalToOpenAI(internal: ChatMessage[]): ChatMessage[] {
  return (internal || []).map((m) => {
    const role = String(m.role || 'user') === 'model' ? 'assistant' : String(m.role || 'user');
    const content =
      'content' in m
        ? String(m.content ?? '')
        : (m.parts || []).map((p: any) => ('text' in p ? (p.text ?? '') : '')).join('');
    return {
      role,
      ...(m.name ? { name: m.name } : {}),
      ...(typeof m.swipeId === 'number' ? { swipeId: m.swipeId } : {}),
      content,
    };
  });
}
