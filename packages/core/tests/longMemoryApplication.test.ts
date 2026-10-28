import { randomUUID } from 'node:crypto';
import type { ModelInput,PlatformMessage,LongMemoryScope } from '@graycode/contracts';
import { PlatformApplication } from '../../../apps/server/src/application';
import { ApplicationRouter } from '../../../apps/server/src/transport/router';
import { BOT_CHANNEL_ACCESS } from '../../../apps/server/src/bots/channelAccess';
import { longMemoryScope } from '../../../apps/server/src/memory/longTerm/scopes';
import { MEMORY_IMPORT_POLICY_NAMESPACE } from '@graycode/contracts';
import { fixture } from './fixtures';

describe('长期记忆沿聊天、工具和请求视图接入',()=>{
  let f:Awaited<ReturnType<typeof fixture>>,app:PlatformApplication,router:ApplicationRouter,providerId:string,seen:ModelInput[];
  let generate:(input:ModelInput)=>Promise<PlatformMessage>;
  const session={actorId:'owner',clientId:'memory-test'};
  const request=(id:string,text:string)=>({actorId:'owner',agentId:'default',providerId,conversationId:id,requestKey:randomUUID(),message:{role:'user',parts:[{text}]}});
  const run=async(id:string,text:string)=>{const value=await app.runtime.start(request(id,text));const done=await app.runtime.wait(value.id);expect(done?.status).toBe('completed');return value;};
  beforeEach(async()=>{
    f=await fixture();await f.store.close();seen=[];generate=async()=>({role:'model',parts:[{text:'已处理。'}]});
    app=await PlatformApplication.open({dataDirectory:f.data,documentsDirectory:f.root,models:{generate:async input=>{const {signal,onRequest,onDelta,onToolCallReady,onRetry,...snapshot}=input;seen.push({...structuredClone(snapshot),signal});return generate(input);}}});
    router=new ApplicationRouter(app);
    const draft=await app.product.draft();providerId=await draft.configs.createConfig({name:'记忆测试渠道',type:'openai',url:'http://127.0.0.1:1/v1',model:'fixture-model',apiKey:'',enabled:true,contextManagementEnabled:false,timeout:1000});await app.product.save(draft);
    await app.createConversation('owner','记忆测试',undefined,{},[],{id:'memory-chat'});
  });
  afterEach(async()=>{await app.close();await f.cleanup();});
  const personal=async()=>((await router.call(session,'memory.options',{conversationId:'memory-chat'})) as {scopes:LongMemoryScope[]}).scopes.find(scope=>scope.kind==='personal'&&scope.realm==='real')!;

  test('精确替换和追加保留其他正文及修订历史，拒绝歧义和旧版本', async () => {
    const scope = await personal(), access = await app.longMemory.managementAccess('owner', scope.id);
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

  test('尚未写入过的群范围读到空目录时，同批工具调用与结果原样保留', async () => {
    await app.createConversation('owner','空群组',undefined,{},[],{id:'empty-group',records:[{namespace:BOT_CHANNEL_ACCESS,id:'empty-group',value:{version:1,context:{platform:'discord',botId:'fixture-bot',channelId:'empty-channel',direct:false},participants:[{actorId:'owner',platformUserId:'fixture-owner'}]}}]});
    const scope=longMemoryScope('owner','group','real',JSON.stringify(['discord','','fixture-bot','empty-channel']));
    // 范围还没有任何记录时不在已保存列表里，工具读到它的版本是 0；比对时不能把「不在列表」当作版本变化。
    expect(await app.storage.longMemoryScopes('owner')).not.toContainEqual(expect.objectContaining({ id: scope.id }));
    const messages:PlatformMessage[]=[{id:'ask',role:'user',isUserInput:true,actorId:'owner',parts:[{text:'整理记忆'}]},
      {id:'calls',role:'model',parts:[{functionCall:{id:'status-call',name:'context_status',args:{}}},{functionCall:{id:'topics-call',name:'memory_topics',args:{limit:30}}}]},
      {id:'status',role:'user',isFunctionResponse:true,parts:[{functionResponse:{id:'status-call',name:'context_status',response:{success:true}}}]},
      {id:'topics',role:'user',isFunctionResponse:true,parts:[{functionResponse:{id:'topics-call',name:'memory_topics',response:{success:true,memoryScopeVersions:[{scopeId:scope.id,invalidation:0}]}}}]}];
    const view=await app.longMemory.history.prepare('owner','empty-group',messages);
    expect(view.blockedIds.size).toBe(0);
    expect(view.messages).toEqual(messages);
    expect(view.messages.some(message=>message.memoryRedacted)).toBe(false);
  });

  test('任务未绑定工作区时不沿用对话中已失效的工作区', async () => {
    const draft = app.settings.snapshot();
    draft.settings.workspaces.push({ id: 'old-workspace', name: '旧工作区', deviceId: 'local', directory: f.root });
    await app.settings.save({ settings: draft.settings, expectedRevision: draft.revision });
    await app.createConversation('owner', '旧工作区对话', 'old-workspace', {}, [], { id: 'memory-stale-workspace' });

    const current = app.settings.snapshot();
    current.settings.workspaces = current.settings.workspaces.filter(workspace => workspace.id !== 'old-workspace');
    await app.settings.save({ settings: current.settings, expectedRevision: current.revision });

    const completed = await run('memory-stale-workspace', '继续普通聊天');
    const access = await app.longMemory.access('owner', { runId: completed.id, conversationId: completed.conversationId });
    expect(access.workspace).toBeUndefined();
  });

  test('分段来源工具返回实际记忆依据，供后续遗忘和上下文清理使用', async () => {
    const scope = longMemoryScope('owner', 'library', 'real', 'source-library');
    await app.storage.putRecord({ namespace: MEMORY_IMPORT_POLICY_NAMESPACE, id: 'owner', value: { enabledScopes: [scope] } });
    const access = { actor: app.requireOwner('owner'), scopes: [scope] };
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
