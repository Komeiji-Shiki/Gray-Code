import { randomUUID } from 'node:crypto';
import type { ComputerObservation, ComputerWindow, ModelInput, PlatformMessage } from '@graycode/contracts';
import { PlatformApplication } from '../../../apps/server/src/application';
import { ApplicationRouter } from '../../../apps/server/src/transport/router';
import { ComputerError, type ComputerNativePort, type NativeComputerStatus } from '../../../apps/server/src/computer/port';
import { fixture } from './fixtures';
import { observationForModel } from '../../../apps/server/src/computer/observation';

// 这里验证核心运行、身份和持久化边界；Windows 实机输入另有独立验收材料。
class NativeFixture implements ComputerNativePort {
  readonly available = true;
  readonly identity = { pid: 1234, executable: 'fixture-host', startedAt: 1000 };
  state: NativeComputerStatus = { active: false, reason: 'idle', generation: 0 };
  listeners = new Set<(value: NativeComputerStatus) => void>();
  actions: Record<string, unknown>[] = [];
  failure?: ComputerError;
  captureFailure?: ComputerError;
  acquisition?: () => Promise<void>;
  owned: Record<string, string[]> = {};
  targets: string[] = [];
  window: ComputerWindow = { id: '98', title: '验收编辑器', className: 'Fixture', processId: 4567, processStartedAt: '2026-09-13T00:00:00Z',
    executable: 'fixture-editor', monitorId: 'left-display', dpi: 144, minimized: false, foreground: true,
    bounds: { x: -1600, y: 100, width: 900, height: 600 }, captureBounds: { x: -1600, y: 100, width: 900, height: 600 } };
  subscribe(listener: (value: NativeComputerStatus) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit() { for (const listener of this.listeners) listener({ ...this.state }); }
  async request<T>(method: string, args: Record<string, any> = {}): Promise<T> {
    if (method === 'windows') return { capturedAt: Date.now(), windows: [this.window], displays: [], coordinateSystem: 'physical-screen-pixels' } as T;
    if (method === 'acquire') {
      await this.acquisition?.();
      // 与宿主一致：隐藏宿主窗口会带上名下的可见窗口，replace/add 只在同一租约仍有效时修改范围。
      const expand = (ids: string[]) => ids.flatMap(id => [id, ...(this.owned[id] ?? [])]);
      const target = (id: string) => ({ id, title: id === this.window.id ? this.window.title : `窗口 ${id}`, className: 'Fixture', processId: this.window.processId, ownerId: this.owned[id] ? '0' : Object.keys(this.owned).find(owner => this.owned[owner].includes(id)) ?? '0' });
      const notice = (args.windowIds as string[]).some(id => this.owned[id]) ? '已一并纳入可见窗口' : null;
      if (args.mode) {
        if (!this.state.active || args.leaseId !== this.state.leaseId) throw new ComputerError('CONTROL_RELEASED', '控制权已停止或被用户接管');
        this.targets = [...new Set([...(args.mode === 'add' ? this.targets : []), ...expand(args.windowIds)])];
        return { ...this.state, targets: this.targets.map(target), notice } as T;
      }
      this.targets = [...new Set(expand(args.windowIds))];
      this.state = { active: true, owner: args.owner, leaseId: randomUUID(), reason: 'acquired', generation: this.state.generation + 1 }; this.emit();
      return { ...this.state, targets: this.targets.map(target), notice } as T;
    }
    if (method === 'observe') {
      const id = randomUUID();
      return { id, capturedAt: Date.now(), window: { ...this.window }, truncated: false, focusedElementId: id + ':0',
        elements: [{ id: id + ':0', runtimeId: 'fixture-field', type: 'Edit', name: '演示文字', automationId: 'editor', value: '原文', enabled: true, offscreen: false, password: false, focused: true, patterns: ['Value'], bounds: this.window.bounds }] } as T;
    }
    if (method === 'capture' && this.captureFailure) throw this.captureFailure;
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
    // 旧设置没有电脑工具的独立键，仍应遵守自动执行页的勾选状态。
    agent.approvalMode = 'all_mutations'; agent.reviewerToolNames = [];
    await app.settings.save({ settings: settings.settings, expectedRevision: settings.revision });
    const approvals: unknown[] = [];
    app.subscribe(notification => {
      const event = notification.event as any;
      if (event?.type === 'approval.requested') { approvals.push(event.payload); void app.runtime.resolveApproval(event.payload.id, 'owner', false); }
    });
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
    expect(approvals).toEqual([]);
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

  test('默认截图观察使用轻量焦点读取，动作后返回新图，截图失败不会重做动作', async () => {
    const context = { actorId: 'owner', runId: 'visual-loop', iteration: 0, toolCallId: 'click', signal: new AbortController().signal } as any;
    const request = jest.spyOn(native, 'request');
    await app.computer.tool('computer_control', { action: 'acquire', windowIds: ['98'] }, context);
    const observed = await app.computer.tool('computer_observe', { windowId: '98' }, context);
    expect(request).toHaveBeenCalledWith('observe', expect.objectContaining({ includeElements: false }), context.signal);
    expect(observed.attachments).toHaveLength(1);
    const args = { observationId: (observed.data as any).id, action: 'click', coordinateSpace: 'image', x: 300, y: 200 };
    const completed = await app.computer.tool('computer_action', args, context);
    expect(completed).toMatchObject({ success: true, data: { status: 'completed' } });
    expect(completed.attachments).toHaveLength(1);
    expect((completed.data as any).observation.id).not.toBe(args.observationId);
    native.captureFailure = new ComputerError('CAPTURE_FAILED', '夹具截图失败');
    const next = { ...args, observationId: (completed.data as any).observation.id };
    const nextContext = { ...context, toolCallId: 'next-click' };
    const partial = await app.computer.tool('computer_action', next, nextContext);
    expect(partial).toMatchObject({ success: true, data: { status: 'completed', observationError: { code: 'CAPTURE_FAILED' } } });
    const count = native.actions.length;
    const repeated = await app.computer.tool('computer_action', next, nextContext);
    expect(repeated).toMatchObject({ success: true, data: { status: 'completed', repeated: true } });
    expect(native.actions).toHaveLength(count);
  });

  test('精简观察保留操作字段和坐标，完整观察按需读取且内部原文不变', async () => {
    const value = await app.computer.observe(client, { windowId: '98', screenshot: true });
    value.elements = Array.from({ length: 120 }, (_, index) => ({ ...value.elements[0], id: `${value.id}:${index}`,
      runtimeId: `internal-runtime-${index}`, automationId: '', name: `按钮 ${index}`, value: undefined, focused: false, patterns: [] }));
    value.elements[0].enabled = false; value.elements[1].offscreen = true; value.elements[2].password = true;
    const before = structuredClone(value), compact = observationForModel(value), full = observationForModel(value, false);
    expect(compact.elements[0]).toMatchObject({ id: value.elements[0].id, enabled: false, bounds: native.window.bounds });
    expect(compact.elements[1]).toMatchObject({ offscreen: true }); expect(compact.elements[2]).toMatchObject({ password: true });
    expect(compact.elements[3]).not.toHaveProperty('runtimeId'); expect(compact).toHaveProperty('elementDefaults.enabled', true);
    expect(full.elements[3]).toHaveProperty('runtimeId', 'internal-runtime-3'); expect(full.screenshot).not.toHaveProperty('data', 'ZmFrZQ==');
    expect(JSON.stringify(compact).length).toBeLessThan(JSON.stringify(full).length * 0.7); expect(value).toEqual(before);
  });

  test('窗口列表按进程和标题筛选，默认只返回选窗所需字段', async () => {
    const extra: ComputerWindow[] = [
      { ...native.window, id: '200', title: 'Game Maker', className: 'TApplication', processId: 777, executable: 'C:\\Games\\gm8emulator.exe', ownerId: '0', foreground: false, commandLine: 'gm8emulator.exe game.exe' },
      { ...native.window, id: '201', title: 'Game Window', className: 'TRunnerForm', processId: 777, executable: 'C:\\Games\\gm8emulator.exe', ownerId: '200', foreground: false, minimized: true },
    ];
    const request = native.request.bind(native);
    jest.spyOn(native, 'request').mockImplementation(async (method, args) => method === 'windows'
      ? { capturedAt: 1, windows: [native.window, ...extra], displays: [{ id: 'd1', bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 }, scaleFactor: 1.5, primary: true }], coordinateSystem: 'physical-screen-pixels' } as any
      : request(method, args));
    const context = { actorId: 'owner', runId: 'window-filter', signal: new AbortController().signal } as any;
    const all = (await app.computer.tool('computer_windows', {}, context)).data as any;
    expect(all.windows).toHaveLength(3); expect(all).not.toHaveProperty('matchedCount');
    expect(all.windows[1]).toEqual({ id: '200', title: 'Game Maker', processName: 'gm8emulator.exe', processId: 777, className: 'TApplication', bounds: native.window.bounds });
    expect(all.windows[2]).toMatchObject({ id: '201', ownerId: '200', minimized: true }); expect(all.windows[0]).toMatchObject({ foreground: true });
    expect(all.displays).toEqual([{ id: 'd1', bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1.5, primary: true }]);
    const byName = (await app.computer.tool('computer_windows', { processName: 'GM8Emulator' }, context)).data as any;
    expect(byName.windows.map((value: any) => value.id)).toEqual(['200', '201']); expect(byName).toMatchObject({ matchedCount: 2, totalCount: 3 });
    const byTitle = (await app.computer.tool('computer_windows', { processId: 777, title: 'window' }, context)).data as any;
    expect(byTitle.windows.map((value: any) => value.id)).toEqual(['201']);
    const full = (await app.computer.tool('computer_windows', { processName: 'gm8emulator.exe', compact: false }, context)).data as any;
    expect(full.windows[0]).toMatchObject({ commandLine: 'gm8emulator.exe game.exe', dpi: 144, captureBounds: native.window.captureBounds }); expect(full.displays[0]).toHaveProperty('workArea');
    const none = (await app.computer.tool('computer_windows', { processId: 1 }, context)).data as any;
    expect(none).toMatchObject({ windows: [], matchedCount: 0, totalCount: 3 });
  });

  test('模型观察使用截图预算，返回的元素仍可操作并按实际图片映射坐标', async () => {
    const request = jest.spyOn(native, 'request');
    const context = { actorId: 'owner', runId: 'compact-observation', signal: new AbortController().signal } as any;
    await app.computer.tool('computer_control', { action: 'acquire', windowIds: ['98'] }, context);
    const result = await app.computer.tool('computer_observe', { windowId: '98', screenshot: true }, context);
    const data = result.data as any;
    expect(request).toHaveBeenCalledWith('capture', expect.objectContaining({ width: 1280, height: 1280 }), context.signal);
    expect(data.screenshot).toMatchObject({ width: 600, height: 400 }); expect(data.elements[0]).not.toHaveProperty('runtimeId');
    expect(result.attachments).toEqual([expect.objectContaining({ data: 'ZmFrZQ==' })]);
    const action = await app.computer.tool('computer_action', { observationId: data.id, action: 'click', coordinateSpace: 'image', x: 300, y: 200 }, { ...context, toolCallId: 'compact-click' });
    expect(action).toMatchObject({ success: true, data: { performed: true, x: -1150, y: 400 } });
    const detailed = await app.computer.tool('computer_observe', { windowId: '98', compact: false }, context);
    expect((detailed.data as any).elements[0].runtimeId).toBe('fixture-field');
  });

  test('模型可直接替换或追加控制目标，隐藏宿主窗口带上可见窗口，人工接管后仍不能重新取得', async () => {
    native.owned = { '50': ['51'] };
    const context = { actorId: 'owner', runId: 'retarget', signal: new AbortController().signal } as any;
    const first = await app.computer.tool('computer_control', { action: 'acquire', windowIds: ['98'] }, context);
    expect(first).toMatchObject({ success: true, data: { active: true, controller: { windowIds: ['98'] } } }); expect(first.data).not.toHaveProperty('notice');
    const lease = native.state.leaseId;
    const replaced = await app.computer.tool('computer_control', { action: 'acquire', windowIds: ['50'] }, context);
    expect(replaced).toMatchObject({ success: true, data: { active: true, controller: { windowIds: ['50', '51'] }, notice: '已一并纳入可见窗口' } });
    expect((replaced.data as any).targets).toEqual([expect.objectContaining({ id: '50' }), expect.objectContaining({ id: '51', ownerId: '50' })]);
    expect((replaced.data as any).targets[0]).not.toHaveProperty('ownerId'); expect(native.state.leaseId).toBe(lease);
    const added = await app.computer.tool('computer_control', { action: 'acquire', windowIds: ['98'], mode: 'add' }, context);
    expect((added.data as any).controller.windowIds).toEqual(['50', '51', '98']);
    // 未指定 mode 的调用（界面和执行节点）保持严格语义。
    const identity = { actorId: 'owner', runId: 'retarget', signal: context.signal };
    await expect(app.computer.acquire(identity, ['50', '98'])).resolves.toMatchObject({ active: true });
    await expect(app.computer.acquire(identity, ['99'])).rejects.toMatchObject({ code: 'TARGET_CHANGED', message: expect.stringContaining('mode=replace') });
    await native.stop('user_input');
    expect(await app.computer.tool('computer_control', { action: 'acquire', windowIds: ['98'] }, context)).toMatchObject({ success: false, code: 'USER_TAKEOVER' });
    expect(native.state.active).toBe(false);
  });

  test('修改控制范围时租约已失效，不会变成重新取得控制权', async () => {
    const context = { actorId: 'owner', runId: 'stale-lease', signal: new AbortController().signal } as any;
    await app.computer.tool('computer_control', { action: 'acquire', windowIds: ['98'] }, context);
    native.state = { ...native.state, leaseId: 'replaced-by-another-session' };
    expect(await app.computer.tool('computer_control', { action: 'acquire', windowIds: ['99'] }, context)).toMatchObject({ success: false, code: 'CONTROL_RELEASED' });
    expect(native.state.leaseId).toBe('replaced-by-another-session');
  });

  test('观察在持有控制权时把租约交给宿主采集，并说明重定向和前台切换', async () => {
    native.window = { ...native.window, foreground: false };
    const request = native.request.bind(native);
    const spy = jest.spyOn(native, 'request').mockImplementation(async (method, args) => {
      const value: any = await request(method, args);
      if (method === 'observe') Object.assign(value, { redirectedFrom: '50', notice: '已改为观察可见窗口 98。', accessibilityError: null });
      if (method === 'capture') Object.assign(value, args?.leaseId ? { method: 'visible-screen-region', notice: '已切到前台后截图。' } : { method: 'print-window', notice: null });
      return value;
    });
    const context = { actorId: 'owner', runId: 'background-capture', signal: new AbortController().signal } as any;
    const background = (await app.computer.tool('computer_observe', { windowId: '50' }, context)).data as any;
    expect(spy).toHaveBeenCalledWith('capture', expect.not.objectContaining({ leaseId: expect.anything() }), context.signal);
    expect(background).toMatchObject({ redirectedFrom: '50', notice: '已改为观察可见窗口 98。', window: { id: '98', foreground: false }, screenshot: { method: 'print-window' } });
    expect(background).not.toHaveProperty('accessibilityError'); expect(background.screenshot).not.toHaveProperty('notice');
    await app.computer.tool('computer_control', { action: 'acquire', windowIds: ['98'] }, context);
    const focused = (await app.computer.tool('computer_observe', { windowId: '98' }, context)).data as any;
    expect(spy).toHaveBeenCalledWith('capture', expect.objectContaining({ leaseId: native.state.leaseId }), context.signal);
    expect(focused).toMatchObject({ notice: '已改为观察可见窗口 98。 已切到前台后截图。', window: { foreground: true }, screenshot: { method: 'visible-screen-region' } });
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
