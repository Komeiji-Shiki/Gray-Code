import type { LongMemoryScopeState, LongMemoryTombstone, PlatformMessage,PlatformConversation } from '@graycode/contracts';
import type { PlatformApplication } from '../../application';
import { BOT_CHANNEL_ACCESS, type BotChannelAccess } from '../../bots/channelAccess';

export interface MemoryRecordReference {scopeId:string;id:string;version:number}
/** 删除判定仍覆盖整段依赖链，恢复单条正文时只需先读取这些来源与配对字段。 */
export const MEMORY_HISTORY_PROJECTION = {
  fields: ['contextWindowId', 'isUserInput', 'userFeedback', 'longMemoryReferences', 'longMemoryInputIds', 'longMemoryInputBase', 'summarizedMessageIds', 'parts'],
  properties: { parts: { items: {
    fields: ['functionCall', 'functionResponse'],
    properties: {
      functionCall: { fields: ['id', 'name'] },
      functionResponse: { fields: ['id', 'name', 'response'], properties: { response: { fields: ['memoryReferences', 'memoryScopeVersions'] } } },
    },
  } } },
  omitBinary: true,
};
const referenceKey=(value:{scopeId:string;id:string})=>JSON.stringify([value.scopeId,value.id]);
export function memoryReferences(message:PlatformMessage):MemoryRecordReference[]{
  const result=Array.isArray(message.longMemoryReferences)?message.longMemoryReferences as MemoryRecordReference[]:[];
  return [...result,...message.parts.flatMap(part=>{
    const response=part.functionResponse as {response?:{memoryReferences?:MemoryRecordReference[]}}|undefined;
    return Array.isArray(response?.response?.memoryReferences)?response!.response!.memoryReferences!:[];
  })];
}

