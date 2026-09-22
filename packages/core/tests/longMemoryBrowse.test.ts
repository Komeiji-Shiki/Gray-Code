import type { LongMemoryScope, LongMemoryRecordInput, LongMemorySourceInput } from '@graycode/contracts';
import { fixture } from './fixtures';

const scope: LongMemoryScope = { id:'browse-scope', actorId:'owner', kind:'library', key:'fixture-library', realm:'real' };
const source: LongMemorySourceInput = { id:'source', expectedVersion:0, origin:'import', text:'合成条目的原始说明。', recordedAt:1 };
const record = (id:string, extra:Partial<LongMemoryRecordInput> = {}):LongMemoryRecordInput => ({
  id,expectedVersion:0,kind:'fact',origin:'import',confidence:'inferred',subject:'合成资料',text:`关键词 ${id}`,topic:['资料','同一主题'],entities:[],
  recordedAt:2,validFrom:2,dependencies:[{kind:'source',id:'source',version:1}],supersedes:[],...extra,
});

describe('人工记忆列表分页与历史版本',()=>{
  let f:Awaited<ReturnType<typeof fixture>>;
  beforeEach(async()=>{f=await fixture();});
  afterEach(async()=>{await f.cleanup();});

  test('分页覆盖同主题全部条目，长正文也能发现，筛选和删除后的游标保持一致',async()=>{
    const records=Array.from({length:65},(_,index)=>record(`item-${String(index).padStart(2,'0')}`,{confidence:index%2?'confirmed':'inferred'}));
    const longText='完整原文🐱'.repeat(4000);
    await f.store.longMemoryWrite({scope,sources:[source],records:[record('a-long',{text:longText}),...records]});
    const seen:string[]=[];let cursor:string|undefined,firstCursor:string|undefined;
    do{
      const page=await f.store.longMemoryBrowse({scope,topic:['资料'],limit:11,cursor});
      expect(page.total).toBe(66);expect(page.items.length).toBeGreaterThan(0);
      seen.push(...page.items.map(item=>item.id));firstCursor??=page.nextCursor;cursor=page.nextCursor;
      const long=page.items.find(item=>item.id==='a-long');if(long){expect(long.moreText).toBe(true);expect(long.preview.length).toBeLessThanOrEqual(600);}
    }while(cursor);
    expect(new Set(seen).size).toBe(66);expect(seen).toEqual(['a-long',...records.map(record=>record.id)]);
    const filtered=await f.store.longMemoryBrowse({scope,text:'关键词',confidence:'inferred',limit:100});
    expect(filtered.total).toBe(33);expect(filtered.items.every(item=>item.confidence==='inferred')).toBe(true);
    expect((await f.store.longMemoryInspect({scope,id:'a-long'})).revisions[0].text).toBe(longText);
    await f.store.longMemoryWrite({scope,remove:[{kind:'record',id:'item-00',action:'delete',expectedVersion:1}]});
    await expect(f.store.longMemoryBrowse({scope,topic:['资料'],limit:11,cursor:firstCursor})).rejects.toThrow('列表或筛选条件已变化');
    await expect(f.store.longMemoryBrowse({scope:{...scope,actorId:'other'}})).rejects.toThrow('不匹配');
  });

  test('当前有效列表显示实际生效版本，全部列表显示最新修订并标识未来与失效内容',async()=>{
    const now=Date.now();
    await f.store.longMemoryWrite({scope,sources:[source],records:[record('changing',{confidence:'confirmed'}),record('expired',{validTo:now-1000})]});
    await f.store.longMemoryWrite({scope,records:[record('changing',{expectedVersion:1,text:'未来生效的版本',validFrom:now+86400000,recordedAt:now,confidence:'confirmed'})]});
    const current=await f.store.longMemoryBrowse({scope,status:'current'});
    expect(current.items.map(item=>[item.id,item.version,item.active])).toEqual([['changing',1,true]]);
    const all=await f.store.longMemoryBrowse({scope,status:'all'});
    expect(all.items).toEqual(expect.arrayContaining([expect.objectContaining({id:'changing',version:2,active:false}),expect.objectContaining({id:'expired',active:false})]));
    const inactive=await f.store.longMemoryBrowse({scope,status:'inactive'});expect(inactive.total).toBe(2);
  });

  test('超过近期修订上限后仍可精确查看关系图引用的旧版本',async()=>{
    await f.store.longMemoryWrite({scope,sources:[source],records:[record('versions',{text:'最初的完整正文'})]});
    for(let version=1;version<=100;version++)await f.store.longMemoryWrite({scope,records:[record('versions',{expectedVersion:version,text:`修订 ${version+1}`,recordedAt:2+version})]});
    const normal=await f.store.longMemoryInspect({scope,id:'versions'});expect(normal.revisions).toHaveLength(100);expect(normal.revisions[0].version).toBe(101);
    const historical=await f.store.longMemoryInspect({scope,id:'versions',version:1});
    expect(historical.revisions[0].version).toBe(101);expect(historical.revisions.find(record=>record.version===1)?.text).toBe('最初的完整正文');
  });
});
