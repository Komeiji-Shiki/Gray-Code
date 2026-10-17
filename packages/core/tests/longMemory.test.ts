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
    await f.store.longMemoryVector({ scope, id: result.hits[0].record.id, version: 1, vector: { model: 'fixture-two-dimensional', dimensions: 2, values: [-1, 0] } });
    const refreshed = await f.store.longMemoryRecall(query({ text: '不存在的同义词', limit: 3, tokenBudget: 700, vector: { model: 'fixture-two-dimensional', dimensions: 2, values: [1, 0] } }));
    expect(refreshed.hits.map(hit => hit.record.id)).not.toContain(result.hits[0].record.id);
    expect((await f.store.longMemoryRecall(query({text:'不存在的同义词',vector:{model:'another-model',dimensions:2,values:[1,0]}}))).hits).toEqual([]);
    const expanded=await f.store.longMemoryRead({query:query({limit:1,tokenBudget:350}),references:result.hits.map(hit=>({scopeId:scope.id,id:hit.record.id})),includeSources:true});
    expect(expanded.records.length).toBeLessThanOrEqual(1);expect(expanded.estimatedTokens).toBeLessThanOrEqual(350);
  });

  test('批量目录摘要遵循确认状态，共用来源的多个条目同时失效', async () => {
    await add();
    await f.store.longMemoryWrite({ scope, sources: [{ ...source('pending-source', '模型推测的住址。'), origin: 'model' }], records: [
      record('pending', '待核对的住址。', 'pending-source', { confidence: 'inferred', origin: 'model' }),
      record('shared', '同一原文中的另一条住址说明。', 'city-source'),
      record('summary-valid', '已确认依据的住址摘要。', '', { kind: 'summary', confidence: 'inferred', dependencies: [{ kind: 'record', id: 'city', version: 1 }] }),
      record('summary-pending', '尚待核对依据的住址摘要。', '', { kind: 'summary', confidence: 'inferred', dependencies: [{ kind: 'record', id: 'pending', version: 1 }] }),
    ] });
    const directory = await f.store.longMemoryTopics(query({ text: undefined, topic: ['个人'], includeSummaries: true, tokenBudget: 16000 }));
    expect(directory.topics[0].summaries.map(item => item.id)).toEqual(['summary-valid']);
    await f.store.longMemoryWrite({ scope, sources: [{ ...source('city-source', '原来的住址来源已纠正。'), expectedVersion: 1 }] });
    const found = await f.store.longMemoryRecall(query({ confirmedOnly: false, limit: 50, tokenBudget: 16000 }));
    expect(found.hits.map(hit => hit.record.id)).not.toEqual(expect.arrayContaining(['city']));
    expect(found.hits.map(hit => hit.record.id)).not.toEqual(expect.arrayContaining(['shared']));
    expect(found.hits.map(hit => hit.record.id)).not.toEqual(expect.arrayContaining(['summary-valid']));
  });

  test('关系图只返回真实依赖，保留历史关系并标明失效，节点数量有界', async () => {
    await add();
    await f.store.longMemoryWrite({scope,records:[record('derived','居住信息摘要。','',{kind:'summary',dependencies:[{kind:'record',id:'city',version:1}]})]});
    const graph = await f.store.longMemoryGraph({ scope, id: 'city', limit: 3 });
    expect(graph.nodes.map(node => node.key)).toEqual(['record:city@1','source:city-source@1','record:derived@1']);
    expect(graph.edges).toEqual([{from:'source:city-source@1',to:'record:city@1'},{from:'record:city@1',to:'record:derived@1'}]);
    expect(graph.nodes.every(node => node.active)).toBe(true); expect(graph.truncated).toBe(false);
    await f.store.longMemoryWrite({scope,sources:[source('move-source','目前住杭州。')],records:[record('city','目前住杭州。','move-source',{expectedVersion:1})]});
    const historical = await f.store.longMemoryGraph({ scope, id: 'city', version: 1 });
    expect(historical.nodes.find(node => node.id === 'city')?.active).toBe(false);
    expect(historical.nodes.find(node => node.id === 'derived')?.active).toBe(false);
    const updated = await f.store.longMemoryGraph({ scope, id: 'city' });
    expect(updated.root).toBe('record:city@2'); expect(updated.nodes.some(node => node.id === 'derived')).toBe(false);
    await expect(f.store.longMemoryGraph({scope,id:'city',limit:101})).rejects.toThrow('数量无效');
  });

  test('主题续页覆盖所有同级目录，预算不足给出所需额度，变化后的游标要求重新读取', async () => {
    const sources = Array.from({ length: 65 }, (_, index) => source(`page-source-${index}`, `目录原文 ${index}`));
    await f.store.longMemoryWrite({ scope, sources, records: sources.map((item, index) => record(`page-${index}`, item.text, item.id, { topic: ['目录', String(index).padStart(2, '0')] })) });
    const request = query({ text: undefined, topic: ['目录'], limit: 9, tokenBudget: 600 });
    const seen: string[] = []; let cursor: string | undefined, firstCursor: string | undefined;
    do {
      const page = await f.store.longMemoryTopics({ ...request, cursor });
      expect(page.topics.length).toBeGreaterThan(0); expect(page.estimatedTokens).toBeLessThanOrEqual(600);
      seen.push(...page.topics.map(topic => topic.path.at(-1)!)); cursor = page.nextCursor; firstCursor ??= cursor;
    } while (cursor);
    expect(seen).toEqual(Array.from({ length: 65 }, (_, index) => String(index).padStart(2, '0')));
    await f.store.longMemoryWrite({ scope, sources: [source('later', '新的目录原文')], records: [record('later', '新的目录', 'later', { topic: ['目录', '后来'] })] });
    await expect(f.store.longMemoryTopics({ ...request, cursor: firstCursor })).rejects.toThrow('目录或筛选条件已变化');
    await expect(f.store.longMemoryTopics({ ...request, cursor: '!invalid' })).rejects.toThrow('编号无效');
    const longPath = Array.from({ length: 8 }, (_, index) => String(index) + '长'.repeat(119));
    await f.store.longMemoryWrite({ scope, sources: [source('long-name', '长目录')], records: [record('long-name', '长目录条目', 'long-name', { topic: longPath })] });
    const short = await f.store.longMemoryTopics(query({ text: undefined, topic: longPath.slice(0, 7), tokenBudget: 256 }));
    expect(short.topics).toEqual([]); expect(short.requiredTokenBudget).toBeGreaterThan(256);
    const sufficient = await f.store.longMemoryTopics({ ...query({ text: undefined, topic: longPath.slice(0, 7), tokenBudget: short.requiredTokenBudget }), cursor: short.nextCursor });
    expect(sufficient.topics[0].path).toEqual(longPath); expect(sufficient.nextCursor).toBeUndefined();
  });

  test('按需读取区分预算省略、条数上限和不存在的记忆，并保持请求顺序', async () => {
    await f.store.longMemoryWrite({ scope, sources: [source('one-source', '短来源'), source('two-source', '另一来源')],
      records: [record('one', '第一条事实。'), record('two', '第二条事实。')] });
    const references = ['two', 'one', 'missing'].map(id => ({ scopeId: scope.id, id }));
    const limited = await f.store.longMemoryRead({ query: query({ limit: 1, tokenBudget: 16000 }), references });
    expect(limited.records.map(item => item.id)).toEqual(['two']);
    expect(limited.unavailable.map(item => item.id)).toEqual(['one', 'missing']);
    expect(limited.omitted).toEqual([expect.objectContaining({ kind: 'record', id: 'one', reason: 'record_limit' })]);
    expect(limited.truncated).toBe(true);
    const small = await f.store.longMemoryRead({ query: query({ tokenBudget: 64 }), references: references.slice(0, 1) });
    expect(small.omitted?.[0]).toMatchObject({ id: 'two', reason: 'token_budget' });
    const full = await f.store.longMemoryRead({ query: query({ tokenBudget: 16000 }), references });
    expect(full.records.map(item => item.id)).toEqual(['two', 'one']); expect(full.omitted).toBeUndefined();
    const stale = await f.store.longMemoryRead({ query: query(), references: [{ scopeId: scope.id, id: 'one', version: 9 }] });
    expect(stale.records).toEqual([]); expect(stale.omitted).toBeUndefined();
  });

  test('正文可读但来源过长时，明确返回被省略的来源和读取预算', async () => {
    await f.store.longMemoryWrite({ scope, sources: [source('long-source', '来源中的详细原文。'.repeat(200))],
      records: [record('short', '简短事实。', 'long-source')] });
    const result = await f.store.longMemoryRead({ query: query({ tokenBudget: 600 }), references: [{ scopeId: scope.id, id: 'short' }], includeSources: true });
    expect(result.records).toHaveLength(1); expect(result.sources).toEqual([]);
    expect(result.omitted).toEqual([expect.objectContaining({ kind: 'source', id: 'long-source', reason: 'token_budget' })]);
    const full = await f.store.longMemoryRead({ query: query({ tokenBudget: 16000 }), references: [{ scopeId: scope.id, id: 'short' }], includeSources: true });
    expect(full.sources[0].text).toBe('来源中的详细原文。'.repeat(200)); expect(full.omitted).toBeUndefined();
  });

  test('长正文和来源按预算连续读取，保留 Unicode 和依据，修订后旧页停止返回', async () => {
    const text = '完整来源🐱\r\n'.repeat(140), body = '完整记忆🐱\n'.repeat(120);
    await f.store.longMemoryWrite({ scope, sources: [source('paged-source', text)], records: [record('paged', body, 'paged-source')] });
    const ref = { scopeId: scope.id, id: 'paged', version: 1 };
    for (const sourceId of [undefined, 'paged-source']) {
      let offset: number | undefined = 0, joined = '', pages = 0;
      do {
        const result = await f.store.longMemoryRead({ query: query({ tokenBudget: 650 }), references: [], page: { record: ref, sourceId, offset } });
        expect(result.page?.record).toMatchObject(ref); expect(result.estimatedTokens).toBeLessThanOrEqual(650);
        expect(result.page!.text).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
        joined += result.page!.text; offset = result.page!.nextOffset; pages++;
        expect(pages).toBeLessThan(100);
      } while (offset !== undefined);
      expect(joined).toBe(sourceId ? text : body); expect(pages).toBeGreaterThan(1);
    }
    const small = await f.store.longMemoryRead({ query: query({ tokenBudget: 64 }), references: [], page: { record: ref } });
    expect(small.requiredTokenBudget).toBeGreaterThan(64); expect(small.page).toBeUndefined();
    await expect(f.store.longMemoryRead({ query: query(), references: [], page: { record: ref, sourceId: 'not-a-dependency' } })).rejects.toThrow('不属于');
    await f.store.longMemoryWrite({ scope, sources: [{ ...source('paged-source', '已纠正的来源'), expectedVersion: 1 }] });
    const stale = await f.store.longMemoryRead({ query: query(), references: [], page: { record: ref, sourceId: 'paged-source', offset: 1 } });
    expect(stale.page).toBeUndefined(); expect(stale.unavailable).toEqual([ref]);
  });

  test('交换归档保留来源的后续修订，恢复后不使已失效记忆重新有效', async () => {
    await add();
    await f.store.longMemoryWrite({ scope, sources: [
      { ...source('city-source', '原来的住址来源已纠正。', time('2026-08-01')), expectedVersion: 1 },
      source('unreferenced-source', '尚未引用的另一份原文。'),
    ] });
    expect((await f.store.longMemoryRecall(query())).hits).toEqual([]);
    const archive = await f.store.longMemoryExport([scope]);
    const other = await fixture();
    try {
      await other.store.longMemoryRestore({ actorId: 'owner', archive });
      expect((await other.store.longMemoryRecall(query())).hits).toEqual([]);
      const historical = await other.store.longMemoryRecall(query({ knownAt: time('2026-07-15') }));
      expect(historical.hits.map(hit => hit.record.text)).toEqual(['当前住址是上海。']);
      expect(archive.sources.map(item => [item.id, item.version])).toEqual([['city-source', 1], ['city-source', 2]]);
    } finally { await other.cleanup(); }
  });

  test.each([false, true])('目标删除状态沿归档多层依赖传播，独立替代记录仍可再次交换，逆序=%s', async reverse => {
    await f.store.longMemoryWrite({ scope,
      sources: [source('removed-source', '旧住址来源。'), source('kept-source', '当前住址是苏州。')],
      records: [
        record('root', '旧住址。', 'removed-source'),
        record('middle', '旧住址摘要。', '', { kind: 'summary', dependencies: [{ kind: 'record', id: 'root', version: 1 }] }),
        record('tail', '旧住址的多层摘要。', '', { kind: 'summary', dependencies: [{ kind: 'record', id: 'middle', version: 1 }] }),
        record('kept', '当前住址是苏州。', 'kept-source', { supersedes: ['middle'] }),
      ],
    });
    const archive = await f.store.longMemoryExport([scope]);
    if (reverse) archive.records.reverse();
    const other = await fixture();
    const third = await fixture();
    try {
      await other.store.longMemoryWrite({ scope, remove: [{ kind: 'source', id: 'removed-source', action: 'delete' }] });
      await expect(other.store.longMemoryRestore({ actorId: 'owner', archive }))
        .resolves.toEqual({ sources: 1, records: 1, skipped: 4, tombstones: 0 });
      const exchanged = await other.store.longMemoryExport([scope]);
      expect(exchanged.records.map(item => [item.id, item.supersedes])).toEqual([['kept', ['middle']]]);
      expect(exchanged.tombstones.map(item => [item.kind, item.id])).toEqual([['source', 'removed-source']]);
      await third.store.longMemoryRestore({ actorId: 'owner', archive: exchanged });
      expect((await third.store.longMemoryExport([scope])).records).toEqual(exchanged.records);
      expect((await third.store.longMemoryRecall(query())).hits.map(hit => hit.record.id)).toEqual(['kept']);
    } finally { await other.cleanup(); await third.cleanup(); }
  });

  test.each(['delete', 'retract'] as const)('旧事实被%s后，合法的新事实及其替代关系可从自身归档恢复', async action => {
    await f.store.longMemoryWrite({ scope,
      sources: [source('old-source', '旧住址是上海。'), source('new-source', '当前住址是杭州。')],
      records: [record('old', '旧住址是上海。', 'old-source'), record('new', '当前住址是杭州。', 'new-source', { supersedes: ['old'] })],
    });
    await f.store.longMemoryWrite({ scope, remove: [{ kind: 'record', id: 'old', action }] });
    const archive = await f.store.longMemoryExport([scope]);
    expect(archive.records.map(item => item.id)).toEqual(['new']);
    const other = await fixture();
    try {
      await other.store.longMemoryRestore({ actorId: 'owner', archive });
      expect((await other.store.longMemoryExport([scope])).records).toEqual(archive.records);
      expect((await other.store.longMemoryRecall(query())).hits.map(hit => hit.record.id)).toEqual(['new']);
    } finally { await other.cleanup(); }
  });

  test.each([false, true])('后续修订引用已删除来源时跳过同身份全部归档修订，保留目标原记录=%s', async existing => {
    const original = record('city', '当前住址是上海。', 'live-source');
    await f.store.longMemoryWrite({ scope,
      sources: [source('live-source', '当前住址是上海。'), source('removed-source', '杭州住址来源。')], records: [original],
    });
    await f.store.longMemoryWrite({ scope, records: [record('city', '当前住址是杭州。', 'removed-source', {
      expectedVersion: 1, recordedAt: time('2026-08-01'), validFrom: time('2026-08-01'),
    })] });
    const archive = await f.store.longMemoryExport([scope]);
    const other = await fixture();
    try {
      if (existing) await other.store.longMemoryWrite({ scope, sources: [source('live-source', '当前住址是上海。')], records: [original] });
      await other.store.longMemoryWrite({ scope, remove: [{ kind: 'source', id: 'removed-source', action: 'delete' }] });
      await expect(other.store.longMemoryRestore({ actorId: 'owner', archive }))
        .resolves.toEqual({ sources: existing ? 0 : 1, records: 0, skipped: existing ? 4 : 3, tombstones: 0 });
      expect((await other.store.longMemoryExport([scope])).records.map(item => [item.id, item.version]))
        .toEqual(existing ? [['city', 1]] : []);
    } finally { await other.cleanup(); }
  });

  test.each(['替代自身', '缺失来源', '修订断档'])('历史替代关系不放宽真实依赖和修订约束：%s，失败仍整体回滚', async mutation => {
    await add();
    const archive = await f.store.longMemoryExport([scope]);
    if (mutation === '替代自身') archive.records[0].supersedes = [archive.records[0].id];
    else if (mutation === '缺失来源') archive.records[0].dependencies = [{ kind: 'source', id: 'missing', version: 1 }];
    else archive.records[0].version = 2;
    const other = await fixture();
    try {
      await other.store.longMemoryWrite({ scope, sources: [source('existing-source', '已有独立事实。')],
        records: [record('existing', '已有独立事实。', 'existing-source')] });
      await expect(other.store.longMemoryRestore({ actorId: 'owner', archive })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      const after = await other.store.longMemoryExport([scope]);
      expect(after.sources.map(item => item.id)).toEqual(['existing-source']);
      expect(after.records.map(item => item.id)).toEqual(['existing']);
    } finally { await other.cleanup(); }
  });

  test('正常新写入仍拒绝不存在的替代对象', async () => {
    await add();
    await expect(f.store.longMemoryWrite({ scope, records: [record('replacement', '新的住址。', 'city-source', { supersedes: ['missing'] })] }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect((await f.store.longMemoryExport([scope])).records.map(item => item.id)).toEqual(['city']);
  });

  test.each(['来源', '记忆'])('交换归档的%s仅改变对象键顺序时仍可幂等恢复', async kind => {
    await add();
    const archive = await f.store.longMemoryExport([scope]);
    if (kind === '来源') {
      const { id, ...fields } = archive.sources[0];
      archive.sources[0] = { ...fields, id };
    } else {
      const { id, ...fields } = archive.records[0];
      archive.records[0] = { ...fields,
        dependencies: fields.dependencies.map(({ kind: parentKind, ...ref }) => ({ ...ref, kind: parentKind })), id,
      };
    }
    const skipped = { sources: 0, records: 0, skipped: 2, tombstones: 0 };
    await expect(f.store.longMemoryRestore({ actorId: 'owner', archive })).resolves.toEqual(skipped);
    const other = await fixture();
    try {
      await expect(other.store.longMemoryRestore({ actorId: 'owner', archive }))
        .resolves.toEqual({ sources: 1, records: 1, skipped: 0, tombstones: 0 });
      await expect(other.store.longMemoryRestore({ actorId: 'owner', archive })).resolves.toEqual(skipped);
      expect((await other.store.longMemoryRecall(query())).hits.map(hit => hit.record.text)).toEqual(['当前住址是上海。']);
    } finally { await other.cleanup(); }
  });

  test.each(['来源正文', '记忆正文', '数组顺序'])('归档同修订的%s变化仍拒绝合并并保留原内容', async change => {
    await f.store.longMemoryWrite({ scope, sources: [source('city-source', '当前住址是上海。')],
      records: [record('city', '当前住址是上海。', 'city-source', { entities: ['本人', '家庭'] })] });
    const before = await f.store.longMemoryExport([scope]);
    const archive = structuredClone(before);
    if (change === '来源正文') archive.sources[0].text = '不同的来源。';
    else if (change === '记忆正文') archive.records[0].text = '不同的记忆。';
    else archive.records[0].entities.reverse();
    await expect(f.store.longMemoryRestore({ actorId: 'owner', archive })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const after = await f.store.longMemoryExport([scope]);
    expect(after.sources).toEqual(before.sources);
    expect(after.records).toEqual(before.records);
  });

  test('来源写入重试忽略定位对象的键顺序，但仍拒绝同版本的不同值', async () => {
    const input = { ...source('copy-source', '当前住址是上海。'),
      reference: { conversationId: 'fixture-conversation', messageId: 'fixture-message' } };
    const written = await f.store.longMemoryWrite({ scope, sources: [input], records: [record('city', '当前住址是上海。', 'copy-source')] });
    const retry = { ...input, reference: { messageId: 'fixture-message', conversationId: 'fixture-conversation' } };
    expect((await f.store.longMemoryWrite({ scope, sources: [retry] })).state.revision).toBe(written.state.revision);
    await expect(f.store.longMemoryWrite({ scope, sources: [{ ...retry, text: '不同的原文。' }] }))
      .rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    expect((await f.store.longMemoryExport([scope])).sources[0].text).toBe(input.text);
  });

  test('记忆写入重试忽略依赖对象的键顺序，但仍拒绝同版本的不同值', async () => {
    const written = await add();
    const retry = record('city', '当前住址是上海。', 'city-source', {
      dependencies: [{ version: 1, id: 'city-source', kind: 'source' }],
    });
    expect((await f.store.longMemoryWrite({ scope, records: [retry] })).state.revision).toBe(written.state.revision);
    await expect(f.store.longMemoryWrite({ scope, records: [{ ...retry, text: '不同的记忆。' }] }))
      .rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    expect((await f.store.longMemoryExport([scope])).records[0].text).toBe(retry.text);
  });

  test('可选字段显式为undefined时仍按实际保存的JSON内容重试和恢复', async () => {
    const input = { ...source('city-source', '当前住址是上海。'), reference: { label: 'fixture', conversationId: undefined } };
    const written = await f.store.longMemoryWrite({ scope, sources: [input], records: [record('city', input.text)] });
    expect((await f.store.longMemoryWrite({ scope, sources: [input] })).state.revision).toBe(written.state.revision);
    const archive = await f.store.longMemoryExport([scope]);
    archive.sources[0].reference = { label: 'fixture', conversationId: undefined };
    archive.records[0].dependencies[0].association = undefined;
    await expect(f.store.longMemoryRestore({ actorId: 'owner', archive }))
      .resolves.toEqual({ sources: 0, records: 0, skipped: 2, tombstones: 0 });
  });

  test('仅引用第二版来源的交换归档可在空存储中恢复完整版本链', async () => {
    await f.store.longMemoryWrite({ scope, sources: [source('city-source', '尚未提取的住址原文。')] });
    await f.store.longMemoryWrite({ scope, sources: [
      { ...source('city-source', '当前住址是杭州。', time('2026-08-01')), expectedVersion: 1 },
    ], records: [record('city', '当前住址是杭州。', 'city-source', {
      recordedAt: time('2026-08-01'),
      validFrom: time('2026-08-01'),
      dependencies: [{ kind: 'source', id: 'city-source', version: 2 }],
    })] });
    const archive = await f.store.longMemoryExport([scope]);
    const other = await fixture();
    try {
      await expect(other.store.longMemoryRestore({ actorId: 'owner', archive })).resolves.toEqual({
        sources: 2, records: 1, skipped: 0, tombstones: 0,
      });
      expect((await other.store.longMemoryRecall(query())).hits.map(hit => hit.record.text)).toEqual(['当前住址是杭州。']);
    } finally { await other.cleanup(); }
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
