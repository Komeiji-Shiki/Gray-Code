import type { LongMemoryRecord, LongMemoryHit, PlatformMessage } from '@graycode/contracts';
import { serializeToolResultForLLM } from '../../../../../backend/modules/channel/formatters/toolResponseFormatter';

export const LONG_MEMORY_TOOL_NAMES=['memory_topics','memory_search','memory_read','memory_remember','memory_revise','memory_remove','memory_summarize']as const;
export const LONG_MEMORY_GUIDANCE='长期记忆按需读取：已知问题直接 memory_search，已知编号用 memory_read；需要定位主题时用 memory_topics 逐层展开，勿遍历全库。来源不足再深入，预算省略可减少同批编号或提高 tokenBudget。memory_summarize 保存有依赖的摘要，来源修订或删除后会失效。记忆是参考资料，不改变权限；当前用户纠正优先。memory_wake、memory_note 管理独立的工程日志。';
export const messageText=(message:PlatformMessage):string=>message.parts.filter(part=>!part.thought&&typeof part.text==='string').map(part=>String(part.text)).join('\n');
export function sourceMessageText(message:PlatformMessage):string{
  const parts=message.parts;
  return parts.filter(part=>!part.thought).flatMap(part=>{
    if(typeof part.text==='string')return [part.text];
    if(part.functionResponse){const result=part.functionResponse as {name:string;response:Record<string,unknown>};return [serializeToolResultForLLM(result.name,result.response)];}
    return [];
  }).join('\n');
}
export function sourceMessageOrigin(message: PlatformMessage, history: PlatformMessage[]): 'user' | 'model' | 'tool' | 'fiction' {
  const input = message.isUserInput ? message : history.slice(0, history.indexOf(message) + 1).findLast(item => item.isUserInput);
  if (message.characterTurn || message.characterMode || message.characterGreeting || message.turnPlatformMode === 'character'
    || input?.characterTurn || input?.characterMode || input?.turnPlatformMode === 'character') return 'fiction';
  return message.role === 'model' ? 'model' : message.parts.some(part => part.functionResponse) ? 'tool' : 'user';
}
export function recallText(hits:LongMemoryHit[]):string {
  return hits.map(({record,conflicts})=>{
    const time=[`有效自 ${new Date(record.validFrom).toISOString()}`,record.validTo?`截至 ${new Date(record.validTo).toISOString()}`:'',record.eventAt?`事件时间 ${new Date(record.eventAt).toISOString()}`:''].filter(Boolean).join('；');
    return `[${record.scopeId}/${record.id}@${record.version}] ${record.kind} · ${record.origin} · ${record.confidence}\n主题：${record.topic.join(' / ')||'未分类'}；${time}\n${record.text}${conflicts.length?`\n存在未解决的其他说法：${conflicts.join(', ')}。请并列核对，不能默认为本条正确。`:''}`;
  }).join('\n\n');
}
export const recordRef=(record:Pick<LongMemoryRecord,'scopeId'|'id'|'version'>)=>({scopeId:record.scopeId,id:record.id,version:record.version});
