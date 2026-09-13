import type { ComputerCapture, ComputerObservation, ComputerWindow, ModelInput, PlatformMessage, ScreenSenseConfiguration, ScreenSenseSnapshot } from '@graycode/contracts';
import { PlatformApplication } from '../../../apps/server/src/application';
import type { ComputerNativePort, ComputerScreenPort } from '../../../apps/server/src/computer/port';
import { fixture } from './fixtures';
const client = { actorId: 'owner', clientId: 'screen-client' };
// 只验证采集边界与真实运行器存储；Windows 截图另由专用测试窗口验收。
class CaptureFixture implements ComputerNativePort, ComputerScreenPort {
  readonly available = true; captures = 0; nativeCaptures = 0; hold?: () => Promise<void>;
  window: ComputerWindow = { id: '12', title: '测试画面', className: 'OwnedFixture', processId: 42, processStartedAt: 'fixed-start', executable: 'fixture', monitorId: 'display-1', dpi: 96,
    minimized: false, foreground: true, bounds: { x: 0, y: 0, width: 2, height: 2 }, captureBounds: { x: 0, y: 0, width: 2, height: 2 } };
  async request<T>(method: string): Promise<T> {
    if (method === 'windows') return { capturedAt: Date.now(), windows: [{ ...this.window }], displays: [], coordinateSystem: 'physical-screen-pixels' } as T;
    if (method === 'observe') return { id: 'observation', capturedAt: Date.now(), window: { ...this.window }, elements: [], truncated: false } as T;
    if (method === 'capture') { this.nativeCaptures++; throw new Error('窗口感知不应采集可见屏幕区域'); }
    return {} as T;
  }
  async capture(observation: ComputerObservation): Promise<ComputerCapture> { this.captures++; await this.hold?.(); return { capturedAt: Date.now(), windowId: '12', monitorId: 'display-1', dpi: 96, bounds: observation.window.bounds, width: 1, height: 1,
    mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXz0AAAAASUVORK5CYII=', method: 'window' }; }
  subscribe() { return () => {}; } async stop() {} async close() {}
}
describe('屏幕感知独立开启、范围与用量', () => {
  let f: Awaited<ReturnType<typeof fixture>>, app: PlatformApplication, native: CaptureFixture, inputs: ModelInput[], providerId: string, conversationId: string;
  const open = () => PlatformApplication.open({ dataDirectory: f.data, documentsDirectory: f.root, computerNative: native, computerCapture: native,
    models: { generate: async input => { inputs.push(input); return { role: 'model', parts: [{ text: '已经根据所选画面回复。' }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, cachedContentTokenCount: 30 } } as PlatformMessage; } } });
  const rpc = (method: string, params: Record<string, unknown> = {}) => app.screenSense.call(client, method, params);
  const config = (): ScreenSenseConfiguration => ({ target: { kind: 'window', window: native.window }, trigger: 'manual', delivery: 'preview', maxCaptures: 2, conversationId, providerId, prompt: '看看这个窗口。', prices: { currency: 'TEST', input: 2, output: 4, cacheRead: 1, cacheWrite: 3 } });
  const save = async (value = config()) => rpc('screenSense.configure', { configuration: value, revision: (await app.screenSense.snapshot()).revision });
  beforeEach(async () => { f = await fixture(); await f.store.close(); native = new CaptureFixture(); inputs = []; app = await open(); const draft = await app.product.draft();
    providerId = await draft.configs.createConfig({ name: '屏幕测试渠道', type: 'openai', url: 'http://127.0.0.1:1/v1', model: 'fixture', apiKey: '', enabled: true, contextManagementEnabled: false, timeout: 1000 }); await app.product.save(draft);
    conversationId = (await app.createConversation('owner', '屏幕交流', undefined, { platformMode: 'chat' }, [], { automaticWorkspace: true })).id;
  });
  afterEach(async () => { await app.close(); await f.cleanup(); });
  test('保存不采集，显式预览不发送，重启后保持关闭', async () => {
    await save(); expect(native.captures).toBe(0); expect(app.screenSense.status().active).toBe(false);
    await expect(rpc('screenSense.capture')).rejects.toThrow('开启'); await rpc('screenSense.start');
    const preview = await rpc('screenSense.capture') as ScreenSenseSnapshot; expect(preview.preview?.target).toBe('测试画面'); expect(native.captures).toBe(1); expect(native.nativeCaptures).toBe(0); expect(inputs).toHaveLength(0);
    await app.close(); app = await open(); expect((await app.screenSense.snapshot()).configuration?.maxCaptures).toBe(2); expect(app.screenSense.status().active).toBe(false); expect((await app.screenSense.snapshot()).preview).toBeUndefined();
  });
  test('停止期间未完成的截图被丢弃，窗口被其他进程复用时停止采集', async () => {
    await save(); await rpc('screenSense.start'); let release!: () => void; native.hold = () => new Promise<void>(resolve => { release = resolve; });
    const capture = rpc('screenSense.capture'); const rejected = expect(capture).rejects.toThrow('停止');
    for (let count = 0; count < 100 && !release; count++) await new Promise(resolve => setTimeout(resolve, 5));
    expect(release).toBeDefined(); await rpc('screenSense.stop'); release(); await rejected;
    expect((await app.screenSense.snapshot()).preview).toBeUndefined(); expect(inputs).toHaveLength(0); native.hold = undefined;
    await rpc('screenSense.start'); native.window = { ...native.window, processId: 99 }; await expect(rpc('screenSense.capture')).rejects.toThrow('进程'); expect(app.screenSense.status().active).toBe(false); expect(native.captures).toBe(1);
  });
  test('仅显式发送进入原对话，重复发送不重复运行，用量按真实任务隔离', async () => {
    await save(); await rpc('screenSense.start'); const preview = await rpc('screenSense.capture') as ScreenSenseSnapshot;
    const result = await rpc('screenSense.send', { previewId: preview.preview!.id }) as { runId: string }; expect((await app.runtime.wait(result.runId))?.status).toBe('completed');
    await expect(rpc('screenSense.send', { previewId: preview.preview!.id })).rejects.toThrow('预览'); expect(inputs).toHaveLength(1); expect(inputs[0]!.messages.flatMap(message => message.parts).some(part => part.inlineData)).toBe(true);
    const other = await app.pets.call(client, 'pets.chat.send', { conversationId, configId: providerId, message: '无关的另一条消息', streamId: 'separate-text' }) as { runId: string }; await app.runtime.wait(other.runId);
    const history = (await app.screenSense.snapshot()).history; expect(history).toHaveLength(1); expect(history[0]).toMatchObject({ runId: result.runId, usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 30, requests: 1, unknownRequests: 0 } }); expect(history[0]!.usage.estimatedCost).toBeCloseTo(0.00025);
    await expect(app.screenSense.call({ actorId: 'stranger', clientId: 'x' }, 'screenSense.get', {})).rejects.toThrow();
  });
});
