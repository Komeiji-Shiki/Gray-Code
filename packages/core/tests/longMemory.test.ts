import { PlatformStorage } from '@graycode/core';
import type { LongMemoryScope, LongMemoryQuery, LongMemoryRecordInput, LongMemoryJob, LongMemorySourceInput } from '@graycode/contracts';
import { fixture } from './fixtures';

const scope: LongMemoryScope = { id:'long-memory-owner-real',actorId:'owner',kind:'personal',realm:'real' };
const time=(date:string)=>Date.parse(date+'T00:00:00Z');
const source=(id:string,text:string,recordedAt=time('2026-07-01')):LongMemorySourceInput=>({id,text,origin:'user',expectedVersion:0,recordedAt});
const record=(id:string,text:string,sourceId=id+'-source',extra:Partial<LongMemoryRecordInput>={}):LongMemoryRecordInput=>({
  id,text,kind:'fact',origin:'user',confidence:'confirmed',subject:'虚构测试用户',topic:['个人','住址'],entities:[],
  expectedVersion:0,recordedAt:time('2026-07-01'),validFrom:time('2026-07-01'),dependencies:[{kind:'source',id:sourceId,version:1}],supersedes:[],...extra,
});
const query=(extra:Partial<LongMemoryQuery>={}):LongMemoryQuery=>({scopes:[scope],text:'住址 城市',asOf:time('2026-09-13'),knownAt:time('2026-09-13'),limit:5,tokenBudget:1800,confirmedOnly:true,...extra});

