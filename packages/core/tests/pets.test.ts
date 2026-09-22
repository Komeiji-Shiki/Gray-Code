import sharp from 'sharp';
import type { PetConfiguration, PetImport, PetSnapshot } from '@graycode/contracts';
import { PlatformApplication } from '../../../apps/server/src/application';
import { petAnimations } from '../../../shared/petFormat';
import { fixture } from './fixtures';

const client = { actorId: 'owner', clientId: 'pet-client' };
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64');
async function atlas(version: 1 | 2 = 2): Promise<PetImport> {
  const width = 1536, height = version === 2 ? 2288 : 1872, pixels = Buffer.alloc(width * height * 4);
  // 合同验证用的原始像素夹具，不作为真实桌宠播放验收素材。
  for (let row = 0; row < height / 208; row++) for (let col = 0; col < 8; col++) {
    if (row < 9 && col >= petAnimations[row]!.frames && !(row === 0 && col === 6)) continue;
    const offset = ((row * 208 + 70) * width + col * 192 + 80) * 4;
    pixels.set([120, 180, 220, 255], offset);
  }
  const png = await sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer();
  return { entry: 'pet.json', files: [{ path: 'pet.json', data: encode({ id: 'fixture', displayName: '合同测试桌宠', spriteVersionNumber: version, spritesheetPath: 'art/atlas.png' }) }, { path: 'art/atlas.png', data: png.toString('base64') }] };
}
describe('桌宠资源与统一控制', () => {
  let f: Awaited<ReturnType<typeof fixture>>, app: PlatformApplication, bundle: PetImport;
  const open = () => PlatformApplication.open({ dataDirectory: f.data, documentsDirectory: f.root, models: { generate: async () => ({ role: 'model', parts: [{ text: '这条回复属于桌宠选择的同一段对话。' }] }) } });
  beforeAll(async () => { bundle = await atlas(); });
  beforeEach(async () => { f = await fixture(); await f.store.close(); app = await open(); });
  afterEach(async () => { jest.restoreAllMocks(); await app.close(); await f.cleanup(); });
  const state = () => app.pets.snapshot();
  const configure = async (values: Partial<PetConfiguration>) => { const current = await state(); return app.pets.call(client, 'pets.configure', { configuration: { ...current.configuration, ...values }, revision: current.revision }) as Promise<PetSnapshot>; };
  const renderer = async (parameters: unknown[] = []) => {
    const value = await state(); const identity = { rendererId: 'test-renderer', generation: value.state.generation };
    await app.pets.call(client, 'pets.renderer.claim', { ...identity, surface: 'app' });
    await app.pets.call(client, 'pets.renderer.ready', { ...identity, parameters }); return identity;
  };
  const currentCommand = async () => {
    for (let count = 0; count < 100; count++) { const command = (await state()).state.current; if (command) return command; await new Promise(resolve => setTimeout(resolve, 5)); }
    throw new Error('没有收到控制命令。');
  };
  test('按清单校验两种图集版本、透明格与包内路径，重启后原文件保持一致', async () => {
    const resource = await app.pets.resources.import(bundle); expect(resource.actions).toHaveLength(9); expect(resource.sprite).toMatchObject({ version: 2, neutral: true, height: 2288 });
    expect((await app.pets.resources.import(await atlas(1))).sprite?.height).toBe(1872);
    await expect(app.pets.resources.import({ ...bundle, entry: '../pet.json' })).rejects.toThrow('超出');
    await expect(app.pets.resources.import({ ...bundle, files: [bundle.files[0]!] })).rejects.toThrow('缺少');
    const invalid = { ...bundle, files: [{ path: 'pet.json', data: encode({ spriteVersionNumber: 1, spritesheetPath: 'art/atlas.png' }) }, bundle.files[1]!] };
    await expect(app.pets.resources.import(invalid)).rejects.toThrow('1536');
    await configure({ resourceId: resource.id, visible: true, reducedMotion: true, taskAnimations: false });
    const revision = (await state()).revision; await app.pets.call(client, 'pets.position', { position: { x: 80, y: 120 } }); expect((await state()).revision).toBe(revision);
    await app.close(); app = await open(); expect((await state()).configuration).toMatchObject({ resourceId: resource.id, visible: true, reducedMotion: true, position: { x: 80, y: 120 } });
    expect((await app.pets.resources.bundle(resource.id)).files).toEqual([...bundle.files].sort((a,b) => a.path.localeCompare(b.path)));
  });
  test('工具等待实际显示确认，停止和模型切换使旧请求失效', async () => {
    const resource = await app.pets.resources.import(bundle); await configure({ resourceId: resource.id, visible: true, taskAnimations: false });
    const identity = await renderer();
    const result = app.pets.command({ action: 'play', id: 'waving', durationMs: 10000 }, { source: 'model', actorId: 'owner', runId: 'task-a' });
    const command = await currentCommand(); expect((await state()).state.applied).toBeUndefined();
    expect(await app.pets.command({ action: 'play', id: 'jumping' }, { source: 'model', actorId: 'owner', runId: 'task-b' })).toMatchObject({ success: false, accepted: false });
    await app.pets.call(client, 'pets.renderer.applied', { ...identity, requestId: command.requestId, success: true }); expect(await result).toMatchObject({ success: true, accepted: true, applied: true, resourceId: resource.id });
    const pending = app.pets.command({ action: 'look', angle: 90 }, { source: 'manual', actorId: 'owner' }); await new Promise(resolve => setTimeout(resolve, 10));
    await configure({ stopped: true }); expect(await pending).toMatchObject({ success: false, applied: false });
    expect(await app.pets.command({ action: 'resume' }, { source: 'model', actorId: 'owner', runId: 'task-a' })).toMatchObject({ success: false, accepted: false });
    await configure({ visible: false }); await expect(app.pets.call(client, 'pets.renderer.ready', { ...identity, parameters: [] })).rejects.toThrow('切换');
    await expect(app.pets.call({ actorId: 'unknown', clientId: 'x' }, 'pets.bundle', { id: resource.id })).rejects.toThrow();
  });

  test('关闭任务动画立即撤下自动动作，并保留用户主动播放',async()=>{
    const resource=await app.pets.resources.import(bundle);await configure({resourceId:resource.id,visible:true,taskAnimations:true});
    const identity=await renderer(),automatic=await currentCommand();expect(automatic.source).toBe('task');
    await app.pets.call(client,'pets.renderer.applied',{...identity,requestId:automatic.requestId,success:true});
    await configure({taskAnimations:false});expect((await state()).state.current).toBeUndefined();
    const result=app.pets.command({action:'play',id:'waving',durationMs:10000},{source:'manual',actorId:'owner'});
    const manual=await currentCommand();await app.pets.call(client,'pets.renderer.applied',{...identity,requestId:manual.requestId,success:true});await result;
    await configure({taskAnimations:true});await configure({taskAnimations:false});expect((await state()).state.current?.requestId).toBe(manual.requestId);
  });

  test('迟到的任务状态读取不会在自动动画已关闭后重新播放',async()=>{
    const resource=await app.pets.resources.import(bundle);await configure({resourceId:resource.id,visible:true,taskAnimations:false});await renderer();
    let resolveRuns:(value:any)=>void=()=>{};const pending=new Promise<any>(resolve=>resolveRuns=resolve);
    jest.spyOn(app.storage,'listRuns').mockImplementationOnce(()=>pending);
    jest.spyOn(app.pets.resources,'get').mockResolvedValue(resource);
    const commands=jest.spyOn(app.pets,'command');
    await configure({taskAnimations:true});await configure({taskAnimations:false});
    resolveRuns([{status:'running'}]);await new Promise<void>(resolve=>setImmediate(resolve));
    expect(commands).not.toHaveBeenCalled();expect((await state()).state.current).toBeUndefined();
  });

  test('读取显示资源期间撤销的权限不能继续发出动作',async()=>{
    const resource=await app.pets.resources.import(bundle);await configure({resourceId:resource.id,visible:true,taskAnimations:false});await renderer();
    const snapshot=await state(),owner=app.actor('owner')!;
    let resolveSnapshot:(value:PetSnapshot)=>void=()=>{};
    jest.spyOn(app.pets,'snapshot').mockImplementationOnce(()=>new Promise(resolve=>resolveSnapshot=resolve));
    const actors=jest.spyOn(app,'actor').mockReturnValueOnce(owner).mockReturnValue({...owner,revoked:true});
    const command=app.pets.command({action:'play',id:'waving'},{source:'model',actorId:'owner',runId:'fixture'});
    const rejected=expect(command).rejects.toThrow();resolveSnapshot(snapshot);await rejected;actors.mockRestore();
    expect((await state()).state.current).toBeUndefined();
  });
  test('从模型清单读取自定义动作和表情，参数采用运行库报告的真实范围', async () => {
    const texture = await sharp({ create: { width: 2, height: 2, channels: 4, background: '#ffffffff' } }).png().toBuffer();
    const model = { Version: 3, FileReferences: { Moc: 'body.moc3', Textures: ['texture.png'], Expressions: [{ Name: '开心的表情', File: 'smile.exp3.json' }], Motions: { 招手: [{ File: 'hello.motion3.json' }] } } };
    const resource = await app.pets.resources.import({ entry: 'person.model3.json', files: [
      { path: 'person.model3.json', data: encode(model) }, { path: 'body.moc3', data: Buffer.from('MOC3-fixture-not-a-real-model').toString('base64') }, { path: 'texture.png', data: texture.toString('base64') },
      { path: 'smile.exp3.json', data: encode({ Type: 'Live2D Expression', Parameters: [] }) }, { path: 'hello.motion3.json', data: encode({ Version: 3, Meta: { Duration: 2 }, Curves: [] }) },
    ] });
    expect(resource.actions[0]).toMatchObject({ id: '招手/0', group: '招手', index: 0, durationMs: 2000 }); expect(resource.expressions[0]?.id).toBe('开心的表情');
    await configure({ resourceId: resource.id, visible: true, taskAnimations: false });
    const identity = await renderer([{ id: 'CustomLean', min: -2, max: 2, default: 0 }]);
    await expect(app.pets.command({ action: 'parameters', parameters: { CustomLean: 3 } }, { source: 'manual', actorId: 'owner' })).rejects.toThrow('超出');
    const applied = app.pets.command({ action: 'parameters', parameters: { CustomLean: 1.5 } }, { source: 'manual', actorId: 'owner' }); const command = await currentCommand();
    await app.pets.call(client, 'pets.renderer.applied', { ...identity, requestId: command.requestId, success: true }); expect(await applied).toMatchObject({ applied: true });
  });
  test('桌宠交流沿用同一个普通对话及其运行记录，隐藏资源不取消任务', async () => {
    const draft = await app.product.draft(); const configId = await draft.configs.createConfig({ name: '桌宠集成测试', type: 'openai', url: 'http://127.0.0.1:1/v1', model: 'fixture', apiKey: '', enabled: true, contextManagementEnabled: false, timeout: 1000 }); await app.product.save(draft);
    const conversation = await app.pets.call(client, 'pets.chat.create', {}) as { id: string };
    const result = await app.pets.call(client, 'pets.chat.send', { conversationId: conversation.id, configId, message: '请在这段对话继续。', streamId: 'pet-chat-1' }) as { runId: string };
    expect((await app.runtime.wait(result.runId))?.status).toBe('completed');
    const inbox = await app.pets.call(client, 'pets.inbox', { conversationId: conversation.id }) as any;
    expect(inbox.history.map((message: any) => message.text).join('')).toContain('同一段对话'); expect(inbox.runs[0]).toMatchObject({ id: result.runId, conversationId: conversation.id });
    await configure({ visible: false }); expect((await app.storage.getRun(result.runId))?.status).toBe('completed');
    await app.productUi.call(client, 'ui.mode.select', { conversationId: conversation.id, mode: 'code' });
    const changed = await app.pets.call(client, 'pets.inbox', { conversationId: conversation.id }) as any;
    expect(changed.selectedConversationId).toBeUndefined(); expect(changed.providers).not.toHaveLength(0);
  });
});
