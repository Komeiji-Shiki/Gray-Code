import type { RuntimeTool } from '@graycode/core';
import type { LongMemoryRecord, ToolOutcome } from '@graycode/contracts';
import type { PlatformLongMemory } from './service';
import { recordRef } from './content';

const scopeId={type:'string',description:'工具返回过的授权 scopeId。'};
const topic={type:'array',items:{type:'string',maxLength:120},maxItems:8,description:'从宽到窄的主题路径，例如 ["项目","晴川","部署"]。'};
const kinds={type:'string',enum:['fact','preference','experience','project','procedure','event','summary']};
const time={type:'number',description:'UTC Unix 毫秒时间戳；没有明确的时间依据时省略。'};
const schema=(properties:Record<string,unknown>,required:string[]=[])=>({type:'object',properties,required,additionalProperties:false});
const query={scopeId,topic,text:{type:'string',maxLength:32000},asOf:time,knownAt:time,
  limit:{type:'integer',minimum:1,maximum:50},tokenBudget:{type:'integer',minimum:256,maximum:16000},confirmedOnly:{type:'boolean'}};
const fields={scopeId,text:{type:'string',minLength:1,maxLength:32000},kind:{...kinds,enum:kinds.enum.filter(kind=>kind!=='summary')},subject:{type:'string',maxLength:512},
  attribute:{type:'string',maxLength:256},value:{type:'string',maxLength:4000},topic,entities:{type:'array',items:{type:'string'},maxItems:64},
  validFrom:time,validTo:time,eventAt:time,confidence:{type:'string',enum:['confirmed','inferred','disputed']},
  sourceMessageId:{type:'string',description:'本会话中的原消息 ID，省略时为本轮用户输入。填 last_assistant 表示引用本轮已保存的模型文字，此时必须提供逐字的 quote。'},quote:{type:'string',maxLength:32000,description:'原消息中相关片段的逐字摘录。'},supersedes:{type:'array',items:{type:'string'},maxItems:128}};
const compact=(records:LongMemoryRecord[]):ToolOutcome=>({success:true,data:{records:records.map(({id,version,scopeId,kind,topic})=>({id,version,scopeId,kind,topic}))},memoryReferences:records.map(recordRef)});