describe('统一长期记忆的实际存储 worker',()=>{
  let f:Awaited<ReturnType<typeof fixture>>;
  beforeEach(async()=>{f=await fixture();});
  afterEach(async()=>{await f.cleanup();});
  const add=async(text='当前住址是上海。')=>f.store.longMemoryWrite({scope,sources:[source('city-source',text)],records:[record('city',text)]});

  test('有效时间和得知时间分别选择修订，摘要按确切来源递归失效',async()=>{
    await add();
    await f.store.longMemoryWrite({scope,records:[
      record('summary-one','住址摘要：上海。','',{kind:'summary',dependencies:[{kind:'record',id:'city',version:1}],topic:['个人','住址']}),
      record('summary-two','个人摘要：居住上海。','',{kind:'summary',dependencies:[{kind:'record',id:'summary-one',version:1}],topic:['个人']}),
    ]});
    expect((await f.store.longMemoryTopics(query({topic:[],text:undefined}))).topics[0].summaries[0].id).toBe('summary-two');
    await f.store.longMemoryWrite({scope,sources:[source('move-source','八月十二日已经搬到杭州。',time('2026-09-03'))],records:[
      record('city','当前住址是杭州。','move-source',{expectedVersion:1,recordedAt:time('2026-09-03'),validFrom:time('2026-08-12')})]});
    expect((await f.store.longMemoryRecall(query())).hits.map(hit=>hit.record.id)).toEqual(['city']);
    const knownThen=await f.store.longMemoryRecall(query({asOf:time('2026-08-20'),knownAt:time('2026-08-20')}));
    expect(knownThen.hits.find(hit=>hit.record.id==='city')?.record.text).toContain('上海');
    const currentKnowledge=await f.store.longMemoryRecall(query({asOf:time('2026-08-20')}));
    expect(currentKnowledge.hits.find(hit=>hit.record.id==='city')?.record.text).toContain('杭州');
    expect((await f.store.longMemoryTopics(query({text:undefined}))).topics[0].summaries).toEqual([]);
  });

  test('来源删除清除多层派生、拒绝迟到写回，旧归档和重启不能复活',async()=>{
    await add();
    await f.store.longMemoryWrite({scope,records:[record('summary','住址摘要：上海。','',{kind:'summary',dependencies:[{kind:'record',id:'city',version:1}]})]});
    const job:LongMemoryJob={id:'extract-old',scopeId:scope.id,kind:'extract',status:'pending',dependencies:[{kind:'source',id:'city-source',version:1}],providerId:'fixture',createdAt:1,updatedAt:1,attempts:0};
    await f.store.longMemoryEnqueue({scope,job});await f.store.longMemoryJobTransition({scope,id:job.id,action:'start'});
    const backup=await f.store.longMemoryExport([scope]);
    await f.store.longMemoryWrite({scope,remove:[{kind:'source',id:'city-source',action:'delete',expectedVersion:1}]});
    const finish=await f.store.longMemoryJobFinish({scope,id:job.id,write:{scope,records:[record('late','住址：上海。','city-source')]},usage:{input:10,output:2,total:12}});
    expect(finish.applied).toBe(false);expect(finish.job?.status).toBe('cancelled');expect(finish.job?.usage?.total).toBe(12);
    await f.store.longMemoryRestore({actorId:'owner',archive:backup});
    expect(JSON.stringify(await f.store.longMemoryExport([scope]))).not.toContain('上海');
    await f.store.close();f.store=await PlatformStorage.open(f.data);
    expect((await f.store.longMemoryRecall(query())).hits).toEqual([]);
    expect((await f.store.longMemoryJobs({scopes:[scope]}))[0].status).toBe('cancelled');
  });

  test('相同昵称不合并账号和剧情，冲突并列而不按最新时间默选',async()=>{
    await add();
    const fiction={...scope,id:'fiction',realm:'character:test'};
    await f.store.longMemoryWrite({scope:fiction,sources:[{...source('fiction-source','住址是月宫。'),origin:'fiction'}],records:[record('fiction-home','住址是月宫。','fiction-source',{origin:'fiction'})]});
    await expect(f.store.longMemoryRecall(query({scopes:[{...scope,actorId:'someone-else'}]}))).rejects.toMatchObject({code:'INVALID_INPUT'});
    await expect(f.store.longMemoryRecall(query({scopes:[scope,fiction]}))).rejects.toMatchObject({code:'INVALID_INPUT'});
    await f.store.longMemoryWrite({scope,sources:[source('a-source','饮料偏好是红茶。'),source('b-source','饮料偏好是咖啡。')],records:[
      record('a','饮料偏好是红茶。','a-source',{attribute:'饮料',value:'红茶'}),record('b','饮料偏好是咖啡。','b-source',{attribute:'饮料',value:'咖啡'})]});
    const recalled=await f.store.longMemoryRecall(query({text:'饮料偏好'}));
    expect(recalled.hits.find(hit=>hit.record.id==='a')?.conflicts).toEqual(['b']);
    expect((await f.store.longMemoryRecall(query())).hits.every(hit=>hit.record.origin!=='fiction')).toBe(true);
  });

  test('主题目录和按需展开遵守预算，语义向量按模型和维度匹配',async()=>{
    await add();
    const sources=Array.from({length:45},(_,i)=>source('project-source-'+i,`测试项目条目 ${i} 的配置说明。`));
    const records=sources.map((value,i)=>record('project-'+i,value.text,value.id,{topic:['项目','项目'+i],vector:{model:'fixture-two-dimensional',dimensions:2,values:[1,0]}}));
    await f.store.longMemoryWrite({scope,sources,records});
    const topics=await f.store.longMemoryTopics(query({topic:['项目'],text:undefined,limit:8,tokenBudget:300}));
    expect(topics.topics.length).toBeLessThanOrEqual(8);expect(topics.estimatedTokens).toBeLessThanOrEqual(300);expect(topics.truncated).toBe(true);
    const result=await f.store.longMemoryRecall(query({text:'不存在的同义词',limit:3,tokenBudget:700,vector:{model:'fixture-two-dimensional',dimensions:2,values:[1,0]}}));
    expect(result.method).toBe('hybrid');expect(result.hits).toHaveLength(3);expect(result.estimatedTokens).toBeLessThanOrEqual(700);
    expect((await f.store.longMemoryRecall(query({text:'不存在的同义词',vector:{model:'another-model',dimensions:2,values:[1,0]}}))).hits).toEqual([]);
    const expanded=await f.store.longMemoryRead({query:query({limit:1,tokenBudget:350}),references:result.hits.map(hit=>({scopeId:scope.id,id:hit.record.id})),includeSources:true});
    expect(expanded.records.length).toBeLessThanOrEqual(1);expect(expanded.estimatedTokens).toBeLessThanOrEqual(350);
  });

  test('批量失败原子回滚，重试幂等，交换归档可重建关键词索引',async()=>{
    const written=await add();const again=await add();expect(again.state.revision).toBe(written.state.revision);
    await expect(f.store.longMemoryWrite({scope,sources:[source('rollback-source','不应留下。')],records:[record('bad','无效来源。','missing')]})).rejects.toMatchObject({code:'SOURCE_CHANGED'});
    const archive=await f.store.longMemoryExport([scope]);expect(archive.sources.some(item=>item.id==='rollback-source')).toBe(false);
    const other=await fixture();
    try{
      await other.store.longMemoryRestore({actorId:'owner',archive});
      expect((await other.store.longMemoryRecall(query())).hits[0].record.text).toContain('上海');
      await expect(other.store.longMemoryRestore({actorId:'another',archive})).rejects.toMatchObject({code:'INVALID_INPUT'});
      expect((await other.store.verify()).ok).toBe(true);
    }finally{await other.cleanup();}
  });

  test('运行中任务重启标为中断，不能静默重复发送收费请求',async()=>{
    await add();
    const job:LongMemoryJob={id:'request-was-sent',scopeId:scope.id,kind:'extract',status:'pending',dependencies:[{kind:'source',id:'city-source',version:1}],providerId:'fixture',createdAt:1,updatedAt:1,attempts:0};
    await f.store.longMemoryEnqueue({scope,job});await f.store.longMemoryJobTransition({scope,id:job.id,action:'start'});
    await f.store.close();f.store=await PlatformStorage.open(f.data);
    expect((await f.store.longMemoryJobs({scopes:[scope]}))[0]).toMatchObject({status:'interrupted',attempts:1});
    expect(await f.store.longMemoryJobTransition({scope,id:job.id,action:'start'})).toBeNull();
    expect((await f.store.longMemoryJobTransition({scope,id:job.id,action:'retry'}))?.status).toBe('pending');
  });

  test('显式替代使多层摘要失效，忘记当前事实也清除旧事实与来源摘录',async()=>{
    await add();
    await f.store.longMemoryWrite({scope,records:[
      record('summary-old','住址摘要：上海。','',{kind:'summary',dependencies:[{kind:'record',id:'city',version:1}]}),
      record('summary-parent','个人住址概要：上海。','',{kind:'summary',dependencies:[{kind:'record',id:'summary-old',version:1}]}),
    ]});
    await f.store.longMemoryWrite({scope,sources:[source('move-source','目前住杭州。')],records:[record('new-city','目前住址是杭州。','move-source',{supersedes:['city']})]});
    expect((await f.store.longMemoryRecall(query())).hits.map(hit=>hit.record.id)).toEqual(['new-city']);
    const impact=await f.store.longMemoryImpact({scope,kind:'record',id:'new-city',action:'delete'});
    expect(impact).toEqual(expect.arrayContaining([{kind:'source',id:'city-source'},{kind:'record',id:'summary-parent'}]));
    await f.store.longMemoryWrite({scope,remove:[{kind:'record',id:'new-city',action:'delete',expectedVersion:1}]});
    expect((await f.store.longMemoryRecall(query())).hits).toEqual([]);
    const exported=JSON.stringify(await f.store.longMemoryExport([scope]));expect(exported).not.toContain('上海');expect(exported).not.toContain('杭州');
  });
});
