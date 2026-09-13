import { randomUUID } from 'node:crypto';
import type { ComputerObservation, ComputerWindow, ModelInput, PlatformMessage } from '@graycode/contracts';
import { PlatformApplication } from '../../../apps/server/src/application';
import { ApplicationRouter } from '../../../apps/server/src/transport/router';
import { ComputerError, type ComputerNativePort, type NativeComputerStatus } from '../../../apps/server/src/computer/port';
import { fixture } from './fixtures';

// 这里验证核心运行、身份和持久化边界；Windows 实机输入另有独立验收材料。
class NativeFixture implements ComputerNativePort {
  readonly available = true;
  readonly identity = { pid: 1234, executable: 'fixture-host', startedAt: 1000 };
  state: NativeComputerStatus = { active: false, reason: 'idle', generation: 0 };
  listeners = new Set<(value: NativeComputerStatus) => void>();
  actions: Record<string, unknown>[] = [];
  failure?: ComputerError;
  acquisition?: () => Promise<void>;
  window: ComputerWindow = { id: '98', title: '验收编辑器', className: 'Fixture', processId: 4567, processStartedAt: '2026-09-13T00:00:00Z',
    executable: 'fixture-editor', monitorId: 'left-display', dpi: 144, minimized: false, foreground: true,
    bounds: { x: -1600, y: 100, width: 900, height: 600 }, captureBounds: { x: -1600, y: 100, width: 900, height: 600 } };
  subscribe(listener: (value: NativeComputerStatus) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit() { for (const listener of this.listeners) listener({ ...this.state }); }
  async request<T>(method: string, args: Record<string, any> = {}): Promise<T> {
    if (method === 'windows') return { capturedAt: Date.now(), windows: [this.window], displays: [], coordinateSystem: 'physical-screen-pixels' } as T;
    if (method === 'acquire') {
      await this.acquisition?.();
      this.state = { active: true, owner: args.owner, leaseId: randomUUID(), reason: 'acquired', generation: this.state.generation + 1 }; this.emit(); return this.state as T;
    }
    if (method === 'observe') {
      const id = randomUUID();
      return { id, capturedAt: Date.now(), window: { ...this.window }, truncated: false, focusedElementId: id + ':0',
        elements: [{ id: id + ':0', runtimeId: 'fixture-field', type: 'Edit', name: '演示文字', automationId: 'editor', value: '原文', enabled: true, offscreen: false, password: false, focused: true, patterns: ['Value'], bounds: this.window.bounds }] } as T;
    }
    if (method === 'capture') return { capturedAt: Date.now(), windowId: this.window.id, monitorId: this.window.monitorId, dpi: this.window.dpi,
      bounds: this.window.captureBounds, width: 600, height: 400, mimeType: 'image/png', data: 'ZmFrZQ==' } as T;
    if (method === 'validate') return { valid: true } as T;
    if (method === 'action') {
      if (!this.state.active || args.leaseId !== this.state.leaseId) throw new ComputerError('CONTROL_RELEASED', '控制权已释放');
      this.actions.push(args); if (this.failure) throw this.failure;
      return { performed: true, action: args.action, x: args.x, y: args.y } as T;
    }
    throw new Error('Unexpected native fixture operation: ' + method);
  }
  async stop(reason: string) { this.state = { active: false, reason, generation: this.state.generation + 1 }; this.emit(); }
  async close() { await this.stop('host_closed'); }
}

describe('电脑控制的核心运行与授权', () => {
  let f: Awaited<ReturnType<typeof fixture>>, app: PlatformApplication, native: NativeFixture;
  let generate: (input: ModelInput) => Promise<PlatformMessage>;
  const client = { actorId: 'owner', clientId: 'computer-fixture-client' };
  const open = () => PlatformApplication.open({ dataDirectory: f.data, computerNative: native, models: { generate: input => generate(input) } });
  beforeEach(async () => {
    f = await fixture(); await f.store.close(); native = new NativeFixture(); generate = async () => ({ role: 'model', parts: [{ text: '完成' }] }); app = await open();
  });
  afterEach(async () => { await app.close(); await f.cleanup(); });

  test('运行器传递真实账号与任务身份，工具结果进入历史，任务结束释放控制权', async () => {
    const draft = await app.product.draft();
    const providerId = await draft.configs.createConfig({ name: '电脑验收渠道', type: 'openai', url: 'http://127.0.0.1:1/v1', model: 'fixture', apiKey: '', enabled: true, contextManagementEnabled: false, timeout: 1000 });
    await app.product.save(draft);
    const settings = app.settings.snapshot(); const agent = settings.settings.agents.find(value => value.id === 'default')!;
    agent.toolApproval = Object.fromEntries(['computer_windows','computer_control','computer_observe','computer_action'].map(name => [name,'auto'])); agent.reviewerToolNames = [];
    await app.settings.save({ settings: settings.settings, expectedRevision: settings.revision });
    let iteration = 0;
    const result = (input: ModelInput, name: string): any => input.messages.flatMap(message => message.parts).findLast(part => (part.functionResponse as any)?.name === name)?.functionResponse;
    generate = async input => {
      let name: string, args: object;
      switch (++iteration) {
        case 1: name='computer_windows';args={};break;
        case 2: name='computer_control';args={action:'acquire',windowIds:[result(input,'computer_windows').response.data.windows[0].id]};break;
        case 3: name='computer_observe';args={windowId:'98',screenshot:true};break;
        case 4: name='computer_action';args={observationId:result(input,'computer_observe').response.data.id,action:'type',text:'来自工具的文字'};break;
        default: return {role:'model',parts:[{text:'已完成'}]};
      }
      return {role:'model',parts:[{functionCall:{id:'computer-'+iteration,name,args}}]};
    };
    const router = new ApplicationRouter(app), conversation = await app.createConversation('owner','电脑运行验收');
    const run = await router.call(client,'runs.start',{conversationId:conversation.id,agentId:'default',providerId,requestKey:'computer-run',text:'在测试应用输入文字。',actorId:'forged'}) as {id:string};
    expect((await app.runtime.wait(run.id))?.status).toBe('completed');
    expect(native.actions).toHaveLength(1);expect(native.actions[0]).toMatchObject({action:'type',text:'来自工具的文字'});
    expect(app.computer.status('owner').active).toBe(false);
    const history = await app.storage.readFullHistory(conversation.id);
    expect(history.messages.flatMap(message=>message.parts).filter(part=>part.functionResponse)).toHaveLength(4);
    const records = await app.storage.listRecords('computer-actions');expect(records).toHaveLength(1);
    expect(await app.storage.getRecord('computer-actions',records[0])).toMatchObject({actorId:'owner',runId:run.id,status:'completed'});
  });

  test('账号授权、客户端观察隔离和撤销会约束实际派发', async () => {
    const settings=app.settings.snapshot();settings.settings.accounts.push({id:'member',displayName:'成员',role:'member',effects:[],workspaceIds:[]});
    await app.settings.save({settings:settings.settings,expectedRevision:settings.revision});
    const member={actorId:'member',clientId:'member-client'};
    await expect(app.computer.windows(member)).rejects.toMatchObject({code:'COMPUTER_FORBIDDEN'});
    const grant=app.settings.snapshot();grant.settings.accounts.find(value=>value.id==='member')!.effects=['desktop_control'];await app.settings.save({settings:grant.settings,expectedRevision:grant.revision});
    await app.computer.acquire(member,['98']);const observation=await app.computer.observe(member,{windowId:'98'});
    await expect(app.computer.acquire(client,['98'])).rejects.toMatchObject({code:'CONTROL_BUSY'});
    await expect(app.computer.action(client,{observationId:observation.id,action:'type',text:'不应输入'},'wrong-client')).rejects.toMatchObject({code:'OBSERVATION_STALE'});
    const revoke=app.settings.snapshot();revoke.settings.accounts.find(value=>value.id==='member')!.revoked=true;await app.settings.save({settings:revoke.settings,expectedRevision:revoke.revision});
    expect(native.state).toMatchObject({active:false,reason:'permission_revoked'});expect(native.actions).toHaveLength(0);
  });

  test('负坐标和缩放使用实际图片尺寸，已派发请求跨重启去重', async () => {
    await app.computer.acquire(client,['98']);const observation=await app.computer.observe(client,{windowId:'98',screenshot:true});
    const args={observationId:observation.id,action:'click' as const,coordinateSpace:'image' as const,x:300,y:200};
    expect(await app.computer.action(client,args,'one-click')).toMatchObject({performed:true,x:-1150,y:400});
    expect(await app.computer.action(client,args,'one-click')).toMatchObject({repeated:true});expect(native.actions).toHaveLength(1);
    await app.close();native=new NativeFixture();app=await open();
    expect(await app.computer.action(client,args,'one-click')).toMatchObject({repeated:true});expect(native.actions).toHaveLength(0);
    await expect(app.computer.action(client,{...args,x:10},'one-click')).rejects.toMatchObject({code:'OPERATION_CONFLICT'});
    await app.computer.acquire(client,['98']);const next=await app.computer.observe(client,{windowId:'98'});native.failure=new ComputerError('OPERATION_UNKNOWN','响应丢失');
    const uncertain={observationId:next.id,action:'type' as const,text:'只派发一次'};
    await expect(app.computer.action(client,uncertain,'unknown-input')).rejects.toMatchObject({code:'OPERATION_UNKNOWN'});
    await expect(app.computer.action(client,uncertain,'unknown-input')).rejects.toMatchObject({code:'OPERATION_UNKNOWN'});expect(native.actions).toHaveLength(1);
  });

  test('人工接管后模型不能自行恢复，取消和晚到的控制权响应不能继续操作', async () => {
    const signal=new AbortController(),identity={actorId:'owner',runId:'fixture-run',signal:signal.signal};
    await app.computer.acquire(identity,['98']);await native.stop('user_input');
    await expect(app.computer.acquire(identity,['98'])).rejects.toMatchObject({code:'USER_TAKEOVER'});
    await app.computer.call(client,'computer.allowRun',{runId:'fixture-run'});await app.computer.acquire(identity,['98']);
    signal.abort();await Promise.resolve();expect(native.state.active).toBe(false);
    let allow!:()=>void,entered!:()=>void;const entering=new Promise<void>(resolve=>{entered=resolve;});native.acquisition=()=>{entered();return new Promise<void>(resolve=>{allow=resolve;});};
    const late=app.computer.acquire(client,['98']);const rejected=expect(late).rejects.toMatchObject({code:'CONTROL_CHANGED'});
    await entering;await app.computer.stop('owner');allow();await rejected;expect(native.state.active).toBe(false);
  });
});