/** 保留用户的原始存档，模型视图按删除标记重建；不可从旧回复、摘要或历史工具重新引入。 */
export class MemoryHistoryView {
  private readonly cache=new Map<string,{invalidation:number;tombstones:LongMemoryTombstone[]}>();
  constructor(private readonly app:PlatformApplication){}
  private async scopes(actorId:string,conversationId:string,capturedConversation?:PlatformConversation):Promise<LongMemoryScopeState[]>{
    const draft=capturedConversation?.id===conversationId&&capturedConversation.actorId===actorId&&!await this.app.storage.getConversation(conversationId);
    const conversation=draft?capturedConversation!:await this.app.conversation(actorId,conversationId);
    const scopes=await this.app.storage.longMemoryScopes(actorId);
    const access=await this.app.storage.getRecord(BOT_CHANNEL_ACCESS,conversationId) as BotChannelAccess|null;
    if(access?.version===1&&!access.context.direct&&typeof conversation.actorId==='string'&&conversation.actorId!==actorId){
      const c=access.context,key=JSON.stringify([c.platform,c.network??'',c.botId,c.channelId]);
      scopes.push(...(await this.app.storage.longMemoryScopes(conversation.actorId)).filter(scope=>scope.kind==='group'&&scope.key===key));
    }
    return scopes;
  }
  /** 来源定位覆盖完整依赖和角色回合，正文只在选定后按相同版本恢复。 */
  async readSources(actorId:string,conversationId:string,signal?:AbortSignal){
    signal?.throwIfAborted();
    const history=await this.app.storage.readHistorySelection(conversationId,{projection:{
      ...MEMORY_HISTORY_PROJECTION,
      fields:[...MEMORY_HISTORY_PROJECTION.fields,'runId','actorId','memoryRedacted','characterTurn','characterMode','characterGreeting','turnPlatformMode'],
      properties:{...MEMORY_HISTORY_PROJECTION.properties,characterTurn:{fields:[]}},
    }});
    signal?.throwIfAborted();
    const view=await this.prepare(actorId,conversationId,history.messages);
    signal?.throwIfAborted();
    return {messages:view.messages,expand:async(indices:number[])=>{
      signal?.throwIfAborted();
      const positions=[...new Set(indices)].sort((left,right)=>left-right);
      const page=await this.app.storage.readHistorySelection(conversationId,{indices:positions,expectedRevision:history.revision});
      signal?.throwIfAborted();
      const messages=view.filter(page.messages);
      // 替换原位置，保留来源归属判断所需的前序用户输入与对象身份。
      positions.forEach((position,index)=>{view.messages[position]=messages[index];});
      return messages;
    }};
  }
  async prepare(actorId:string,conversationId:string,original:PlatformMessage[],capturedConversation?:PlatformConversation){
    const scopes=await this.scopes(actorId,conversationId,capturedConversation),tombstones:LongMemoryTombstone[]=[];
    for(const scope of scopes){
      let cached=this.cache.get(scope.id);
      if(!cached||cached.invalidation!==scope.invalidation){
        // 完整删除标记用于工具结果，带定位的来源标记用于原消息。
        const tombstones=scope.invalidation?await this.app.storage.longMemoryDeletedSources([scope]):[];
        cached={invalidation:scope.invalidation,tombstones};
        if(this.cache.size>=128)this.cache.delete(this.cache.keys().next().value!);this.cache.set(scope.id,cached);
      }
      tombstones.push(...cached.tombstones);
    }
    const deletedRecords=new Set(tombstones.filter(tomb=>tomb.kind==='record').map(referenceKey));
    const sourceIds=new Set(tombstones.flatMap(tomb=>tomb.reference?.conversationId===conversationId&&tomb.reference.messageId?[tomb.reference.messageId]:[]));
    const filter=(messages:PlatformMessage[],known:{blockedIds:Set<string>;evaluatedIds:Set<string>}={blockedIds:new Set(),evaluatedIds:new Set()})=>{
      const blockedIds=new Set([...sourceIds,...known.blockedIds]),calls=new Set<string>(),evaluatedIds=new Set(known.evaluatedIds);
      const invalidDirectory=(message:PlatformMessage)=>message.parts.some(part=>{
        const versions=(part.functionResponse as {response?:{memoryScopeVersions?:Array<{scopeId:string;invalidation:number}>}}|undefined)?.response?.memoryScopeVersions;
        return Array.isArray(versions)&&versions.some(version=>scopes.find(scope=>scope.id===version.scopeId)?.invalidation!==version.invalidation);
      });
      for(const message of messages)if(memoryReferences(message).some(ref=>deletedRecords.has(referenceKey(ref)))||invalidDirectory(message)){
        if(message.id)blockedIds.add(message.id);
        for(const part of message.parts){const response=part.functionResponse as {id?:string}|undefined;if(response?.id)calls.add(response.id);}
      }
      for(const message of messages)if(message.parts.some(part=>calls.has(String((part.functionCall as {id?:string}|undefined)?.id))))if(message.id)blockedIds.add(message.id);
      let legacySourceBlocked=false;
      for(const message of messages){
        if(message.isUserInput&&!message.userFeedback)legacySourceBlocked=!!message.id&&blockedIds.has(message.id);
        const dependencies=Array.isArray(message.longMemoryInputIds)?message.longMemoryInputIds:Array.isArray(message.summarizedMessageIds)?message.summarizedMessageIds:[];
        // 增量记录继承基线回复的判定；基线已不在历史中时无法确认其依赖，只要存在被删除的来源就按受影响处理。
        const base=typeof message.longMemoryInputBase==='string'?message.longMemoryInputBase:undefined;
        const baseBlocked=base!==undefined&&(blockedIds.has(base)||!evaluatedIds.has(base)&&blockedIds.size>0);
        if(baseBlocked||dependencies.some(id=>blockedIds.has(String(id)))||legacySourceBlocked&&message.role==='model'&&!Array.isArray(message.longMemoryInputIds))if(message.id)blockedIds.add(message.id);
        if(message.id)evaluatedIds.add(message.id);
        for(const part of message.parts){const call=part.functionCall as {id?:string;name?:string}|undefined;if(message.id&&blockedIds.has(message.id)&&call?.id&&call.name!=='memory_remove')calls.add(call.id);}
        if(message.parts.some(part=>calls.has(String((part.functionResponse as {id?:string}|undefined)?.id))))if(message.id)blockedIds.add(message.id);
      }
      const cleaned=messages.map(message=>{
        if(!message.id||!blockedIds.has(message.id))return message;
        const notice='此历史内容依赖已删除的记忆，已从模型上下文移除。';
        const parts=message.parts.flatMap<PlatformMessage['parts'][number]>(part=>{
          if(part.functionCall){const call=part.functionCall as {id:string;name:string};return [call.name==='memory_remove'?part:{functionCall:{id:call.id,name:call.name,args:{}}}];}
          if(part.functionResponse){const response=part.functionResponse as {id:string;name:string};return [{functionResponse:{id:response.id,name:response.name,response:{success:false,error:notice}}}];}
          return [];
        });
        if(!parts.length)parts.push({text:notice} as any);
        const {longMemoryInputBase:_base,...rest}=message;
        return {...rest,parts,memoryRedacted:true,characterOriginalParts:parts,characterDisplayParts:parts,
          longMemoryInputIds:[],longMemoryReferences:[]};
      });
      return {messages:cleaned,blockedIds,evaluatedIds};
    };
    const initial=filter(original);
    // 裁剪后的模型视图可能不含基线回复，沿用完整历史的判定结果。
    return {messages:initial.messages,blockedIds:initial.blockedIds,filter:(messages:PlatformMessage[])=>filter(messages,initial).messages};
  }
}
