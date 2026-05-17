import type { ChatMessage } from '../../types';

export function isChatMessages(v: unknown): v is ChatMessage[] {
  return (
    Array.isArray(v) &&
    v.every((m) => {
      if (!m || typeof m !== 'object') return false;
      if (!('role' in (m as any))) return false;
      const hasParts = 'parts' in (m as any) && Array.isArray((m as any).parts);
      const hasContent = 'content' in (m as any) && typeof (m as any).content === 'string';
      return hasParts || hasContent;
    })
  );
}
