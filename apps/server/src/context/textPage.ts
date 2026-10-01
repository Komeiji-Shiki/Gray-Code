import type { PlatformMessage } from '@graycode/contracts';
import { serializeToolResultForLLM } from '../../../../backend/modules/channel/formatters/toolResponseFormatter';

type MessagePart = PlatformMessage['parts'][number];

function partText(part: MessagePart, toolResult: (response: { name?: string; response?: unknown }) => string): string {
  if (typeof part.text === 'string') return part.text;
  if (part.inlineData) return `[Attachment: ${(part.inlineData as { mimeType?: string }).mimeType ?? 'file'}]`;
  if (part.functionCall) return JSON.stringify({ functionCall: part.functionCall });
  if (part.functionResponse) return toolResult(part.functionResponse as { name?: string; response?: unknown });
  if (part.fileData) return JSON.stringify({ fileData: part.fileData });
  return '';
}

/**
 * 历史读取与笔记来源校验使用同一文本视图，确保引用偏移可以直接续读。
 * 工具结果使用发给模型的同一序列化，正文不再 JSON 转义，也不带只给界面的字段。
 */
export function contextMessageText(message: PlatformMessage): string {
  return message.parts.map(part => partText(part, ({ name, response }) =>
    `[Tool result: ${name ?? 'unknown'}]\n${serializeToolResultForLLM(name ?? '', response as Record<string, unknown> | undefined)}`)).join('\n');
}

/**
 * 旧版本的文本视图（工具结果为整段 JSON）。只用于把旧笔记回执里按旧文本记录的
 * 来源偏移换算到当前文本，不参与新的读取和搜索。
 */
export function legacyContextMessageText(message: PlatformMessage): string {
  return message.parts.map(part => partText(part, response => JSON.stringify({ functionResponse: response }))).join('\n');
}

/** 当前文本视图版本；笔记回执没有此标记时，其来源偏移按旧版文本计算。 */
export const CONTEXT_TEXT_FORMAT = 2;

/** 所有位置按 UTF-16 字符偏移计数，与字符串分段读取一致。 */
export function textPage(text: string, offset: unknown, limit: unknown, fallback = 12000) {
  const start = offset ?? 0, count = limit ?? fallback;
  if (!Number.isSafeInteger(start) || Number(start) < 0) throw new Error('offset must be a non-negative safe integer');
  if (!Number.isSafeInteger(count) || Number(count) < 1 || Number(count) > 20000) throw new Error('limit must be an integer between 1 and 20000');
  const end = Math.min(text.length, Number(start) + Number(count));
  return { text: text.slice(Number(start), end), offset: Number(start), totalChars: text.length,
    truncated: end < text.length, nextOffset: end < text.length ? end : undefined };
}

export function historyPreview(text: string, query?: string) {
  const matchOffset = query === undefined ? undefined : text.indexOf(query);
  let start = matchOffset === undefined || matchOffset < 0 ? 0 : Math.max(0, matchOffset - 180);
  let end = Math.min(text.length, start + 600);
  if (start && /[\uDC00-\uDFFF]/.test(text[start]) && /[\uD800-\uDBFF]/.test(text[start - 1])) start--;
  if (end < text.length && /[\uDC00-\uDFFF]/.test(text[end]) && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
  return { text: text.slice(start, end), previewStartOffset: start, previewEndOffset: end,
    matchOffset, matchLength: query?.length, totalChars: text.length, textTruncated: start > 0 || end < text.length };
}
