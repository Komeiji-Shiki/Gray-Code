import {createServer,type Server} from 'node:http';
import {once} from 'node:events';
import type {AddressInfo} from 'node:net';
import type {ModelInput,PlatformMessage,LongMemoryScope,LongMemoryJob} from '@graycode/contracts';
import {PlatformApplication} from '../../../apps/server/src/application';
import {fixture} from './fixtures';

describe('记忆后台任务与真实嵌入 HTTP 接口',()=>{
  let f:Awaited<ReturnType<typeof fixture>>,app:PlatformApplication,providerId:string,scope:LongMemoryScope,server:Server|undefined;
  let generate:(input:ModelInput)=>Promise<PlatformMessage>,calls:ModelInput[];
  beforeEach(async()=>{
    f=await fixture();await f.store.close();calls=[];generate=async()=>({role:'model',parts:[{text:'完成。'}]});
    app=await PlatformApplication.open({dataDirectory:f.data,documentsDirectory:f.root,models:{generate:async input=>{calls.push(input);return generate(input);}}});
    const draft=await app.product.draft();providerId=await draft.configs.createConfig({name:'后台测试',type:'openai',url:'http://127.0.0.1:1/v1',model:'fixture',enabled:true,apiKey:'',contextManagementEnabled:false,timeout:1000});await app.product.save(draft);
    await app.createConversation('owner','后台记忆',undefined,{},[],{id:'memory-background'});
    scope=(await app.longMemory.access('owner',{conversationId:'memory-background'})).scopes[0];
  });
  afterEach(async()=>{await app.close();if(server){server.closeAllConnections();await new Promise<void>(resolve=>server!.close(()=>resolve()));server=undefined;}await f.cleanup();});
  const user=async(text:string)=>{const run=await app.runtime.start({actorId:'owner',agentId:'default',conversationId:'memory-background',providerId,requestKey:Math.random().toString(),message:{role:'user',parts:[{text}]}});await app.runtime.wait(run.id);return run;};
  const configure=async(extra:Record<string,unknown>={})=>{const policy=await app.longMemory.policies.get('owner');return app.longMemory.policies.save('owner',{...policy.value,providerId,model:'fixture',...extra},policy.revision);};
  const extracted=(input:ModelInput)=>{
    const payload=JSON.parse(String(input.messages[0].parts[0].text)),source=payload.sources[0];
    return {role:'model',modelVersion:'served-fixture',parts:[{text:JSON.stringify({records:[{sourceIds:[source.id],quote:source.text,kind:'preference',subject:'self',text:'常用饮料是无糖豆浆。',topic:['个人','饮食'],attribute:'饮料',value:'无糖豆浆',validFrom:null,validTo:null,eventAt:null,inferred:false,fictional:false,entities:[],supersedes:[]}]})}],usageMetadata:{promptTokenCount:500,candidatesTokenCount:200,thoughtsTokenCount:80,cacheReadTokenCount:64,totalTokenCount:700}} as PlatformMessage;
  };

  test('仅在明确启用的范围提取，提交引用与模型用量，空闲不重复调用',async()=>{
    await configure({automaticExtraction:true,automaticScopes:['personal']});
    generate=async input=>input.purpose==='memory'?extracted(input):{role:'model',parts:[{text:'已收到。'}]};
    await user('我常用的饮料是无糖豆浆。');await app.longMemory.background.wait();
    const jobs=await app.storage.longMemoryJobs({scopes:[scope]});expect(jobs).toHaveLength(1);expect(jobs[0]).toMatchObject({status:'completed',usage:{input:500,output:200,thoughts:80,total:700,servedModel:'served-fixture'}});
    expect(calls.filter(input=>input.purpose==='memory')).toHaveLength(1);expect(calls.find(input=>input.purpose==='memory')?.maxOutputTokens).toBe(12288);
    const recalled=await app.longMemory.search(await app.longMemory.access('owner',{conversationId:'memory-background'}),{text:'常用饮料'});expect(recalled.hits[0].record).toMatchObject({origin:'user',confidence:'confirmed',subject:'actor:owner'});
    app.longMemory.background.kick(scope);await app.longMemory.background.wait();expect(calls.filter(input=>input.purpose==='memory')).toHaveLength(1);
  });

  test('提取过程中删除来源，返回的模型候选不能迟到写回，已知用量仍保留',async()=>{
    await configure();await user('我常用的饮料是无糖豆浆。');
    let release!:()=>void,started!:()=>void;const gate=new Promise<void>(resolve=>release=resolve),ready=new Promise<void>(resolve=>started=resolve);
    generate=async input=>{started();await gate;return extracted(input);};
    const job=(await app.longMemory.background.enqueueConversation('owner','memory-background',scope.id))!;
    await ready;
    await app.storage.longMemoryWrite({scope,remove:[{kind:'source',id:job.dependencies[0].id,action:'delete'}]});
    release();await app.longMemory.background.wait();
    const finished=(await app.storage.longMemoryJobs({scopes:[scope]}))[0];expect(finished.status).toBe('cancelled');expect(finished.usage?.total).toBe(700);
    expect((await app.storage.longMemoryExport([scope])).records).toEqual([]);
  });

  test('浮点向量按实际 index 对齐，历史版本可索引，预览只复用已有查询向量',async()=>{
    const requests:Array<{input:string[];encoding_format:string;dimensions:number}>=[];
    server=createServer(async(req,res)=>{const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks).toString());requests.push(body);
      res.setHeader('Content-Type','application/json');res.end(JSON.stringify({model:'fixture-embedding',data:body.input.map((_text:string,index:number)=>({index,embedding:[1,index]})).reverse(),usage:{prompt_tokens:12,total_tokens:12}}));});
    server.listen(0,'127.0.0.1');await once(server,'listening');
    await configure({embedding:{url:`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/embeddings`,model:'fixture-embedding',dimensions:2,queryPrefix:'Q:',documentPrefix:'D:'}});
    const access=await app.longMemory.access('owner',{conversationId:'memory-background'});
    const record=(await app.longMemory.remember(access,{scopeId:scope.id,text:'饮料偏好是豆浆。',kind:'preference',topic:['饮食'],validFrom:Date.now()+86400000})).records[0];
    await app.longMemory.background.wait();expect((await app.storage.longMemoryJobs({scopes:[scope]}))[0].status).toBe('completed');expect(requests[0]).toMatchObject({input:['D:饮料偏好是豆浆。'],encoding_format:'float',dimensions:2});
    const before=requests.length;
    const draft=await app.longMemory.query(access,{text:'语义测试',asOf:Date.now()+2*86400000},undefined,true);expect(requests).toHaveLength(before);expect(draft.embeddingError).toContain('只读预览');
    const actual=await app.longMemory.search(access,{text:'语义测试',asOf:Date.now()+2*86400000});expect(actual.method).toBe('hybrid');expect(actual.hits[0].record.id).toBe(record.id);expect(requests.at(-1)?.input).toEqual(['Q:语义测试']);
    const cached=await app.longMemory.query(access,{text:'语义测试'},undefined,true);expect(cached.vector).toBeDefined();expect(requests).toHaveLength(before+1);
  });
});
