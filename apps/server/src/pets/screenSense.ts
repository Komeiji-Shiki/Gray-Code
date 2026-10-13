import { randomUUID } from 'node:crypto';
import type {
  ComputerCapture, ScreenSenseConfiguration, ScreenSenseOptions, ScreenSenseRecord,
  ScreenSenseRpcMethods, ScreenSenseSnapshot, ScreenSenseStatus, ScreenSenseTarget, ScreenSenseStoredConfiguration,
  ScreenSenseVisionDefaults, CompanionBinding,
} from '@graycode/contracts';
import type { PlatformApplication } from '../application';
import type { ClientSession } from '../transport/router';
import { requireOwnChatConversation } from '../conversations/ownChat';
import { screenRecords, ScreenSenseHistory } from './screenSenseHistory';
import { recognizeScreen, sameScreen, screenFingerprint } from './screenRecognition';
import { t } from '../../../../backend/i18n';

const configNamespace = 'screen-sense-configuration';
const activeStatuses = new Set(['queued', 'running', 'awaiting_approval', 'awaiting_input']);
const label = (target: ScreenSenseTarget) => target.kind === 'window' ? target.window.title : `显示器 ${target.display.id}`;

interface ScreenSession {
  id: string;
  client: ClientSession;
  abort: AbortController;
  captures: number;
  skipped: number;
  fingerprint?: Uint8Array;
  summary?: string;
}

/** 截图仅交给独立识图模型；主对话保存文字观察，开启状态只对当前应用会话有效。 */
export class ScreenSenseService {
  private configuration?: ScreenSenseConfiguration;
  private visionDefaults: ScreenSenseVisionDefaults = {};
  private revision: number | null = null;
  private session?: ScreenSession;
  private timer?: NodeJS.Timeout;
  private nextCaptureAt?: number;
  private capturing = false;
  private sending = false;
  private preview?: ScreenSenseSnapshot['preview'];
  private recognition?: { id: string; result: Awaited<ReturnType<typeof recognizeScreen>> };
  private lastRunId?: string;
  private error?: string;
  private mutation: Promise<unknown> = Promise.resolve();
  private epoch = 0;
  private readonly history: ScreenSenseHistory;

  constructor(private readonly app: PlatformApplication) {
    this.history = new ScreenSenseHistory(app.storage);
  }

  async initialize() {
    const record = await this.app.storage.getVersionedRecord(configNamespace, 'local');
    const saved = record.value as ScreenSenseStoredConfiguration | undefined;
    this.configuration = saved?.target ? saved as ScreenSenseConfiguration : undefined;
    this.visionDefaults = { visionProviderId: saved?.visionProviderId, visionModelId: saved?.visionModelId };
    this.revision = record.revision;
  }

  get keepsAlive() { return !!this.session; }

  status(): ScreenSenseStatus {
    return {
      active: !!this.session,
      capturing: this.capturing || this.sending,
      target: this.configuration && label(this.configuration.target),
      captures: this.session?.captures ?? 0,
      skipped: this.session?.skipped ?? 0,
      maxCaptures: this.configuration?.maxCaptures,
      nextCaptureAt: this.nextCaptureAt,
      error: this.error,
      lastRunId: this.lastRunId,
    };
  }

