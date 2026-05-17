import type { ChatMessage, MessagePart } from '../types';

export function isGeminiMessages(v: unknown): v is ChatMessage[] {
  return (
    Array.isArray(v) &&
    v.every(
      (x) =>
        typeof x === 'object' &&
        x !== null &&
        'role' in x &&
        'parts' in x &&
        Array.isArray((x as any).parts)
    )
  );
}

export function toInternalFromGemini(input: ChatMessage[]): ChatMessage[] {
  return (input || []).map((m) => {
    if (!('parts' in m)) {
      return { role: String(m.role || 'user'), parts: [{ text: String((m as any).content ?? '') }] };
    }
    return {
      role: String(m.role || 'user'),
      ...(m.name ? { name: m.name } : {}),
      ...(typeof m.swipeId === 'number' ? { swipeId: m.swipeId } : {}),
      parts: (m.parts || []).map((p) => ({ ...(p as MessagePart) })),
      ...(Array.isArray((m as any).swipes) ? { swipes: (m as any).swipes } : {}),
    };
  });
}

export function fromInternalToGemini(internal: ChatMessage[]): ChatMessage[] {
  // internal 已经是 parts 结构，直接返回即可
  return internal;
}
