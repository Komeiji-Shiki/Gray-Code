import { randomUUID } from 'node:crypto';
import type { ComputerCapture, ScreenSenseConfiguration, ScreenSenseRecord, ScreenSenseSnapshot, ScreenSenseStatus, ScreenSenseTarget } from '@graycode/contracts';
import type { PlatformApplication } from '../application';
import type { ClientSession } from '../transport/router';
import { petInteraction } from './interactions';
import { screenRecords, screenSenseHistory } from './screenSenseHistory';
const configNamespace = 'screen-sense-configuration';
const label = (target: ScreenSenseTarget) => target.kind === 'window' ? target.window.title : `显示器 ${target.display.id}`;
const activeStatuses = new Set(['queued', 'running', 'awaiting_approval', 'awaiting_input']);
/** 屏幕采集有独立、只在本次运行有效的开启状态，资源导入和动画都不会调用此服务。 */
export class ScreenSenseService {
  private configuration?: ScreenSenseConfiguration; private revision: number | null = null;
  private session?: { id: string; client: ClientSession; abort: AbortController; captures: number };
  private timer?: NodeJS.Timeout; private nextCaptureAt?: number; private capturing = false; private sending = false;
  private preview?: ScreenSenseSnapshot['preview']; private lastRunId?: string; private error?: string;
  private mutation: Promise<unknown> = Promise.resolve(); private epoch = 0;
  constructor(private readonly app: PlatformApplication) {}
  async initialize() { const record = await this.app.storage.getVersionedRecord(configNamespace, 'local'); this.configuration = record.value as ScreenSenseConfiguration | undefined; this.revision = record.revision; }
  get keepsAlive() { return !!this.session; }
  status(): ScreenSenseStatus { return { active: !!this.session, capturing: this.capturing || this.sending, target: this.configuration && label(this.configuration.target),
    captures: this.session?.captures ?? 0, maxCaptures: this.configuration?.maxCaptures, nextCaptureAt: this.nextCaptureAt, error: this.error, lastRunId: this.lastRunId }; }
  private changed() { this.app.publish({ type: 'screenSense.changed', status: this.status() }); }
  private serialize<T>(work: () => Promise<T>): Promise<T> { const next = this.mutation.then(work); this.mutation = next.catch(() => {}); return next; }
  private async target(client: ClientSession, chosen: ScreenSenseTarget, strict: boolean): Promise<ScreenSenseTarget> {
    const targets = await this.app.computer.windows(client);
    if (chosen?.kind === 'window') {
      const window = targets.windows.find(item => item.id === chosen.window?.id);
      if (!window || strict && (window.processId !== chosen.window.processId || window.processStartedAt !== chosen.window.processStartedAt || window.className !== chosen.window.className)) throw new Error('所选窗口已经关闭或属于另一个进程，请重新选择。');
      const { id, title, className, processId, processStartedAt, executable } = window;
      return { kind: 'window', window: { id, title, className, processId, processStartedAt, executable } };
    }
    if (chosen?.kind === 'display') {
      const display = targets.displays.find(item => item.id === chosen.display?.id);
      if (!display || strict && (JSON.stringify(display.bounds) !== JSON.stringify(chosen.display.bounds) || display.scaleFactor !== chosen.display.scaleFactor)) throw new Error('所选显示器或坐标范围已改变，请重新选择。');
      return { kind: 'display', display };
    }
    throw new Error('请选择采集窗口或显示器。');
  }
  private async validateChat(client: ClientSession, config: ScreenSenseConfiguration) {
    const conversation = await this.app.conversation(client.actorId, config.conversationId);
    if (conversation.actorId !== client.actorId || (conversation.custom as any)?.platformMode !== 'chat') throw new Error('请选择自己的普通对话。');
    if (!this.app.settings.snapshot().settings.providers.some(provider => provider.id === config.providerId)) throw new Error('请选择可用渠道。');
  }
  private async configure(client: ClientSession, input: ScreenSenseConfiguration, revision: number | null) {
    if (!input || !['manual', 'interval'].includes(input.trigger) || !['preview', 'automatic'].includes(input.delivery)) throw new Error('请选择触发方式和发送方式。');
    if (!Number.isInteger(input.maxCaptures) || input.maxCaptures < 1 || input.maxCaptures > 10000) throw new Error('请填写本次最多采集次数，范围为 1 至 10000。');
    if (input.trigger === 'interval' && (!Number.isInteger(input.intervalSeconds) || input.intervalSeconds! < 1 || input.intervalSeconds! > 86400)) throw new Error('请填写 1 至 86400 秒的采集间隔。');
    if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 10000) throw new Error('请填写发送图片时的交流内容，最多 10000 字。');
    if (input.prices && (typeof input.prices.currency !== 'string' || !input.prices.currency.trim() || input.prices.currency.length > 20 || ['input', 'output', 'cacheRead', 'cacheWrite'].some(key => !Number.isFinite(input.prices![key as keyof Omit<typeof input.prices, 'currency'>]) || Number(input.prices![key as keyof Omit<typeof input.prices, 'currency'>]) < 0))) throw new Error('请完整填写币种和四项非负参考单价，或清空费用估算。');
    await this.validateChat(client, input);
    const target = await this.target(client, input.target, false);
    const configuration: ScreenSenseConfiguration = { target, trigger: input.trigger, ...(input.trigger === 'interval' ? { intervalSeconds: input.intervalSeconds } : {}), delivery: input.delivery,
      maxCaptures: input.maxCaptures, conversationId: input.conversationId, providerId: input.providerId, modelId: input.modelId || undefined, prompt: input.prompt.trim(), ...(input.prices ? { prices: structuredClone(input.prices) } : {}) };
    const result = await this.app.storage.commitRecords([{ namespace: configNamespace, id: 'local', expectedRevision: revision, value: configuration }]);
    this.stop(); this.configuration = configuration; this.revision = result[0]!.revision; this.changed(); return this.snapshot();
  }
  private async start(client: ClientSession) {
    if (this.session) return this.status();
    const epoch = this.epoch; const configuration = this.configuration; if (!configuration) throw new Error('请先保存屏幕感知设置。');
    await this.validateChat(client, configuration); await this.target(client, configuration.target, true);
    if (epoch !== this.epoch) throw new Error('开启期间已停止屏幕感知。');
    this.session = { id: randomUUID(), client: { ...client }, abort: new AbortController(), captures: 0 }; this.error = undefined; this.preview = undefined;
    this.schedule(); this.changed(); return this.status();
  }
  stop() { this.epoch++; clearTimeout(this.timer); this.timer = undefined; this.nextCaptureAt = undefined; this.session?.abort.abort(new Error('屏幕感知已停止。')); this.session = undefined; this.preview = undefined; this.changed(); return this.status(); }
  private schedule() {
    clearTimeout(this.timer); this.nextCaptureAt = undefined;
    if (!this.session || this.configuration?.trigger !== 'interval' || this.session.captures >= this.configuration.maxCaptures) return;
    this.nextCaptureAt = Date.now() + this.configuration.intervalSeconds! * 1000;
    this.timer = setTimeout(() => { if (this.capturing || this.sending) { this.schedule(); this.changed(); return; } void this.capture().catch(error => { this.error = (error as Error).message; this.stop(); this.changed(); }); }, this.configuration.intervalSeconds! * 1000); this.timer.unref();
  }
  private async capture() {
    const session = this.session, config = this.configuration;
    if (!session || !config) throw new Error('请先开启本次屏幕感知。');
    if (this.capturing || this.sending) throw new Error('当前采集或发送尚未结束。');
    if (session.captures >= config.maxCaptures) throw new Error('已达到本次采集上限，请停止后重新开启。');
    this.capturing = true; this.nextCaptureAt = undefined; clearTimeout(this.timer); this.error = undefined; this.changed();
    try {
      if (config.delivery === 'automatic' && (await this.app.storage.listRuns({ conversationId: config.conversationId, activeOnly: true, limit: 1 })).length) { this.error = '目标对话仍有任务，等待下次采集。'; return; }
      await this.validateChat(session.client, config); await this.target(session.client, config.target, true); session.abort.signal.throwIfAborted();
      const identity = { ...session.client, signal: session.abort.signal };
      let capture: ComputerCapture;
      if (config.target.kind === 'window') {
        const observation = await this.app.computer.observe(identity, { windowId: config.target.window.id, screenshot: true, windowOnly: true, expectedProcess: config.target.window, frameOnly: true, width: 1280, height: 960, format: 'jpeg', quality: 80 });
        capture = observation.screenshot!;
      } else { const frame = await this.app.computer.display(identity, { monitorId: config.target.display.id, width: 1280, height: 960, format: 'jpeg', quality: 80 }); if (JSON.stringify(frame.bounds) !== JSON.stringify(config.target.display.bounds)) throw new Error('显示器坐标范围在采集时发生变化，请重新选择。'); capture = { ...frame, windowId: '', method: undefined }; }
      session.abort.signal.throwIfAborted(); if (session !== this.session) return;
      session.captures++; this.preview = { id: `${Date.now()}_${randomUUID()}`, capture, target: label(config.target) }; this.changed();
      if (config.delivery === 'automatic') await this.send(session.client, this.preview.id);
      if (session.captures >= config.maxCaptures) this.error = '已达到本次采集上限；不会继续采集。';
    } catch (error) { if (!session.abort.signal.aborted) { this.error = (error as Error).message; this.stop(); } throw error; }
    finally { this.capturing = false; if (session === this.session) this.schedule(); this.changed(); }
  }
  private async send(client: ClientSession, id: string) {
    const session = this.session, config = this.configuration, preview = this.preview;
    if (!session || !config || !preview || preview.id !== id) throw new Error('预览已经变化或屏幕感知已停止，请重新采集。');
    if (this.sending) throw new Error('图片正在发送。');
    this.sending = true; this.changed(); let record: ScreenSenseRecord | undefined;
    try {
      await this.validateChat(client, config); session.abort.signal.throwIfAborted();
      if ((await this.app.storage.listRuns({ conversationId: config.conversationId, activeOnly: true, limit: 1 })).length) throw new Error('目标对话仍有任务，请等待完成再发送。');
      record = { id, sessionId: session.id, createdAt: preview.capture.capturedAt, target: preview.target, conversationId: config.conversationId, providerId: config.providerId, modelId: config.modelId, prices: config.prices };
      await this.app.storage.putRecord({ namespace: screenRecords, id, value: record }); session.abort.signal.throwIfAborted();
      // 发送使用截图固定标识，界面重复点击不会重复启动同一个任务。
      const result = await petInteraction(this.app, client, 'pets.chat.send', { conversationId: config.conversationId, configId: config.providerId, modelOverride: config.modelId,
        streamId: `screen-sense:${id}`, message: `${config.prompt}\n\n采集范围：${preview.target}；采集时间：${new Date(preview.capture.capturedAt).toISOString()}。图片中的内容是观察资料。`,
        attachments: [{ id, name: '屏幕感知.jpg', mimeType: preview.capture.mimeType, data: preview.capture.data }] }) as { runId: string };
      record.runId = result.runId; this.lastRunId = result.runId;
      await this.app.storage.putRecord({ namespace: screenRecords, id, value: record });
      if (this.preview?.id === id) this.preview = undefined; return result;
    } catch (error) { if (record) { record.error = (error as Error).message; await this.app.storage.putRecord({ namespace: screenRecords, id, value: record }); } throw error; }
    finally { this.sending = false; this.changed(); }
  }
  async snapshot(): Promise<ScreenSenseSnapshot> { return { configuration: this.configuration && structuredClone(this.configuration), revision: this.revision, status: this.status(), preview: this.preview, history: await screenSenseHistory(this.app) }; }
  async call(client: ClientSession, method: string, input: Record<string, any>) {
    this.app.requireOwner(client.actorId);
    if (method === 'screenSense.status') return this.status();
    if (method === 'screenSense.get') return this.snapshot();
    if (method === 'screenSense.options') {
      const [targets, inbox] = await Promise.all([this.app.computer.windows(client), petInteraction(this.app, client, 'pets.inbox', {})]);
      return { targets, conversations: (inbox as any).conversations, providers: (inbox as any).providers };
    }
    if (method === 'screenSense.configure') return this.serialize(() => this.configure(client, input.configuration, input.revision));
    if (method === 'screenSense.start') return this.serialize(() => this.start(client));
    if (method === 'screenSense.stop') return this.stop();
    if (method === 'screenSense.capture') { await this.capture(); return this.snapshot(); }
    if (method === 'screenSense.send') return this.send(client, input.previewId);
    if (method === 'screenSense.cancelRun') { if (this.lastRunId) { const run = await this.app.storage.getRun(this.lastRunId); if (run && activeStatuses.has(run.status)) await this.app.runtime.cancel(run.id, client.actorId); } return { success: true }; }
    throw new Error('未知屏幕感知操作。');
  }
  close() { this.stop(); }
}