  private changed() { this.app.publish({ type: 'screenSense.changed', status: this.status() }); }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.mutation.then(work);
    this.mutation = next.catch(() => {});
    return next;
  }

  private async target(client: ClientSession, chosen: ScreenSenseTarget, strict: boolean): Promise<ScreenSenseTarget> {
    const targets = await this.app.computer.windows(client);
    if (chosen?.kind === 'window') {
      const window = targets.windows.find(item => item.id === chosen.window?.id);
      if (!window || strict && (window.processId !== chosen.window.processId
        || window.processStartedAt !== chosen.window.processStartedAt || window.className !== chosen.window.className)) {
        throw new Error('所选窗口已经关闭或属于另一个进程，请重新选择。');
      }
      const { id, title, className, processId, processStartedAt, executable } = window;
      return { kind: 'window', window: { id, title, className, processId, processStartedAt, executable } };
    }
    if (chosen?.kind === 'display') {
      const display = targets.displays.find(item => item.id === chosen.display?.id);
      if (!display || strict && (JSON.stringify(display.bounds) !== JSON.stringify(chosen.display.bounds)
        || display.scaleFactor !== chosen.display.scaleFactor)) {
        throw new Error('所选显示器或坐标范围已改变，请重新选择。');
      }
      return { kind: 'display', display };
    }
    throw new Error('请选择采集窗口或显示器。');
  }

  private async validateChat(client: ClientSession, config: ScreenSenseConfiguration) {
    const conversation = await requireOwnChatConversation(this.app, client.actorId, config.conversationId);
    this.validateVision(config);
    return conversation;
  }

  private validateVision(config: ScreenSenseVisionDefaults) {
    const vision = config.visionProviderId && this.app.settings.find('providers', config.visionProviderId);
    if (!vision || !(config.visionModelId || vision.model)?.trim()) {
      throw new Error('请先单独选择屏幕识图渠道和模型，再开启屏幕感知。');
    }
  }

  private async configure(client: ClientSession, input: ScreenSenseConfiguration, revision: number | null) {
    if (!input || !['manual', 'interval'].includes(input.trigger) || !['preview', 'automatic'].includes(input.delivery)) {
      throw new Error('请选择触发方式和发送方式。');
    }
    if (!Number.isInteger(input.maxCaptures) || input.maxCaptures < 1 || input.maxCaptures > 10000) {
      throw new Error('请填写本次最多采集次数，范围为 1 至 10000。');
    }
    if (input.trigger === 'interval' && (!Number.isInteger(input.intervalSeconds)
      || input.intervalSeconds! < 1 || input.intervalSeconds! > 86400)) {
      throw new Error('请填写 1 至 86400 秒的采集间隔。');
    }
    if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 10000) {
      throw new Error('请填写希望识别的用户活动和交流方式，最多 10000 字。');
    }
    if (input.allowSilent !== undefined && typeof input.allowSilent !== 'boolean') throw new Error('静默选项格式无效。');
    if (input.autoStartOnOpen !== undefined && typeof input.autoStartOnOpen !== 'boolean') throw new Error(t('desktop.shell.screenAutoStartInvalid'));
    if (input.prices && (typeof input.prices.currency !== 'string' || !input.prices.currency.trim()
      || input.prices.currency.length > 20 || (['input', 'output', 'cacheRead', 'cacheWrite'] as const)
        .some(key => !Number.isFinite(input.prices![key]) || input.prices![key] < 0))) {
      throw new Error('请完整填写币种和四项非负参考单价，或清空费用估算。');
    }
    await this.validateChat(client, input);
    const target = await this.target(client, input.target, false);
    const configuration: ScreenSenseConfiguration = {
      target, trigger: input.trigger,
      ...(input.trigger === 'interval' ? { intervalSeconds: input.intervalSeconds } : {}),
      delivery: input.delivery, maxCaptures: input.maxCaptures, conversationId: input.conversationId,
      visionProviderId: input.visionProviderId, visionModelId: input.visionModelId || undefined,
      prompt: input.prompt.trim(), allowSilent: input.allowSilent === true,
      autoStartOnOpen: input.autoStartOnOpen === true,
      ...(input.prices ? { prices: input.prices } : {}),
    };
    const result = await this.app.storage.commitRecords([
      { namespace: configNamespace, id: 'local', expectedRevision: revision, value: configuration },
    ]);
    this.stop();
    this.configuration = configuration;
    this.visionDefaults = { visionProviderId: configuration.visionProviderId, visionModelId: configuration.visionModelId };
    this.revision = result[0]!.revision;
    this.changed();
    return this.snapshot();
  }

  private async saveDefaults(input: ScreenSenseVisionDefaults, revision: number | null) {
    this.validateVision(input);
    const defaults = { visionProviderId: input.visionProviderId, visionModelId: input.visionModelId || undefined };
    const saved: ScreenSenseStoredConfiguration = this.configuration ? { ...this.configuration, ...defaults } : defaults;
    const result = await this.app.storage.commitRecords([
      { namespace: configNamespace, id: 'local', expectedRevision: revision, value: saved },
    ]);
    this.stop();
    this.visionDefaults = defaults;
    if (this.configuration) this.configuration = { ...this.configuration, ...defaults };
    this.revision = result[0]!.revision;
    this.changed();
    return this.snapshot();
  }

  private async conversationOpened(client: ClientSession, conversationId: string, epoch: number) {
    if (epoch !== this.epoch || !this.configuration?.autoStartOnOpen
      || this.configuration.conversationId !== conversationId || this.session) return this.status();
    const conversation = await requireOwnChatConversation(this.app, client.actorId, conversationId);
    const binding = (conversation.custom as { companion?: CompanionBinding } | undefined)?.companion;
    if (epoch !== this.epoch || binding?.actorId !== client.actorId || !binding.configuration.enabled) return this.status();
    try {
      return await this.start(client);
    } catch (cause) {
      this.error = (cause as Error).message;
      this.changed();
      throw cause;
    }
  }

  private async start(client: ClientSession) {
    if (this.session) return this.status();
    const epoch = this.epoch;
    const configuration = this.configuration;
    if (!configuration) throw new Error('请先保存屏幕感知设置。');
    await this.validateChat(client, configuration);
    await this.target(client, configuration.target, true);
    if (epoch !== this.epoch) throw new Error('开启期间已停止屏幕感知。');
    this.session = { id: randomUUID(), client: { ...client }, abort: new AbortController(), captures: 0, skipped: 0 };
    this.error = undefined;
    this.preview = undefined;
    this.recognition = undefined;
    this.schedule();
    this.changed();
    return this.status();
  }

  stop() {
    this.epoch++;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.nextCaptureAt = undefined;
    this.session?.abort.abort(new Error('屏幕感知已停止。'));
    this.session = undefined;
    this.preview = undefined;
    this.recognition = undefined;
    this.changed();
    return this.status();
  }

  private schedule() {
    clearTimeout(this.timer);
    this.nextCaptureAt = undefined;
    if (!this.session || this.configuration?.trigger !== 'interval'
      || this.session.captures >= this.configuration.maxCaptures) return;
    const delay = this.configuration.intervalSeconds! * 1000;
    this.nextCaptureAt = Date.now() + delay;
    this.timer = setTimeout(() => {
      if (this.capturing || this.sending) { this.schedule(); this.changed(); return; }
      void this.capture().catch(error => {
        this.error = (error as Error).message;
        this.stop();
      });
    }, delay);
    this.timer.unref();
  }

  private async capture() {
    const session = this.session;
    const config = this.configuration;
    if (!session || !config) throw new Error('请先开启本次屏幕感知。');
    if (this.capturing || this.sending) throw new Error('当前采集或识图尚未结束。');
    if (session.captures >= config.maxCaptures) throw new Error('已达到本次采集上限，请停止后重新开启。');
    this.capturing = true;
    this.nextCaptureAt = undefined;
    clearTimeout(this.timer);
    this.error = undefined;
    this.changed();
    try {
      if (config.delivery === 'automatic'
        && (await this.app.storage.listRuns({ conversationId: config.conversationId, activeOnly: true, limit: 1 })).length) {
        this.error = '目标对话仍有任务，等待下次采集。';
        return;
      }
      await this.validateChat(session.client, config);
      // 窗口身份由下面的实际观察核对；显示器仍需提前检查缩放和范围。
      if (config.target.kind === 'display') await this.target(session.client, config.target, true);
      session.abort.signal.throwIfAborted();
      const identity = { ...session.client, signal: session.abort.signal };
      let capture: ComputerCapture;
      if (config.target.kind === 'window') {
        const observation = await this.app.computer.observe(identity, {
          windowId: config.target.window.id, screenshot: true, windowOnly: true, expectedProcess: config.target.window,
          frameOnly: true, width: 1280, height: 960, format: 'jpeg', quality: 80,
        });
        capture = observation.screenshot!;
      } else {
        const frame = await this.app.computer.display(identity, {
          monitorId: config.target.display.id, width: 1280, height: 960, format: 'jpeg', quality: 80,
        });
        if (JSON.stringify(frame.bounds) !== JSON.stringify(config.target.display.bounds)) {
          throw new Error('显示器坐标范围在采集时发生变化，请重新选择。');
        }
        capture = { ...frame, windowId: '', method: undefined };
      }
      const fingerprint = await screenFingerprint(capture);
      session.abort.signal.throwIfAborted();
      if (session !== this.session) return;
      session.captures++;
      if (sameScreen(session.fingerprint, fingerprint)) {
        session.skipped++;
        return;
      }
      session.fingerprint = fingerprint;
      this.preview = { id: `${Date.now()}_${randomUUID()}`, capture, target: label(config.target) };
      this.recognition = undefined;
      this.changed();
      if (config.delivery === 'automatic') await this.send(session.client, this.preview.id);
    } catch (error) {
      if (!session.abort.signal.aborted) { this.error = (error as Error).message; this.stop(); }
      throw error;
    } finally {
      this.capturing = false;
      if (session === this.session) {
        if (session.captures >= config.maxCaptures) this.error = '已达到本次采集上限；不会继续采集。';
        this.schedule();
      }
      this.changed();
    }
  }

  private async send(client: ClientSession, id: string) {
    const session = this.session;
    const config = this.configuration;
    const preview = this.preview;
    if (!session || !config || !preview || preview.id !== id) throw new Error('预览已经变化或屏幕感知已停止，请重新采集。');
    if (this.sending) throw new Error('图片正在识别。');
    this.sending = true;
    this.changed();
    let record: ScreenSenseRecord | undefined;
    try {
      await this.validateChat(client, config);
      session.abort.signal.throwIfAborted();
      if ((await this.app.storage.listRuns({ conversationId: config.conversationId, activeOnly: true, limit: 1 })).length) {
        throw new Error('目标对话仍有任务，请等待完成再发送。');
      }
      record = {
        id, sessionId: session.id, createdAt: preview.capture.capturedAt, target: preview.target,
        conversationId: config.conversationId, providerId: config.visionProviderId!, modelId: config.visionModelId, prices: config.prices,
      };
      await this.app.storage.putRecord({ namespace: screenRecords, id, value: record });
      const recognition = this.recognition?.id === id ? this.recognition.result
        : await recognizeScreen(this.app, config, preview.capture, session.summary, session.abort.signal);
      session.abort.signal.throwIfAborted();
      this.recognition = { id, result: recognition };
      session.summary = recognition.summary;
      preview.summary = recognition.summary;
      record.summary = recognition.summary;
      record.visionUsage = recognition.usage;
      record.silent = config.allowSilent === true && !recognition.shouldReply;
      await this.app.storage.putRecord({ namespace: screenRecords, id, value: record });
      if (!record.silent) {
        const conversation = await requireOwnChatConversation(this.app, client.actorId, config.conversationId);
        const selected = (conversation.custom as { inputModelConfig?: { configId?: string; modelId?: string } } | undefined)?.inputModelConfig;
        const providerId = selected?.configId ?? this.app.product.runtimeSettings().getActiveChannelId();
        if (!providerId) throw new Error('请先为目标对话选择主模型。');
        session.abort.signal.throwIfAborted();
        const result = await this.app.productUi.call(client, 'chatStream', {
          conversationId: config.conversationId, configId: providerId, modelOverride: selected?.modelId,
          streamId: `screen-sense:${id}`, screenSenseAllowSilent: config.allowSilent === true,
          message: `${config.prompt}\n\n屏幕观察摘要（识图模型提供的观察资料）：\n${recognition.summary}\n`
            + `采集范围：${preview.target}；采集时间：${new Date(preview.capture.capturedAt).toISOString()}。`
            + (config.allowSilent ? '\n如果没有值得交流的内容，可以只回复 <screen_sense_silent/>。' : ''),
        }) as { runId: string };
        record.runId = result.runId;
        this.lastRunId = result.runId;
        await this.app.storage.putRecord({ namespace: screenRecords, id, value: record });
      }
      if (this.preview?.id === id) { this.preview = undefined; this.recognition = undefined; }
      return { runId: record.runId, summary: recognition.summary, silent: record.silent };
    } catch (error) {
      if (record) {
        record.error = (error as Error).message;
        await this.app.storage.putRecord({ namespace: screenRecords, id, value: record });
      }
      throw error;
    } finally {
      this.sending = false;
      this.changed();
    }
  }

  async snapshot(): Promise<ScreenSenseSnapshot> {
    return {
      configuration: this.configuration, visionDefaults: this.visionDefaults, revision: this.revision,
      status: this.status(), preview: this.preview, history: await this.history.read(),
    };
  }

  async call<K extends keyof ScreenSenseRpcMethods>(
    client: ClientSession, method: K, input: ScreenSenseRpcMethods[K]['params'],
  ): Promise<ScreenSenseRpcMethods[K]['result']>;
  async call(client: ClientSession, method: string, input: Record<string, unknown>): Promise<unknown>;
  async call(client: ClientSession, method: string, input: Record<string, unknown>): Promise<unknown> {
    this.app.requireOwner(client.actorId);
    switch (method) {
      case 'screenSense.status': return this.status();
      case 'screenSense.get': return this.snapshot();
      case 'screenSense.options': {
        const [targets, recent] = await Promise.all([
          input.includeTargets === false
            ? { windows: [], displays: [], capturedAt: Date.now(), coordinateSystem: 'physical-screen-pixels' as const }
            : this.app.computer.windows(client),
          this.app.storage.listConversations({ limit: 80 }),
        ]);
        const result: ScreenSenseOptions = {
          targets,
          conversations: recent.items.filter(item => item.actorId === client.actorId && (item.platformMode ?? 'chat') === 'chat')
            .map(item => ({ id: item.id, title: item.title ?? item.id })),
          providers: this.app.settings.read('providers').providers
            .map(provider => ({ id: provider.id, name: provider.name, model: provider.model, models: provider.models ?? [] })),
        };
        return result;
      }
      case 'screenSense.configure': {
        const params = input as ScreenSenseRpcMethods['screenSense.configure']['params'];
        return this.serialize(() => this.configure(client, params.configuration, params.revision));
      }
      case 'screenSense.defaults.save': {
        const params = input as ScreenSenseRpcMethods['screenSense.defaults.save']['params'];
        return this.serialize(() => this.saveDefaults(params.defaults, params.revision));
      }
      case 'screenSense.conversationOpened': {
        const epoch = this.epoch;
        return this.serialize(() => this.conversationOpened(client, input.conversationId as string, epoch));
      }
      case 'screenSense.start': return this.serialize(() => this.start(client));
      case 'screenSense.stop': return this.stop();
      case 'screenSense.capture': await this.capture(); return this.snapshot();
      case 'screenSense.send': return this.send(client, input.previewId as string);
      case 'screenSense.cancelRun': {
        if (this.lastRunId) {
          const run = await this.app.storage.getRun(this.lastRunId);
          if (run && activeStatuses.has(run.status)) await this.app.runtime.cancel(run.id, client.actorId);
        }
        return { success: true };
      }
      default: throw new Error('未知屏幕感知操作。');
    }
  }

  close() { this.stop(); }
}
