import { createHash, randomUUID } from 'node:crypto';
import type { ActorIdentity, LongMemoryScope, LongMemoryQuery, LongMemoryRecord, LongMemoryRecordInput, LongMemorySourceInput, LongMemoryReference, LongMemoryPolicy, PlatformConversation, PlatformMessage, WorkspaceDefinition } from '@graycode/contracts';
import type { ToolContext } from '@graycode/core';
import type { PlatformApplication } from '../../application';
import { actorForBotRun } from '../../bots/permissions';
import { conversationMemoryScopes, longMemoryScope } from './scopes';
import { MemoryPolicyStore } from './policy';
import { MemoryEmbeddings } from './embeddings';
import { sourceMessageText, sourceMessageOrigin } from './content';
import {memoryReferences,type MemoryRecordReference} from './history';
import { MemoryBackground } from './background';
import { revisedMemoryText, type MemoryTextEdit } from './revisionText';

export interface MemoryAccess { actor:ActorIdentity; scopes:LongMemoryScope[]; conversation?:PlatformConversation; workspace?:WorkspaceDefinition }
export interface MemoryQueryOptions { scopeId?:string; text?:string; topic?:string[]; kinds?:LongMemoryQuery['kinds']; asOf?:number; knownAt?:number; confirmedOnly?:boolean; limit?:number; tokenBudget?:number }
type MemoryEdit=Omit<Partial<LongMemoryRecordInput>,'attribute'|'value'|'validTo'|'eventAt'>&MemoryTextEdit&{attribute?:string|null;value?:string|null;validTo?:number|null;eventAt?:number|null;
  scopeId:string;id:string;expectedVersion:number;sourceMessageId?:string;quote?:string};

export class PlatformLongMemory {
  readonly policies:MemoryPolicyStore;
  readonly embeddings:MemoryEmbeddings;
  readonly background:MemoryBackground;
  private closed=false;
  constructor(readonly app:PlatformApplication){this.policies=new MemoryPolicyStore(app);this.embeddings=new MemoryEmbeddings(app);this.background=new MemoryBackground(this);}

