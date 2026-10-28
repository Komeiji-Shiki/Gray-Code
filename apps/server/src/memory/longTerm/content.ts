import type { LongMemoryRecord, PlatformMessage } from '@graycode/contracts';

export const LONG_MEMORY_GUIDANCE = 'Imported libraries are read on demand: use memory_search for a question, memory_read for known record IDs, '
  + 'and memory_topics to browse one level at a time; retrieve more only when needed.';
export const messageText=(message:PlatformMessage):string=>message.parts.filter(part=>!part.thought&&typeof part.text==='string').map(part=>String(part.text)).join('\n');
export function sourceMessageOrigin(message: PlatformMessage, history: PlatformMessage[]): 'user' | 'model' | 'tool' | 'fiction' {
  let input = message.isUserInput ? message : undefined;
  if (!input) for (let index = history.indexOf(message); index >= 0; index--) {
    if (history[index].isUserInput) { input = history[index]; break; }
  }
  if (message.characterTurn || message.characterMode || message.characterGreeting || message.turnPlatformMode === 'character'
    || input?.characterTurn || input?.characterMode || input?.turnPlatformMode === 'character') return 'fiction';
  return message.role === 'model' ? 'model' : message.parts.some(part => part.functionResponse) ? 'tool' : 'user';
}
export const recordRef=(record:Pick<LongMemoryRecord,'scopeId'|'id'|'version'>)=>({scopeId:record.scopeId,id:record.id,version:record.version});
