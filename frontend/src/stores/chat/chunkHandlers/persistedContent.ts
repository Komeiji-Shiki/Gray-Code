import type { Content, StreamChunk } from '../../../types';
import type { ChatStoreState } from '../types';
import { contentToMessageEnhanced } from '../parsers';
import { appendMessage, insertMessageAt, replaceMessageAt, setToolResponseCacheEntries } from '../state';
import { syncTotalMessagesFromWindow, trimWindowFromTop } from '../windowUtils';

export function appendPersistedToolContents(chunk: StreamChunk, state: ChatStoreState): void {
  for (const content of chunk.toolResultContents ?? []) {
    if (content.id && state.allMessages.value.some(message => message.id === content.id)) continue;
    const message = contentToMessageEnhanced(content, content.id);
    message.backendIndex = state.windowStartIndex.value + state.allMessages.value.length;
    appendMessage(state, message);
    setToolResponseCacheEntries(state, content.parts.flatMap(part => part.functionResponse?.id
      ? [[part.functionResponse.id, part.functionResponse.response as Record<string, unknown>] as [string, Record<string, unknown>]] : []));
  }
  if (chunk.toolResultContents?.length) { syncTotalMessagesFromWindow(state); trimWindowFromTop(state); }
}

export function insertUserFeedback(content: Content, state: ChatStoreState): void {
  if (content.id && state.allMessages.value.some(message => message.id === content.id)) return;
  const all = state.allMessages.value;
  const index = all.at(-1)?.localOnly && all.at(-1)?.role === 'assistant' ? all.length - 1 : all.length;
  const message = contentToMessageEnhanced(content, content.id);
  message.backendIndex = state.windowStartIndex.value + index;
  insertMessageAt(state, index, message);
  for (let position = index + 1; position < state.allMessages.value.length; position++) {
    const item = state.allMessages.value[position];
    replaceMessageAt(state, position, { ...item, backendIndex: (item.backendIndex ?? state.windowStartIndex.value + position - 1) + 1 });
  }
  syncTotalMessagesFromWindow(state); trimWindowFromTop(state);
}
