import {PlatformStorage} from '@graycode/core';

/** 在实际切换前读取最新删除状态，覆盖准备备份恢复之后发生的删除。 */
export async function preserveMemoryDeletions(currentDirectory:string,restoredDirectory:string):Promise<void>{
  const current=await PlatformStorage.open(currentDirectory);
  try{
    const state=await current.longMemoryDeletionState();if(!state.scopes.length)return;
    const restored=await PlatformStorage.open(restoredDirectory);
    try{
      for(const actorId of new Set(state.scopes.map(scope=>scope.actorId))){
        const owned=state.scopes.filter(scope=>scope.actorId===actorId);
        for(let offset=0;offset<owned.length;offset+=128){
          const scopes=owned.slice(offset,offset+128),ids=new Set(scopes.map(scope=>scope.id));
          await restored.longMemoryRestore({actorId,archive:{format:'graycode-long-memory',version:1,createdAt:Date.now(),scopes,
            sources:[],records:[],tombstones:state.tombstones.filter(tomb=>ids.has(tomb.scopeId))}});
        }
      }
      await restored.checkpoint();
    }finally{await restored.close();}
  }finally{await current.close();}
}
