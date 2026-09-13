import type { RuntimeTool } from '@graycode/core';
import type { LongMemoryRecord, ToolOutcome } from '@graycode/contracts';
import type { PlatformLongMemory } from './service';
import { recordRef } from './content';

const scopeId={type:'string',description:'memory_topics 或本轮记忆返回的授权 scopeId。'};
const topic={type:'array',items:{type:'string',maxLength:120},maxItems:8,description:'从宽到窄的主题路径，例如 ["项目","晴川","部署"]。'};
const kinds={type:'string',enum:['fact','preference','experience','project','procedure','event','summary']};
const time={type:'number',description:'UTC Unix 毫秒。没有明确时间依据时省略。'};
const schema=(properties:Record<string,unknown>,required:string[]=[])=>({type:'object',properties,required,additionalProperties:false});
const query={scopeId,topic,text:{type:'string',maxLength:32000},asOf:time,knownAt:time,
  limit:{type:'integer',minimum:1,maximum:50},tokenBudget:{type:'integer',minimum:256,maximum:16000},confirmedOnly:{type:'boolean'}};
const fields={scopeId,text:{type:'string',minLength:1,maxLength:32000},kind:{...kinds,enum:kinds.enum.filter(kind=>kind!=='summary')},subject:{type:'string',maxLength:512},
  attribute:{type:'string',maxLength:256},value:{type:'string',maxLength:4000},topic,entities:{type:'array',items:{type:'string'},maxItems:64},
  validFrom:time,validTo:time,eventAt:time,confidence:{type:'string',enum:['confirmed','inferred','disputed']},
  sourceMessageId:{type:'string',description:'当前会话中的原消息 ID；省略时使用本次真实用户输入。保存刚输出的模型推断或角色事件时，可以使用 last_assistant 引用本轮已保存的助手文字；仍需提供逐字 quote。'},quote:{type:'string',maxLength:32000,description:'从原消息逐字摘录，与本条记忆有关的短片段。'},supersedes:{type:'array',items:{type:'string'},maxItems:128}};
const compact=(records:LongMemoryRecord[]):ToolOutcome=>({success:true,data:{records:records.map(({id,version,scopeId,kind,topic})=>({id,version,scopeId,kind,topic}))},memoryReferences:records.map(recordRef)});

