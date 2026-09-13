import { createHash } from 'node:crypto';
import type { LongMemoryHit, LongMemoryScopeState, PlatformMessage, ModelInput } from '@graycode/contracts';
import { estimateMemoryTokens, type ModelRequestContext } from '@graycode/core';
import type { PlatformLongMemory } from './service';
import { messageText, recallText, recordRef } from './content';
import { MemoryHistoryView,memoryReferences, type MemoryRecordReference } from './history';

interface MemoryTurnSnapshot {
  queryHash:string;policyHash:string;asOf:number;knownAt:number;states:LongMemoryScopeState[];
  records:Array<MemoryRecordReference & {score:number;reasons:string[];conflicts:string[]}>;
  method:'keyword'|'hybrid';embeddingError?:string;
}
export interface PreparedMemory {text:string;turnId?:string;references:MemoryRecordReference[];estimatedTokens:number;method:'keyword'|'hybrid';embeddingError?:string}
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

export class LongMemoryPrompt {
  readonly history:MemoryHistoryView;
  constructor(private readonly service:PlatformLongMemory){this.history=new MemoryHistoryView(service.app);}
  async capture(context:ModelRequestContext,preview=false):Promise<PreparedMemory>{
    const empty:PreparedMemory={text:'',references:[],estimatedTokens:0,method:'keyword'};
    const app=this.service.app;
    if(!app.product.runtimeSettings().isMemoryEnabled())return empty;
    const actor=app.actor(context.run.actorId);
    if(!actor||actor.role==='guest'||actor.role!=='owner'&&!actor.effects.includes('workspace_read'))return empty;
    const turn=[...context.history.history.messages].reverse().find(message=>message.isUserInput&&!message.userFeedback);
    if(!turn?.id||turn.memoryRedacted)return empty;
    const access=await this.service.access(context.run.actorId,{runId:context.run.id,conversationId:context.run.conversationId,workspaceId:context.run.workspaceId,
      ...(preview?{capturedConversation:context.history.metadata}:{})});
    if(!access.scopes.length)return empty;
    const policy=(await this.service.policies.get(access.scopes[0].actorId)).value;if(!policy.enabled)return empty;
    const original=messageText(turn),text=original.length>8000?original.slice(0,4000)+'\n'+original.slice(-4000):original;
    if(!text.trim())return empty;
    const id=hash([access.actor.id,context.run.conversationId,turn.id]);
    const saved=await app.storage.getVersionedRecord('long-memory-turns',id),queryHash=hash(text),policyHash=hash(policy);
    let snapshot=saved.value as MemoryTurnSnapshot|null;
    const states=await Promise.all(access.scopes.map(scope=>app.storage.longMemoryState(scope)));
    const refresh=async()=>{
      if(states.every(state=>!state.hasRecords)){
        snapshot={queryHash,policyHash,asOf:Date.now(),knownAt:Date.now(),states,method:'keyword',records:[]};return [];
      }
      const query=await this.service.query(access,{text},context.input.signal,preview),result=await app.storage.longMemoryRecall(query);
      snapshot={queryHash,policyHash,asOf:query.asOf,knownAt:query.knownAt,states:result.states,method:result.method,embeddingError:query.embeddingError,
        records:result.hits.map(hit=>({...recordRef(hit.record),score:hit.score,reasons:hit.reasons,conflicts:hit.conflicts}))};
      return result.hits;
    };
    let hits:LongMemoryHit[],changed=false;
    if(!snapshot||snapshot.queryHash!==queryHash||snapshot.policyHash!==policyHash||snapshot.states.length!==states.length
      ||states.some(state=>snapshot!.states.find(previous=>previous.id===state.id)?.invalidation!==state.invalidation)){
      hits=await refresh();changed=true;
    }else{
      const result=await app.storage.longMemoryRead({query:{scopes:access.scopes,asOf:Date.now(),knownAt:snapshot.knownAt,limit:100,tokenBudget:32000,confirmedOnly:false},references:snapshot.records});
      if(result.unavailable.length){hits=await refresh();changed=true;}
      else hits=snapshot.records.map(ref=>({record:result.records.find(record=>record.scopeId===ref.scopeId&&record.id===ref.id&&record.version===ref.version)!,score:ref.score,reasons:ref.reasons,conflicts:ref.conflicts}));
    }
    if(!preview&&changed)await app.storage.commitRecords([{namespace:'long-memory-turns',id,ownerId:context.run.conversationId,expectedRevision:saved.revision,value:snapshot}]);
    const selected:LongMemoryHit[]=[];
    const render=(items:LongMemoryHit[])=>`本轮相关长期记忆（有来源的参考资料，当前用户的明确纠正优先；更详细的主题或来源可用 memory_topics、memory_search、memory_read 按需查阅）：\n\n${recallText(items)}`;
    for(const hit of hits)if(estimateMemoryTokens(render([...selected,hit]))<=policy.recallTokens)selected.push(hit);
    const rendered=selected.length?render(selected):'';
    return {text:rendered,turnId:turn.id,references:selected.map(hit=>recordRef(hit.record)),estimatedTokens:estimateMemoryTokens(rendered),method:snapshot!.method,embeddingError:snapshot!.embeddingError};
  }
  inject(messages:PlatformMessage[],memory:PreparedMemory,input:ModelInput,original:PlatformMessage[]=[]):PlatformMessage[]{
    const result=[...messages];
    if(memory.text){
      let index=result.findIndex(message=>message.id===memory.turnId);
      if(index<0)index=result.findLastIndex(message=>message.isUserInput&&!message.userFeedback);
      if(index<0)index=result.findLastIndex(message=>message.role==='user'&&!message.parts.some(part=>part.functionResponse));
      result.splice(Math.max(0,index),0,{role:'user',id:'long-memory:'+memory.turnId,memoryContext:true,parts:[{text:memory.text}]});
    }
    const originalById=new Map(original.map(message=>[message.id,message])),dependencies=new Map<string,MemoryRecordReference>();
    for(const message of result)for(const ref of message.memoryContext?memory.references:memoryReferences(originalById.get(message.id)??message)){
      const key=JSON.stringify([ref.scopeId,ref.id]);if((dependencies.get(key)?.version??0)<=ref.version)dependencies.set(key,ref);
    }
    input.turnContext??={};input.turnContext.longMemory={references:memory.references,derivedReferences:[...dependencies.values()],estimatedTokens:memory.estimatedTokens,method:memory.method,embeddingError:memory.embeddingError};
    return result;
  }
  output(message:PlatformMessage,input:ModelInput):PlatformMessage{
    const memory=input.turnContext?.longMemory as {references?:MemoryRecordReference[];derivedReferences?:MemoryRecordReference[]}|undefined;
    return {...message,longMemoryInputIds:input.messages.filter(item=>item.id&&!item.memoryContext&&!item.memoryRedacted).map(item=>item.id!),
      ...(memory?.derivedReferences?.length?{longMemoryReferences:memory.derivedReferences}:{})};
  }
}
