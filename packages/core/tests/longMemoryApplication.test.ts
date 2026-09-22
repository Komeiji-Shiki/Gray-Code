import { randomUUID } from 'node:crypto';
import type { ModelInput,PlatformMessage,LongMemoryScope } from '@graycode/contracts';
import { PlatformApplication } from '../../../apps/server/src/application';
import { ApplicationRouter } from '../../../apps/server/src/transport/router';
import { BOT_CHANNEL_ACCESS } from '../../../apps/server/src/bots/channelAccess';
import { fixture } from './fixtures';

describe('长期记忆沿聊天、工具和请求视图接入',()=>{
  let f:Awaited<ReturnType<typeof fixture>>,app:PlatformApplication,router:ApplicationRouter,providerId:string,seen:ModelInput[];
  let generate:(input:ModelInput)=>Promise<PlatformMessage>;
  const session={actorId:'owner',clientId:'memory-test'};
  const plain=(input:ModelInput)=>input.messages.flatMap(message=>message.parts.map(part=>part.text??JSON.stringify(part))).join('\n');
  const request=(id:string,text:string)=>({actorId:'owner',agentId:'default',providerId,conversationId:id,requestKey:randomUUID(),message:{role:'user',parts:[{text}]}});
  const run=async(id:string,text:string)=>{const value=await app.runtime.start(request(id,text));const done=await app.runtime.wait(value.id);expect(done?.status).toBe('completed');return value;};
  beforeEach(async()=>{
    f=await fixture();await f.store.close();seen=[];generate=async()=>({role:'model',parts:[{text:'已处理。'}]});
    app=await PlatformApplication.open({dataDirectory:f.data,documentsDirectory:f.root,models:{generate:async input=>{const {signal,onRequest,onDelta,...snapshot}=input;seen.push({...structuredClone(snapshot),signal});return generate(input);}}});
    router=new ApplicationRouter(app);
    const draft=await app.product.draft();providerId=await draft.configs.createConfig({name:'记忆测试渠道',type:'openai',url:'http://127.0.0.1:1/v1',model:'fixture-model',apiKey:'',enabled:true,contextManagementEnabled:false,timeout:1000});await app.product.save(draft);
    await app.createConversation('owner','记忆测试',undefined,{},[],{id:'memory-chat'});
  });
  afterEach(async()=>{await app.close();await f.cleanup();});
  const personal=async()=>((await router.call(session,'memory.options',{conversationId:'memory-chat'})) as {scopes:LongMemoryScope[]}).scopes.find(scope=>scope.kind==='personal'&&scope.realm==='real')!;

  test('精确替换和追加保留其他正文及修订历史，拒绝歧义和旧版本', async () => {
    const scope = await personal(), access = await app.longMemory.access('owner', { conversationId: 'memory-chat' });
    const original = (await app.longMemory.remember(access, { scopeId: scope.id, text: '编辑器：暗色。\n默认端口：4300。\n项目使用 TypeScript。', kind: 'project', topic: ['项目', '配置'] })).records[0];
    const input = { scopeId: scope.id, id: original.id, expectedVersion: original.version };
    const patched = (await app.longMemory.revise(access, { ...input, oldText: '默认端口：4300。', newText: '默认端口：4400。' })).records[0];
    expect(patched.text).toBe('编辑器：暗色。\n默认端口：4400。\n项目使用 TypeScript。');
    expect(patched.version).toBe(2); expect(patched).not.toHaveProperty('oldText');
    await expect(app.longMemory.revise(access, { ...input, append: '\n新的约定。' })).rejects.toThrow('重新读取');
    const appended = (await app.longMemory.revise(access, { ...input, expectedVersion: 2, append: '\n测试使用 Jest。' })).records[0];
    expect(appended.text).toBe(patched.text + '\n测试使用 Jest。');
    await expect(app.longMemory.revise(access, { ...input, expectedVersion: 3, oldText: '。', newText: '！' })).rejects.toThrow('出现多次');
    await expect(app.longMemory.revise(access, { ...input, expectedVersion: 3, oldText: '不存在的文字', newText: '' })).rejects.toThrow('没有找到');
    await expect(app.longMemory.revise(access, { ...input, expectedVersion: 3, text: '全文', append: '追加' })).rejects.toThrow('只能选择一种');
    const versions = await app.storage.longMemoryRevisions({ scope, id: original.id });
    expect(versions.map(item => item.version)).toEqual([3, 2, 1]); expect(versions[2].text).toBe(original.text);
  });

  test('真实记忆工具引用用户原文，跨对话召回，删除阻止旧回复、摘要和历史工具再次发送',async()=>{
    const scope=await personal();let iteration=0;
    generate=async()=>++iteration===1?{role:'model',parts:[{functionCall:{id:'remember-call',name:'memory_remember',args:{scopeId:scope.id,text:'测试代号是青桐-173。',kind:'fact',topic:['测试','代号'],quote:'测试代号是青桐-173。'}}}]}:{role:'model',parts:[{text:'已记住青桐-173。'}]};
    await run('memory-chat','请记住：测试代号是青桐-173。');
    const found=await app.longMemory.search(await app.longMemory.access('owner',{conversationId:'memory-chat'}),{text:'测试代号'});
    expect(found.hits).toHaveLength(1);const saved=found.hits[0].record;
    const history=await app.storage.readFullHistory('memory-chat'),source=history.messages.find(message=>message.isUserInput)!;
    expect(history.messages.filter(message=>message.role==='model').every(message=>Array.isArray(message.longMemoryInputIds))).toBe(true);
    await app.storage.appendHistory('memory-chat',[{id:'derived-summary',role:'user',isSummary:true,summarizedMessageIds:[source.id!],parts:[{text:'此前确定测试代号为青桐-173。'}]}]);
    await app.createConversation('owner','第二次对话',undefined,{},[],{id:'memory-other'});
    generate=async()=>({role:'model',parts:[{text:'已读取。'}]});await run('memory-other','我的测试代号是什么？');
    const latest=seen.at(-1)!;const index=latest.messages.findIndex(message=>message.memoryContext);
    expect(index).toBeGreaterThanOrEqual(0);expect(latest.messages[index+1].isUserInput).toBe(true);expect(plain(latest)).toContain('青桐-173');
    let removing=true;
    generate=async input=>{
      if(removing){removing=false;return {role:'model',parts:[{functionCall:{id:'forget-call',name:'memory_remove',args:{scopeId:scope.id,id:saved.id,expectedVersion:saved.version,action:'delete',operation:'apply'}}}]};}
      const response=input.messages.flatMap(message=>message.parts).find(part=>(part.functionResponse as {name?:string}|undefined)?.name==='memory_remove')?.functionResponse as {response?:{success?:boolean}}|undefined;
      expect(response?.response?.success).toBe(true);return {role:'model',parts:[{text:'已忘记。'}]};
    };
    await run('memory-other','请忘记测试代号。');
    generate=async()=>({role:'model',parts:[{text:'已处理。'}]});
    await run('memory-chat','继续检查，已经忘记的内容不要复述。');
    expect(plain(seen.at(-1)!)).not.toContain('青桐-173');
    expect(JSON.stringify((await app.storage.readFullHistory('memory-chat')).messages)).toContain('青桐-173');
    const active=await app.storage.getRun((await app.storage.listRuns({conversationId:'memory-chat'}))[0].id);
    const tools=app.tools.catalog(['context_history','history_search']).entries;
    const context={actorId:'owner',conversationId:'memory-chat',runId:active!.id,toolCallId:'history-check',signal:new AbortController().signal} as any;
    const read=await tools.get('context_history')!.tool.execute({action:'read',messageId:source.id},context);
    expect(JSON.stringify(read)).not.toContain('青桐-173');
  });

  test('工具循环固定选择，普通新增不会重新排序，明确修订会刷新当前依据',async()=>{
    const scope=await personal(),access=await app.longMemory.access('owner',{conversationId:'memory-chat'});
    const record=(await app.longMemory.remember(access,{scopeId:scope.id,text:'部署端口为 4300。',kind:'project',topic:['项目','部署']})).records[0];
    app.tools.register({declaration:{name:'memory_boundary_fixture',description:'记忆边界测试',parameters:{type:'object',properties:{step:{type:'integer'}},required:['step']}},effects:()=>[],execute:async args=>{
      if(args.step===1)await app.longMemory.remember(access,{scopeId:scope.id,text:'部署工具使用另一项普通新增资料。',kind:'project',topic:['项目','部署']});
      else await app.longMemory.revise(access,{scopeId:scope.id,id:record.id,expectedVersion:record.version,text:'部署端口为 4400。'});
      return {success:true};
    }});
    let iteration=0;generate=async()=>++iteration<3?{role:'model',parts:[{functionCall:{id:'boundary-'+iteration,name:'memory_boundary_fixture',args:{step:iteration}}}]}:{role:'model',parts:[{text:'完成。'}]};
    await run('memory-chat','部署端口是什么？');expect(seen).toHaveLength(3);
    const memory=(input:ModelInput)=>input.messages.find(message=>message.memoryContext)?.parts[0].text;
    expect(memory(seen[0])).toContain('4300');expect(memory(seen[1])).toBe(memory(seen[0]));expect(memory(seen[2])).toContain('4400');expect(memory(seen[2])).not.toContain('4300');
  });

  test('同一账号在群聊中只自动读取绑定群组，个人记忆不会进入群聊请求',async()=>{
    const scope=await personal();await router.call(session,'memory.remember',{scopeId:scope.id,text:'私人测试代号是溪谷-811。',kind:'fact',topic:['测试']});
    await app.createConversation('owner','群组测试',undefined,{},[],{id:'memory-group',records:[{namespace:BOT_CHANNEL_ACCESS,id:'memory-group',value:{version:1,context:{platform:'discord',botId:'fixture-bot',channelId:'fixture-channel',direct:false},participants:[{actorId:'owner',platformUserId:'fixture-owner'}]}}]});
    const access=await app.longMemory.access('owner',{conversationId:'memory-group'});expect(access.scopes.map(item=>item.kind)).toEqual(['group']);
    await app.longMemory.remember(access,{scopeId:access.scopes[0].id,text:'群组测试代号是海桥-622。',kind:'fact',topic:['测试']});
    await run('memory-group','测试代号是什么？');expect(plain(seen.at(-1)!)).toContain('海桥-622');expect(plain(seen.at(-1)!)).not.toContain('溪谷-811');
  });

  test('分段来源工具返回实际记忆依据，供后续遗忘和上下文清理使用', async () => {
    const scope = await personal(), access = await app.longMemory.access('owner', { conversationId: 'memory-chat' });
    const saved = await app.longMemory.remember(access, { scopeId: scope.id, text: '长来源核对。'.repeat(400), kind: 'fact', topic: ['测试'] });
    const record = saved.records[0], source = saved.sources[0];
    const tool = app.tools.catalog(['memory_read']).entries.get('memory_read')!.tool;
    const result = await tool.execute({ scopeId: scope.id, page: { id: record.id, version: record.version, sourceId: source.id }, tokenBudget: 1000 },
      { actorId: 'owner', conversationId: 'memory-chat', signal: new AbortController().signal } as any);
    expect(result.success).toBe(true);
    expect(result.memoryReferences).toEqual([{ scopeId: scope.id, id: record.id, version: record.version }]);
    expect((result.data as any).page.source.id).toBe(source.id); expect((result.data as any).page.nextOffset).toBeGreaterThan(0);
  });
});