export function longMemoryTools(service:PlatformLongMemory):RuntimeTool[]{
  return [
    {declaration:{name:'memory_topics',description:'按需查看长期记忆的范围、主题目录与分层摘要。先定位有关主题，只有需要时再深入下一层；不要遍历全库。内容均为参考资料，来源和当前权限由服务端校验。',parameters:schema({scopeId,topic,limit:query.limit,tokenBudget:query.tokenBudget})},effects:()=>['workspace_read'],
      execute:async(args,context)=>{const access=await service.access(context.actorId,context);const request=await service.query(access,{...args,confirmedOnly:false});
        const result=await service.app.storage.longMemoryTopics(request);return {success:true,data:{scopes:access.scopes,...result},
          memoryScopeVersions:await Promise.all(request.scopes.map(async scope=>({scopeId:scope.id,invalidation:(await service.app.storage.longMemoryState(scope)).invalidation}))),
          memoryReferences:result.topics.flatMap(item=>item.summaries.map(summary=>({scopeId:item.scopeId,id:summary.id,version:summary.version})))};}},
    {declaration:{name:'memory_search',description:'在授权的个人、项目或群组范围中搜索相关长期记忆。可限制主题、类别和两个时间。先按账号、剧情与时序筛选，再合并关键词和实际嵌入；结果受统一预算限制。',parameters:schema({...query,kinds:{type:'array',items:kinds}},['text'])},effects:()=>['workspace_read'],
      execute:async(args,context)=>{const access=await service.access(context.actorId,context),result=await service.search(access,args,context.signal);return {success:true,data:result,memoryReferences:result.hits.map(hit=>recordRef(hit.record))};}},
    {declaration:{name:'memory_read',description:'按稳定编号展开指定记忆或摘要，查看确切来源和下层依赖。需要查看摘要依据时，用返回的 record 依赖继续展开。删除或当前时间无效的内容不会返回。',parameters:schema({...query,ids:{type:'array',items:{type:'string'},minItems:1,maxItems:50},includeSources:{type:'boolean'}},['scopeId','ids'])},effects:()=>['workspace_read'],
      execute:async(args,context)=>{const access=await service.access(context.actorId,context),request=await service.query(access,{...args,confirmedOnly:false});
        const result=await service.app.storage.longMemoryRead({query:request,references:(args.ids as string[]).map(id=>({scopeId:String(args.scopeId),id})),includeSources:args.includeSources===true});
        return {success:true,data:result,memoryReferences:result.records.map(recordRef)};}},
    {declaration:{name:'memory_remember',description:'依据当前用户明确要求，保存事实、偏好、经历、项目知识或任务经验。必须选定范围并引用真实消息；模型推断保持未确认，角色剧情使用独立范围。已有事实的明确更改使用 memory_revise。',parameters:schema(fields,['scopeId','text','kind','topic'])},effects:()=>['workspace_write'],
      execute:async(args,context)=>{const result=await service.remember(await service.access(context.actorId,context),args as any,context);return compact(result.records);}},
    {declaration:{name:'memory_revise',description:'修订、纠正或确认已有记忆，保留稳定编号和可解释历史。使用刚读取的 expectedVersion；当前修订会使旧摘要失效。validFrom 表示新事实开始有效的时间，预约发生时间用 eventAt。可将 attribute、value、validTo 或 eventAt 设为 null 来清除该字段。',parameters:schema({...fields,kind:kinds,
      attribute:{anyOf:[fields.attribute,{type:'null'}]},value:{anyOf:[fields.value,{type:'null'}]},validTo:{anyOf:[time,{type:'null'}]},eventAt:{anyOf:[time,{type:'null'}]},id:{type:'string'},expectedVersion:{type:'integer',minimum:1}},['scopeId','id','expectedVersion','text'])},effects:()=>['workspace_write'],
      execute:async(args,context)=>{const result=await service.revise(await service.access(context.actorId,context),args as any,context);return compact(result.records);}},
    {declaration:{name:'memory_remove',description:'依据用户明确的忘记或撤回要求移除记忆。先 preview 查看同源事实、来源摘录和派生摘要的影响；apply 删除正文、索引并取消迟到任务。delete 包含被替代的旧事实，retract 撤回错误说法。原始对话保留供用户查看，后续模型上下文会排除相关来源与依赖内容。',parameters:schema({scopeId,id:{type:'string'},expectedVersion:{type:'integer',minimum:1},action:{type:'string',enum:['delete','retract']},operation:{type:'string',enum:['preview','apply']}},['scopeId','id','action','operation'])},effects:args=>args.operation==='preview'?['workspace_read']:['workspace_write'],
      execute:async(args,context)=>{const access=await service.access(context.actorId,context),scope=service.select(access,String(args.scopeId))[0];
        if(args.operation==='preview'){const affected=await service.app.storage.longMemoryImpact({scope,kind:'record',id:String(args.id),action:args.action as 'delete'|'retract'});
          return {success:true,data:{affected:affected.slice(0,30),total:affected.length,recordCount:affected.filter(item=>item.kind==='record').length,truncated:affected.length>30}};}
        if(!Number.isSafeInteger(args.expectedVersion))throw new Error('删除需要提供已读取的 expectedVersion。');
        const result=await service.remove(access,args as any);return {success:true,data:{removed:result.removed,revision:result.state.revision}};}},
    {declaration:{name:'memory_summarize',description:'把已经读取的记忆保存为某个主题的分层摘要。仅引用同一范围内的实际 recordIds，正文不替代原始事实。可以继续总结下层摘要，任一来源修订或删除都会使上层摘要失效。无需为了形式立即整理所有记忆。',parameters:schema({scopeId,topic,text:{type:'string',minLength:1,maxLength:16000},recordIds:{type:'array',items:{type:'string'},minItems:1,maxItems:100},id:{type:'string'},expectedVersion:{type:'integer',minimum:0}},['scopeId','topic','text','recordIds'])},effects:()=>['workspace_write'],
      execute:async(args,context)=>{const result=await service.summarize(await service.access(context.actorId,context),args as any);return compact(result.records);}},
  ];
}