  async access(actorId:string,options:{conversationId?:string;workspaceId?:string;runId?:string;capturedConversation?:PlatformConversation}={}):Promise<MemoryAccess>{
    const run=options.runId?await this.app.storage.getRun(options.runId):undefined;
    const actor=await actorForBotRun(this.app,actorId,run??(options.conversationId?{conversationId:options.conversationId,workspaceId:options.workspaceId}:undefined));
    if(!actor||actor.role==='guest'||actor.role!=='owner'&&!actor.effects.includes('workspace_read'))throw new Error('当前账号没有长期记忆访问权限。');
    const draft=!!options.capturedConversation&&options.capturedConversation.id===options.conversationId&&options.capturedConversation.actorId===actorId
      &&!await this.app.storage.getConversation(options.conversationId!);
    const conversation=draft?options.capturedConversation:options.conversationId?await this.app.conversation(actorId,options.conversationId):undefined;
    const workspaceId=options.workspaceId??(typeof conversation?.workspaceId==='string'?conversation.workspaceId:undefined);
    const workspace=workspaceId?this.app.workspace(actorId,workspaceId,['workspace_read']):undefined;
    const scopes=await conversationMemoryScopes(this.app,actor,conversation,workspace,draft);
    return {actor,scopes,conversation,workspace};
  }
  select(access:MemoryAccess,id?:string):LongMemoryScope[] {
    if(!id)return access.scopes;
    const scope=access.scopes.find(item=>item.id===id);if(!scope)throw new Error('所选记忆不属于当前对话的授权范围。');return [scope];
  }
  async query(access:MemoryAccess,options:MemoryQueryOptions={},signal?:AbortSignal,preview=false):Promise<LongMemoryQuery & {embeddingError?:string}>{
    const scopes=this.select(access,options.scopeId);if(!scopes.length)throw new Error('当前对话没有可用的记忆范围。');
    const policy=(await this.policies.get(scopes[0].actorId)).value;
    const now=Date.now();const query:LongMemoryQuery & {embeddingError?:string}={scopes,text:options.text,topic:options.topic,kinds:options.kinds,
      asOf:options.asOf??now,knownAt:options.knownAt??now,confirmedOnly:options.confirmedOnly??true,includeSummaries:true,limit:options.limit??policy.recallLimit,tokenBudget:options.tokenBudget??policy.recallTokens};
    if(policy.embedding&&query.text?.trim()){
      try{
        if(preview){query.vector=this.embeddings.cached(scopes[0].actorId,policy.embedding,query.text,'query');if(!query.vector)query.embeddingError='语义查询尚未执行；只读预览使用关键词结果，发送后可检查完整的实际请求。';}
        else query.vector=(await this.embeddings.embed(scopes[0].actorId,policy.embedding,[query.text],signal??new AbortController().signal,'query')).vectors[0];
      }
      catch(error){if(signal?.aborted)throw error;query.embeddingError=String((error as Error).message);}
    }
    return query;
  }
  async search(access:MemoryAccess,options:MemoryQueryOptions,signal?:AbortSignal,preview=false){
    const query=await this.query(access,options,signal,preview);const result=await this.app.storage.longMemoryRecall(query);
    return {...result,...query.embeddingError?{embeddingError:query.embeddingError}:{}};
  }
  async scopesForManagement(actorId:string,context:{conversationId?:string;workspaceId?:string}={}):Promise<LongMemoryScope[]>{
    const actor=this.app.actor(actorId);if(!actor||actor.role==='guest')throw new Error('当前账号不能管理私人记忆。');
    const stored=await this.app.storage.longMemoryScopes(actorId);
    const current=context.conversationId||context.workspaceId?(await this.access(actorId,context)).scopes:[];
    return [...new Map([longMemoryScope(actorId,'personal'),...stored,...current].map(scope=>[scope.id,scope])).values()];
  }
  async managementAccess(actorId:string,scopeId?:string,context:{conversationId?:string;workspaceId?:string}={}):Promise<MemoryAccess>{
    const actor=this.app.actor(actorId);if(!actor||actor.role==='guest')throw new Error('当前账号不能管理私人记忆。');
    const scopes=await this.scopesForManagement(actorId,context);
    if(scopeId&&!scopes.some(scope=>scope.id===scopeId))throw new Error('这个记忆范围不属于当前账号。');
    return {actor,scopes:scopeId?scopes.filter(scope=>scope.id===scopeId):scopes.filter(scope=>scope.realm==='real')};
  }
  private requireWrite(access:MemoryAccess):void {
    if(access.actor.role!=='owner'&&!access.actor.effects.includes('workspace_write'))throw new Error('当前账号没有修改记忆的权限。');
  }
  private async messageSource(access:MemoryAccess,context?:ToolContext,referenceId?:string,quote?:string):Promise<LongMemorySourceInput&{memoryReferences?:MemoryRecordReference[]}>{
    if(!access.conversation||!context)throw new Error('模型写入必须引用当前会话中的真实消息。');
    const history=await this.app.storage.readHistory(access.conversation.id,{limit:1000});
    const view=await this.app.longMemoryPrompt.history.prepare(context.actorId,access.conversation.id,history.messages);
    const original=referenceId==='last_assistant'?[...view.messages].reverse().find(message=>message.role==='model'):
      referenceId?view.messages.find(message=>message.id===referenceId):[...view.messages].reverse().find(message=>message.isUserInput&&!message.userFeedback&&message.actorId===context.actorId);
    if(!original?.id)throw new Error('找不到指定来源消息，请先读取来源。');
    if(original.memoryRedacted)throw new Error('这条来源已依赖被删除的记忆，不能再次保存。');
    let full=sourceMessageText(original);
    if(quote&&!full.includes(quote)&&Array.isArray(original.characterOriginalParts)){
      const raw=sourceMessageText({...original,parts:original.characterOriginalParts as PlatformMessage['parts']});if(raw.includes(quote))full=raw;
    }
    const text=quote??full;
    if(!text.trim()||!full.includes(text))throw new Error('来源摘录必须逐字来自指定消息。');
    if(text.length>32000)throw new Error('来源过长，请提供本条记忆对应的较短原文摘录。');
    const origin=sourceMessageOrigin(original,view.messages);
    return {id:createHash('sha256').update(JSON.stringify([access.conversation.id,original.id,text])).digest('hex'),expectedVersion:0,memoryReferences:memoryReferences(original),
      text,origin,recordedAt:typeof original.timestamp==='number'?original.timestamp:Date.now(),reference:{conversationId:access.conversation.id,messageId:original.id,
        ...(typeof original.actorId==='string'?{speakerActorId:original.actorId}:{})}};
  }
  async remember(access:MemoryAccess,input:Partial<LongMemoryRecordInput> & {scopeId:string;sourceMessageId?:string;quote?:string},context?:ToolContext){
    this.requireWrite(access);const scope=this.select(access,input.scopeId)[0];
    if(input.kind==='summary')throw new Error('分层摘要请通过所选记忆依据创建。');
    const source:LongMemorySourceInput&{memoryReferences?:MemoryRecordReference[]}=context?await this.messageSource(access,context,input.sourceMessageId,input.quote):{id:randomUUID(),expectedVersion:0,origin:'user',text:String(input.text??''),recordedAt:Date.now(),reference:{label:'记忆管理页',speakerActorId:access.actor.id}};
    if(source.memoryReferences?.some(ref=>ref.scopeId!==scope.id))throw new Error('这段模型输出混用了其他范围的记忆，请引用同一范围的原始用户消息或工具结果。');
    if(scope.realm!=='real')source.origin='fiction';
    else if(source.origin==='fiction')throw new Error('角色剧情中的来源不能保存为真实个人记忆。');
    const record:LongMemoryRecordInput={id:randomUUID(),expectedVersion:0,kind:input.kind??'fact',origin:source.origin,
      confidence:source.origin==='model'?'inferred':input.confidence??'confirmed',subject:input.subject?.trim()||`actor:${source.reference?.speakerActorId??access.actor.id}`,
      text:String(input.text??''),topic:input.topic??[],entities:input.entities??[],attribute:input.attribute??undefined,value:input.value??undefined,
      recordedAt:Date.now(),validFrom:input.validFrom??source.recordedAt,validTo:input.validTo??undefined,eventAt:input.eventAt??undefined,
      dependencies:[{kind:'source',id:source.id,version:1},...source.memoryReferences?.map(ref=>({kind:'record' as const,id:ref.id,version:ref.version}))??[]],supersedes:input.supersedes??[]};
    const result=await this.app.storage.longMemoryWrite({scope,sources:[source],records:[record]});this.changed(scope.id);this.index(scope,result.records);
    return result;
  }
  async revise(access:MemoryAccess,input:MemoryEdit,context?:ToolContext){
    this.requireWrite(access);const scope=this.select(access,input.scopeId)[0];
    const previous=(await this.app.storage.longMemoryRevisions({scope,id:input.id}))[0];
    if(!previous||previous.version!==input.expectedVersion)throw new Error('记忆已经修订或删除，请重新读取后修改。');
    const text = revisedMemoryText(previous.text, input);
    const source:LongMemorySourceInput&{memoryReferences?:MemoryRecordReference[]}=context?await this.messageSource(access,context,input.sourceMessageId,input.quote):{id:randomUUID(),expectedVersion:0,origin:'user',text,recordedAt:Date.now(),reference:{label:'用户修订',speakerActorId:access.actor.id}};
    if(source.memoryReferences?.some(ref=>ref.scopeId!==scope.id))throw new Error('修订需要同一范围的直接来源，不能复制其他范围的模型总结。');
    if(scope.realm!=='real')source.origin='fiction';
    else if(source.origin==='fiction')throw new Error('角色剧情中的来源不能保存为真实个人记忆。');
    const record:LongMemoryRecordInput={...previous,...input,id:previous.id,expectedVersion:previous.version,origin:source.origin,
      text,kind:input.kind??previous.kind,subject:input.subject??previous.subject,topic:input.topic??previous.topic,entities:input.entities??previous.entities,
      attribute:input.attribute===null?undefined:input.attribute??previous.attribute,value:input.value===null?undefined:input.value??previous.value,
      validTo:input.validTo===null?undefined:input.validTo??previous.validTo,eventAt:input.eventAt===null?undefined:input.eventAt??previous.eventAt,
      confidence:source.origin==='model'?'inferred':input.confidence??'confirmed',recordedAt:Date.now(),
      validFrom:input.validFrom??source.recordedAt,dependencies:[...new Map([...previous.dependencies.filter(ref=>ref.kind==='record'),
        ...source.memoryReferences?.filter(ref=>ref.id!==previous.id).map(ref=>({kind:'record' as const,id:ref.id,version:ref.version}))??[]].map(ref=>[ref.id,ref])).values(),{kind:'source',id:source.id,version:1}],supersedes:input.supersedes??previous.supersedes};
    const result=await this.app.storage.longMemoryWrite({scope,sources:[source],records:[record]});this.changed(scope.id,true);this.index(scope,result.records);return result;
  }
  async summarize(access:MemoryAccess,input:{scopeId:string;id?:string;expectedVersion?:number;recordIds:string[];text:string;topic:string[]}){
    this.requireWrite(access);const scope=this.select(access,input.scopeId)[0];
    const now=Date.now(),query=await this.query(access,{scopeId:scope.id,confirmedOnly:false,limit:100,tokenBudget:32000});
    const selected=await this.app.storage.longMemoryRead({query,references:input.recordIds.map(id=>({scopeId:scope.id,id}))});
    if(selected.unavailable.length||selected.records.length!==new Set(input.recordIds).size)throw new Error('摘要包含已失效或未能完整读取的记忆，请分层选择较少来源。');
    const record:LongMemoryRecordInput={id:input.id??randomUUID(),expectedVersion:input.expectedVersion??0,kind:'summary',origin:'model',confidence:'inferred',subject:'topic:'+input.topic.join('/'),
      text:input.text,topic:input.topic,entities:[...new Set(selected.records.flatMap(record=>record.entities))].slice(0,64),recordedAt:now,validFrom:now,
      dependencies:selected.records.map(record=>({kind:'record',id:record.id,version:record.version})),supersedes:[]};
    const result=await this.app.storage.longMemoryWrite({scope,records:[record]});this.changed(scope.id);this.index(scope,result.records);return result;
  }
  async remove(access:MemoryAccess,input:{scopeId:string;id:string;expectedVersion:number;action:'delete'|'retract'}){
    this.requireWrite(access);const scope=this.select(access,input.scopeId)[0];
    const result=await this.app.storage.longMemoryWrite({scope,remove:[{kind:'record',id:input.id,expectedVersion:input.expectedVersion,action:input.action}]});
    this.changed(scope.id,true);return result;
  }
  changed(scopeId:string,invalidate=false):void{
    if(invalidate)this.embeddings.clear();
    this.app.publish({type:'memory.changed',scopeId});
  }
  index(scope:LongMemoryScope,records:LongMemoryRecord[]):void{
    if(this.closed||!records.length)return;
    void this.background.enqueueEmbedding(scope,records).catch(error=>{if(!this.closed)this.app.publish({type:'memory.index.failed',scopeId:scope.id,message:String((error as Error).message)});});
  }
  async waitForIndexes():Promise<void>{await this.background.wait();}
  async close():Promise<void>{this.closed=true;const closing=this.background.close();this.embeddings.close();await closing;}
}
