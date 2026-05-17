import type { ChatMessage } from '../types';

export function isTextInput(v: unknown): v is string | string[] {
  return typeof v === 'string' || (Array.isArray(v) && v.every((x) => typeof x === 'string'));
}

export function toInternalFromText(input: string | string[]): ChatMessage[] {
  const text = Array.isArray(input) ? input.join('\n') : (input ?? '');
  return [{ role: 'user', parts: [{ text }] }];
}

export function fromInternalToText(internal: ChatMessage[]): string {
  return (internal || [])
    .map((m) => {
      if ('content' in m) return String(m.content ?? '');
      return (m.parts || []).map((p) => ('text' in p ? (p.text ?? '') : '')).join('');
    })
    .join('\n');
}