export function longMemoryTools(service:PlatformLongMemory):RuntimeTool[]{
  return [
    {declaration:{name:'memory_topics',description:'查看可访问的记忆范围、主题目录和摘要。先定位相关主题再逐层深入，不要遍历全库；返回 nextCursor 时，把它作为 cursor 传入即可继续读取当前层。来源和权限由服务端校验。',parameters:schema({scopeId,topic,limit:query.limit,tokenBudget:query.tokenBudget,cursor:{type:'string',maxLength:512,description:'上一页返回的 nextCursor；使用时保持原来的主题和范围。'}})},effects:()=>['workspace_read'],
      execute:async(args,context)=>{const access=await service.access(context.actorId,context);const request=await service.query(access,{...args,confirmedOnly:false});
        const result=await service.app.storage.longMemoryTopics({...request,cursor:args.cursor as string|undefined});return {success:true,data:{...(!args.cursor?{scopes:access.scopes}:{}),...result},
          memoryScopeVersions:await Promise.all(request.scopes.map(async scope=>({scopeId:scope.id,invalidation:(await service.app.storage.longMemoryState(scope)).invalidation}))),
          memoryReferences:result.topics.flatMap(item=>item.summaries.map(summary=>({scopeId:item.scopeId,id:summary.id,version:summary.version})))};}},
    {declaration:{name:'memory_search',description:'在可访问的记忆范围内搜索，可按主题、类别以及 asOf、knownAt 两个时间筛选。结果先按账号、剧情和时序过滤，再合并关键词与语义匹配，总量受 tokenBudget 限制。',parameters:schema({...query,kinds:{type:'array',items:kinds}},['text'])},effects:()=>['workspace_read'],
      execute:async(args,context)=>{const access=await service.access(context.actorId,context),result=await service.search(access,args,context.signal);return {success:true,data:result,memoryReferences:result.hits.map(hit=>recordRef(hit.record))};}},
    {declaration:{name:'memory_read',description:'按 ids 读取记忆，includeSources=true 时附带来源。正文过长时用 page 分段读取，其中 sourceId 指定要读的来源；返回 nextOffset 时，保持同一 version、把它作为 offset 传入即可继续读取。结果中出现 omitted 或 requiredTokenBudget 说明预算不足；已失效的内容不会返回。',parameters:{...schema({...query,ids:{type:'array',items:{type:'string'},minItems:1,maxItems:50},includeSources:{type:'boolean'},
      page:schema({id:{type:'string'},version:{type:'integer',minimum:1},sourceId:{type:'string'},offset:{type:'integer',minimum:0}},['id','version'])},['scopeId']),oneOf:[{required:['ids']},{required:['page']}]}},effects:()=>['workspace_read'],
      execute:async(args,context)=>{const access=await service.access(context.actorId,context),request=await service.query(access,{...args,confirmedOnly:false});
        const page=args.page as {id:string;version:number;sourceId?:string;offset?:number}|undefined;
        const result=await service.app.storage.longMemoryRead({query:request,references:((args.ids??[]) as string[]).map(id=>({scopeId:String(args.scopeId),id})),includeSources:args.includeSources===true,
          ...(page?{page:{record:{scopeId:String(args.scopeId),id:page.id,version:page.version},sourceId:page.sourceId,offset:page.offset}}:{})});
        return {success:true,data:result,memoryReferences:[...result.records.map(recordRef),...(result.page?[recordRef(result.page.record)]:[])]};}},
    {declaration:{name:'memory_remember',description:'按当前用户的明确要求保存事实、偏好、经历、项目知识或任务经验。必须选定范围并引用真实消息；模型自己的推断保持未确认状态，角色剧情使用独立的范围。要明确修改已有事实时用 memory_revise。',parameters:schema(fields,['scopeId','text','kind','topic'])},effects:()=>['workspace_write'],
      execute:async(args,context)=>{const result=await service.remember(await service.access(context.actorId,context),args as any,context);return compact(result.records);}},
    {declaration:{name:'memory_revise',description:'修订已读取的记忆，保留编号和历史，需要传入当前的 expectedVersion。三种修改方式任选其一：用唯一匹配的 oldText/newText 局部替换，用 append 追加，或用 text 替换全文。来源要求与 memory_remember 相同；修订后旧摘要会失效。validFrom 是事实生效的时间，eventAt 是事件发生的时间；attribute、value、validTo、eventAt 可设为 null 清除。',parameters:{...schema({...fields,kind:kinds,
      oldText:{type:'string',minLength:1,maxLength:32000,description:'原文中只出现一次的连续片段。'},newText:{type:'string',maxLength:32000,description:'替换后的文字，空字符串表示删除该片段。'},append:{type:'string',minLength:1,maxLength:32000,description:'追加到末尾的文字，需要换行时自行包含换行符。'},
      attribute:{anyOf:[fields.attribute,{type:'null'}]},value:{anyOf:[fields.value,{type:'null'}]},validTo:{anyOf:[time,{type:'null'}]},eventAt:{anyOf:[time,{type:'null'}]},id:{type:'string'},expectedVersion:{type:'integer',minimum:1}},['scopeId','id','expectedVersion']),anyOf:[{required:['text']},{required:['oldText','newText']},{required:['append']}]}},effects:()=>['workspace_write'],
      execute:async(args,context)=>{const result=await service.revise(await service.access(context.actorId,context),args as any,context);return compact(result.records);}},
    {declaration:{name:'memory_remove',description:'按用户明确的忘记或撤回要求移除记忆。先用 operation=preview 查看对同源事实、来源摘录和派生摘要的影响，再用 apply 删除正文和索引，并取消之后才会完成的相关后台任务。action=delete 会连同被取代的旧事实一起删除，retract 用于撤回错误说法。原始对话仍保留供用户查看，但之后的模型上下文会排除相关来源及依赖它们的内容。',parameters:schema({scopeId,id:{type:'string'},expectedVersion:{type:'integer',minimum:1},action:{type:'string',enum:['delete','retract']},operation:{type:'string',enum:['preview','apply']}},['scopeId','id','action','operation'])},effects:args=>args.operation==='preview'?['workspace_read']:['workspace_write'],
      execute:async(args,context)=>{const access=await service.access(context.actorId,context),scope=service.select(access,String(args.scopeId))[0];
        if(args.operation==='preview'){const affected=await service.app.storage.longMemoryImpact({scope,kind:'record',id:String(args.id),action:args.action as 'delete'|'retract'});
          return {success:true,data:{affected:affected.slice(0,30),total:affected.length,recordCount:affected.filter(item=>item.kind==='record').length,truncated:affected.length>30}};}
        if(!Number.isSafeInteger(args.expectedVersion))throw new Error('删除需要提供已读取的 expectedVersion。');
        const result=await service.remove(access,args as any);return {success:true,data:{removed:result.removed,revision:result.state.revision}};}},
    {declaration:{name:'memory_summarize',description:'把已经读取的记忆保存为某个主题的分层摘要。recordIds 只能引用同一范围内实际存在的记录，摘要不替代原始事实。可以再对下层摘要做总结，但任何来源被修订或删除都会使上层摘要失效。不必为了形式立即整理所有记忆。',parameters:schema({scopeId,topic,text:{type:'string',minLength:1,maxLength:16000},recordIds:{type:'array',items:{type:'string'},minItems:1,maxItems:100},id:{type:'string'},expectedVersion:{type:'integer',minimum:0}},['scopeId','topic','text','recordIds'])},effects:()=>['workspace_write'],
      execute:async(args,context)=>{const result=await service.summarize(await service.access(context.actorId,context),args as any);return compact(result.records);}},
  ];
}
