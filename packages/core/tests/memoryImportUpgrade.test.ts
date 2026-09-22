import { MEMORY_IMPORT_NAMESPACE, type MemoryImportDataset, type LongMemoryRecordInput, type LongMemoryScope } from '@graycode/contracts';
import { longMemoryScope } from '../../../apps/server/src/memory/longTerm/scopes';
import { upgradeLifeBookGraphAssociations } from '../../../apps/server/src/memory/imports/upgrades';
import { fixture } from './fixtures';

describe('旧导入图谱的关联修正',()=>{
  let f:Awaited<ReturnType<typeof fixture>>,scope:LongMemoryScope;
  const id='f'.repeat(64);
  const row=(recordId:string,topic:string[],dependencies:LongMemoryRecordInput['dependencies'],extra:Partial<LongMemoryRecordInput>={}):LongMemoryRecordInput=>({
    id:recordId,expectedVersion:0,kind:'fact',origin:'import',confidence:'inferred',subject:'合成实体',text:`原文 ${recordId}`,topic,entities:[],recordedAt:2,validFrom:2,dependencies,supersedes:[],...extra,
  });
  beforeEach(async()=>{
    f=await fixture();scope=longMemoryScope('owner','library','real',id);
    await f.store.longMemoryWrite({scope,sources:['entity-source','fact-source','edited-source'].map(id=>({id,text:`原始来源 ${id}`,origin:'import' as const,expectedVersion:0,recordedAt:1})),records:[
      row('entity',['LifeBook','图谱实体','合成实体'],[{kind:'source',id:'entity-source',version:1}]),
      row('fact',['LifeBook','图谱关系','关系'],[{kind:'source',id:'fact-source',version:1},{kind:'record',id:'entity',version:1}]),
      row('edited',['LifeBook','图谱关系','关系'],[{kind:'source',id:'edited-source',version:1},{kind:'record',id:'entity',version:1}]),
    ]});
    const data:MemoryImportDataset={id,actorId:'owner',name:'合成旧图谱',scopeId:scope.id,fingerprint:'fixture',format:'lifebook',version:1,importedAt:3,
      files:[],originalFileCount:0,bytes:0,records:3,sources:3,segments:[],attachments:[],notes:[],graph:{entities:1,facts:2,episodes:0,connections:2}};
    await f.store.putRecord({namespace:MEMORY_IMPORT_NAMESPACE,id,ownerId:'owner',value:data});
  });
  afterEach(async()=>{await f.cleanup();});

  test('以后续修订修正关联，保留人工编辑和已存在的嵌入，重复执行无新增',async()=>{
    const edited=(await f.store.longMemoryRevisions({scope,id:'edited'}))[0];
    await f.store.longMemoryWrite({scope,records:[{...edited,expectedVersion:1,text:'人工已经修改',origin:'user',confidence:'confirmed',recordedAt:3}]});
    await f.store.longMemoryVector({scope,id:'fact',version:1,vector:{model:'fixture',dimensions:2,values:[1,0]}});
    expect(await upgradeLifeBookGraphAssociations(f.store,id)).toEqual({revised:1,edited:1});
    const revised=await f.store.longMemoryRevisions({scope,id:'fact'});
    expect(revised.map(row=>row.version)).toEqual([2,1]);expect(revised[0].text).toBe(revised[1].text);
    expect(revised[0].dependencies.find(ref=>ref.id==='entity')?.association).toBe(true);
    expect((await f.store.longMemoryRevisions({scope,id:'edited'}))[0].text).toBe('人工已经修改');
    const recall=await f.store.longMemoryRecall({scopes:[scope],text:'not-matching-token',asOf:Date.now(),knownAt:Date.now(),confirmedOnly:false,limit:10,tokenBudget:16000,vector:{model:'fixture',dimensions:2,values:[1,0]}});
    expect(recall.hits.map(hit=>[hit.record.id,hit.record.version])).toContainEqual(['fact',2]);
    expect(await upgradeLifeBookGraphAssociations(f.store,id)).toEqual({revised:0,edited:0});
    const entity=(await f.store.longMemoryRevisions({scope,id:'entity'}))[0];
    await f.store.longMemoryWrite({scope,records:[{...entity,expectedVersion:1,confidence:'confirmed',recordedAt:Date.now()}]});
    expect((await f.store.longMemoryBrowse({scope})).items.some(item=>item.id==='fact')).toBe(true);
    const graph=await f.store.longMemoryGraph({scope,id:'fact'});
    expect(graph.nodes.find(node=>node.id==='entity')).toMatchObject({side:'related',version:2});expect(graph.edges.some(edge=>edge.association)).toBe(true);
    expect((await f.store.longMemoryInspect({scope,id:'fact'})).relations.map(record=>record.id)).toEqual(['entity']);
    expect(await f.store.longMemoryImpact({scope,kind:'record',id:'entity',action:'delete'})).toEqual(expect.arrayContaining([{kind:'record',id:'fact'}]));
  });

  test('关联不能单独充当事实或任务依据，正文变化时不会复制旧向量',async()=>{
    await expect(f.store.longMemoryWrite({scope,records:[row('unsupported',['测试'],[{kind:'record',id:'entity',version:1,association:true}])]})).rejects.toThrow('不能代替');
    await expect(f.store.longMemoryEnqueue({scope,job:{id:'invalid-job',scopeId:scope.id,kind:'summarize',status:'pending',dependencies:[{kind:'record',id:'entity',version:1,association:true}],providerId:'fixture',createdAt:3,updatedAt:3,attempts:0}})).rejects.toThrow('确切来源');
    const archive=await f.store.longMemoryExport([scope]),fact=archive.records.find(record=>record.id==='fact')!;
    await expect(f.store.longMemoryRestore({actorId:'owner',archive:{...archive,sources:[],records:[{...fact,version:2,text:'内容已经改变'}]},copyVectors:[{scopeId:scope.id,id:'fact',from:1,to:2}]})).rejects.toThrow('正文相同');
    expect((await f.store.longMemoryRevisions({scope,id:'fact'})).map(record=>record.version)).toEqual([1]);
  });
});
