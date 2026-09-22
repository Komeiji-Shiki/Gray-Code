import type { LongMemoryArchive,LongMemoryPolicy,LongMemoryScope } from '@graycode/contracts';
import type { PlatformApplication } from '../application';
import type { ClientSession } from './router';
import { importFileChunk, importLibraryFiles, importSourceFiles, listImportLibraries, setImportRecall } from '../memory/imports/library';

export async function longMemoryRequest(app:PlatformApplication,session:ClientSession,method:string,params:Record<string,any>){
  app.requireOwner(session.actorId);
  const service=app.longMemory;
  if (method.startsWith('memory.import.')) {
    switch (method) {
      case 'memory.import.list': return listImportLibraries(app.storage, session.actorId);
      case 'memory.import.files': return importLibraryFiles(app.storage, session.actorId, params.id, params);
      case 'memory.import.chunk': return importFileChunk(app.storage, session.actorId, params.id, params.fileId, params.index);
      case 'memory.import.source': return importSourceFiles(app.storage, session.actorId, params.id, params.sourceId);
      case 'memory.import.recall': {
        const result = await setImportRecall(app.storage, session.actorId, params.id, params.enabled);
        service.changed(result.scopeId, true); app.publish({ type: 'memory.import.changed' }); return result;
      }
      default: throw new Error('未知导入资料库操作。');
    }
  }
  const context={conversationId:typeof params.conversationId==='string'?params.conversationId:undefined,workspaceId:typeof params.workspaceId==='string'?params.workspaceId:undefined};
  if(method==='memory.options'){
    const [scopes,policy,imports]=await Promise.all([service.scopesForManagement(session.actorId,context),service.policies.get(session.actorId),listImportLibraries(app.storage,session.actorId)]);
    const settings=app.settings.snapshot().settings;
    const label=(scope:LongMemoryScope)=>scope.kind==='personal'?'个人':scope.kind==='group'?'群组 · '+scope.key:scope.kind==='library'?'导入资料库':'项目 · '+(settings.workspaces.find(workspace=>workspace.directory.replaceAll('\\','/').toLowerCase()===scope.key?.replaceAll('\\','/').toLowerCase())?.name??scope.key);
    return {scopes:scopes.map(scope=>({...scope,label:imports.find(item=>item.scopeId===scope.id)?.name??(label(scope)+(scope.realm==='real'?'':' · 角色剧情'))})),policy,
      providers:settings.providers.map(provider=>({id:provider.id,name:provider.name,model:provider.model,models:provider.models.map(model=>model.id)}))};
  }
  if(method==='memory.policy.save'){
    const result=await service.policies.save(session.actorId,params.value as LongMemoryPolicy,params.expectedRevision,params.embeddingCredential);
    service.embeddings.clear();app.publish({type:'memory.policy.changed'});return result;
  }
  if(method==='memory.restore'){
    const result=await app.storage.longMemoryRestore({actorId:session.actorId,archive:params.archive as LongMemoryArchive});
    service.embeddings.clear();for(const scope of await service.scopesForManagement(session.actorId))service.changed(scope.id,true);return result;
  }
  const access=await service.managementAccess(session.actorId,params.scopeId,context);
  const selected=()=>{if(!params.scopeId)throw new Error('请先选择记忆范围。');return service.select(access,params.scopeId)[0];};
  switch(method){
    case 'memory.search':return service.search(access,{...params,kinds:params.kinds??['fact','preference','experience','project','procedure','event','summary'],confirmedOnly:false,limit:params.limit??50,tokenBudget:params.tokenBudget??16000});
    case 'memory.topics':return app.storage.longMemoryTopics({...await service.query(access,{...params,text:undefined,confirmedOnly:false,limit:50,tokenBudget:4000}),cursor:params.cursor});
    case 'memory.get':return app.storage.longMemoryInspect({scope:selected(),id:params.id});
    case 'memory.graph':return app.storage.longMemoryGraph({scope:selected(),id:params.id,version:params.version,limit:params.limit});
    case 'memory.remember':return service.remember(access,params as any);
    case 'memory.revise':return service.revise(access,params as any);
    case 'memory.summarize':return service.summarize(access,params as any);
    case 'memory.impact':{
      const scope=selected(),affected=await app.storage.longMemoryImpact({scope,kind:'record',id:params.id,action:params.action??'delete'});
      const records=affected.filter(item=>item.kind==='record'),preview=await app.storage.longMemoryRecordVersions({scope,references:records.slice(0,20).map(item=>({id:item.id}))});
      return {recordCount:records.length,sourceCount:affected.filter(item=>item.kind==='source').length,
        items:preview.map(record=>({id:record.id,kind:record.kind,text:record.text.slice(0,160)})),truncated:records.length>preview.length};
    }
    case 'memory.remove':return service.remove(access,{...params,action:params.action??'delete'} as any);
    case 'memory.export':return app.storage.longMemoryExport([selected()]);
    case 'memory.jobs':return app.storage.longMemoryJobs({scopes:access.scopes,status:params.status});
    case 'memory.job.cancel':return service.background.cancel(selected(),params.id);
    case 'memory.job.retry':{const scope=selected(),job=await app.storage.longMemoryJobTransition({scope,id:params.id,action:'retry'});service.background.kick(scope);return job;}
    case 'memory.extract':return service.background.enqueueConversation(session.actorId,params.conversationId,selected().id);
    case 'memory.summary.queue':return service.background.enqueueSummary(session.actorId,selected(),params.recordIds,params.topic,params.id,params.expectedVersion);
    case 'memory.embedding.test':{
      const policy=(await service.policies.get(session.actorId)).value;if(!policy.embedding)throw new Error('请先保存嵌入服务地址和模型。');
      const result=await service.embeddings.embed(session.actorId,policy.embedding,['这是记忆服务的连接测试。'],new AbortController().signal);
      return {model:policy.embedding.model,dimensions:result.vectors[0].dimensions,usage:result.usage};
    }
    case 'memory.index.rebuild':{
      const scope=selected(),policy=(await service.policies.get(scope.actorId)).value;if(!policy.embedding)throw new Error('请先配置嵌入服务。');
      const archive=await app.storage.longMemoryExport([scope]);
      service.index(scope,archive.records);return {queued:archive.records.length};
    }
    default:throw new Error('未知长期记忆操作。');
  }
}
