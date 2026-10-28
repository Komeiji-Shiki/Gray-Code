import {createServer,type Server} from 'node:http';
import {once} from 'node:events';
import type {AddressInfo} from 'node:net';
import type {ModelInput,PlatformMessage,LongMemoryScope} from '@graycode/contracts';
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
    scope=(await app.longMemory.managementAccess('owner')).scopes[0];
  });
  afterEach(async()=>{await app.close();if(server){server.closeAllConnections();await new Promise<void>(resolve=>server!.close(()=>resolve()));server=undefined;}await f.cleanup();});
  const configure=async(extra:Record<string,unknown>={})=>{const policy=await app.longMemory.policies.get('owner');return app.longMemory.policies.save('owner',{...policy.value,providerId,model:'fixture',...extra},policy.revision);};
  test('浮点向量按实际 index 对齐，历史版本可索引，预览只复用已有查询向量',async()=>{
    const requests:Array<{input:string[];encoding_format:string;dimensions:number}>=[];
    server=createServer(async(req,res)=>{const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks).toString());requests.push(body);
      res.setHeader('Content-Type','application/json');res.end(JSON.stringify({model:'fixture-embedding',data:body.input.map((_text:string,index:number)=>({index,embedding:[1,index]})).reverse(),usage:{prompt_tokens:12,total_tokens:12}}));});
    server.listen(0,'127.0.0.1');await once(server,'listening');
    await configure({embedding:{url:`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/embeddings`,model:'fixture-embedding',dimensions:2,queryPrefix:'Q:',documentPrefix:'D:'}});
    const access=await app.longMemory.managementAccess('owner');
    const record=(await app.longMemory.remember(access,{scopeId:scope.id,text:'饮料偏好是豆浆。',kind:'preference',topic:['饮食'],validFrom:Date.now()+86400000})).records[0];
    await app.longMemory.background.wait();expect((await app.storage.longMemoryJobs({scopes:[scope]}))[0].status).toBe('completed');expect(requests[0]).toMatchObject({input:['D:饮料偏好是豆浆。'],encoding_format:'float',dimensions:2});
    const before=requests.length;
    const draft=await app.longMemory.query(access,{text:'语义测试',asOf:Date.now()+2*86400000},undefined,true);expect(requests).toHaveLength(before);expect(draft.embeddingError).toContain('只读预览');
    const actual=await app.longMemory.search(access,{text:'语义测试',asOf:Date.now()+2*86400000});expect(actual.method).toBe('hybrid');expect(actual.hits[0].record.id).toBe(record.id);expect(requests.at(-1)?.input).toEqual(['Q:语义测试']);
    const cached=await app.longMemory.query(access,{text:'语义测试'},undefined,true);expect(cached.vector).toBeDefined();expect(requests).toHaveLength(before+1);
  });
});
