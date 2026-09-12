import type { PlatformMessage } from '@graycode/contracts';
import type { PlatformApplication } from '../application';
import type { BotReply } from './gateway';
import type { BotPlatform, BotRoute } from './sessions';
import { BotSessions } from './sessions';
import { BotOutbox } from './outbox';
import { clipBotText, splitBotText } from './text';
import { milliseconds, thinkingComplete } from './messageStats';
import { botRoundText } from './rounds';

interface StreamState {
  route: BotRoute; body: string; thoughts: string; bodyLength: number; thoughtLength: number; status: string;
  dirty: boolean; done: boolean; timer?: ReturnType<typeof setTimeout>; rendering?: Promise<void>;
  thinkingStartedAt?: number; thinkingDuration?: number;
  rounds: string[]; roundCount: number; savedMessageId?: string;
}
export function botFinalReplies(text: string, route: BotRoute, footer?: string): BotReply[] {
  // 逐轮统计和总计连续显示，正文或代码与统计之间仍保留原来的段落间距。
  const suffix = footer ? `${text.trimEnd().split('\n').at(-1)?.startsWith('-# ') ? '\n' : '\n\n'}${footer}` : '';
  if (route.output?.longReplies === 'file' && text.length > 1900) return [{ content: `回复较长，全文保存在附件中。${suffix}`, files: [{ name: 'GrayCode 回复.md', data: Buffer.from(text + suffix) }] }];
  // 在分段和代码围栏闭合之后追加统计，保证 -# 位于最后一条消息的普通文本行。
  const replies = splitBotText(text, 1900 - suffix.length).map(content => ({ content }));
  replies[replies.length - 1].content += suffix;
  return replies;
}

/** 流式消费只更新缓冲；每次发送完成后再提交最新一帧，不堆积逐 token 的请求。 */
export class BotStreams {
  private readonly streams = new Map<string, Promise<StreamState | undefined>>();
  private readonly finished = new Set<string>();
  private paused = false;
  private rememberFinished(runId: string) {
    if (this.finished.size >= 1000) this.finished.delete(this.finished.values().next().value!);
    this.finished.add(runId);
  }
  constructor(private readonly app: PlatformApplication, private readonly platform: BotPlatform, private readonly sessions: BotSessions,
    private readonly outbox: BotOutbox) {}
  private stream(runId: string): Promise<StreamState | undefined> {
    if (this.finished.has(runId) || this.platform !== 'discord') return Promise.resolve(undefined);
    let value = this.streams.get(runId);
    if (!value) {
      value = (async () => {
        const run = await this.app.storage.getRun(runId);
        const route = run && await this.sessions.routeForRun(this.platform, run);
        if (!route?.output?.streaming || route.conversationId !== run!.conversationId || !await this.sessions.admitted(route)) {
          this.rememberFinished(runId); this.streams.delete(runId); return undefined;
        }
        return { route, body: '', thoughts: '', bodyLength: 0, thoughtLength: 0, status: '正在处理…', dirty: false, done: false, rounds: [], roundCount: 0 };
      })();
      this.streams.set(runId, value);
    }
    return value;
  }
  started(runId: string): void {
    void this.stream(runId).then(state => {
      if (!state || state.done) return;
      state.body = ''; state.thoughts = ''; state.bodyLength = 0; state.thoughtLength = 0; state.status = '正在回复…';
      state.thinkingStartedAt = undefined; state.thinkingDuration = undefined;
      state.dirty = true; this.schedule(runId, state);
    }).catch(() => {});
  }
  delta(runId: string, parts: Record<string, unknown>[]): void {
    const receivedAt = Date.now();
    void this.stream(runId).then(state => {
      if (!state || state.done) return;
      for (const part of parts) {
        if (part.functionCall || !part.thought && typeof part.text === 'string' && part.text.length > 0) this.finishThinking(state, receivedAt);
        if (typeof part.text !== 'string' || !part.text) continue;
        const name = part.thought ? 'thoughts' : 'body';
        if (name === 'thoughts' && !state.route.output?.showThoughts) continue;
        if (name === 'thoughts') state.thinkingStartedAt ??= receivedAt;
        if (name === 'body') state.bodyLength += part.text.length; else state.thoughtLength += part.text.length;
        state[name] = (state[name] + part.text).slice(-5000);
      }
      state.dirty = true; this.schedule(runId, state);
    }).catch(() => {});
  }
  private finishThinking(state: StreamState, timestamp = Date.now()) {
    if (state.thinkingStartedAt !== undefined && state.thinkingDuration === undefined)
      state.thinkingDuration = Math.max(0, timestamp - state.thinkingStartedAt);
  }
  saved(runId: string, message: PlatformMessage): void {
    if (message.role !== 'model') return;
    void this.streams.get(runId)?.then(state => {
      if (!state || state.done || message.id && state.savedMessageId === message.id) return;
      this.finishThinking(state);
      state.thinkingDuration = milliseconds(message.thinkingDuration) ?? state.thinkingDuration;
      state.savedMessageId = message.id;
      // 一轮结束后保留工具调用前的正文；展示用耗时只写入临时副本。
      const completed: PlatformMessage = { ...message, thinkingDuration: state.thinkingDuration };
      state.rounds.push(botRoundText(completed, state.route, ++state.roundCount));
      state.body = ''; state.thoughts = ''; state.bodyLength = 0; state.thoughtLength = 0;
      state.status = message.parts.some(part => part.functionCall) && state.route.output?.showToolStatus ? '正在处理工具调用…' : '正在整理回复…';
      state.dirty = true; this.schedule(runId, state);
    }).catch(() => {});
  }
  status(runId: string, status: string): void {
    void this.stream(runId).then(state => {
      if (!state || state.done || !state.route.output?.showToolStatus) return;
      state.status = status; state.dirty = true; this.schedule(runId, state);
    }).catch(() => {});
  }
  private preview(state: StreamState) {
    const thought = state.route.output?.showThoughts && state.thoughts
      ? state.thinkingDuration !== undefined || state.bodyLength > 0
        ? `**${thinkingComplete(state.thinkingDuration)}**\n\n`
        : `**思考内容**\n${clipBotText(state.thoughts, 650)}\n\n` : '';
    const body = state.bodyLength > 1500 ? `正文正在输出，已收到约 ${state.bodyLength} 字。\n\n${state.body.slice(-500)}` : state.body;
    const current = `${thought}${body || state.status}${state.body && state.route.output?.showToolStatus ? `\n\n_${state.status}_` : ''}`;
    // Discord 按消息长度拆分，已经完成的正文不因下一轮开始而消失。
    return splitBotText([...state.rounds, current].join('\n\n')).map(content => ({ content }));
  }
  private schedule(runId: string, state: StreamState) {
    if (state.timer || state.rendering || state.done || this.paused) return;
    state.timer = setTimeout(() => {
      state.timer = undefined;
      if (!state.dirty || state.done || this.paused) return;
      state.dirty = false;
      state.rendering = this.outbox.put(`stream-${runId}`, state.route, this.preview(state), false)
        .finally(() => { state.rendering = undefined; if (state.dirty) this.schedule(runId, state); });
      void state.rendering.catch(() => {});
    }, state.route.output!.updateIntervalMs);
    state.timer.unref();
  }
  async finish(runId: string, route: BotRoute, text: string, footer?: string): Promise<boolean> {
    const state = await this.streams.get(runId);
    this.rememberFinished(runId);
    if (!state) { this.streams.delete(runId); return false; }
    state.done = true; if (state.timer) clearTimeout(state.timer);
    await state.rendering?.catch(() => {});
    await this.outbox.put(`stream-${runId}`, route, botFinalReplies(text, route, footer));
    this.streams.delete(runId);
    return true;
  }
  async pause() {
    this.paused = true;
    for (const pending of this.streams.values()) { const state = await pending; if (state?.timer) { clearTimeout(state.timer); state.timer = undefined; } }
  }
  async discard(runId: string) {
    const state = await this.streams.get(runId);
    this.rememberFinished(runId);
    if (state) {
      state.done = true; if (state.timer) clearTimeout(state.timer);
      await state.rendering?.catch(() => {});
    }
    await this.outbox.suppress(`stream-${runId}`, '任务结束时，此入口的发送权限已关闭。');
    this.streams.delete(runId);
  }
  async resume() {
    this.paused = false;
    for (const [runId, pending] of this.streams) { const state = await pending; if (state?.dirty) this.schedule(runId, state); }
  }
  async close() { await this.pause(); for (const pending of this.streams.values()) await (await pending)?.rendering?.catch(() => {}); }
}

export function botMessageText(message: PlatformMessage | undefined, route: BotRoute, platform = route.platform): string {
  if (!message) return '任务已完成。';
  const parts = Array.isArray(message.characterDisplayParts) ? message.characterDisplayParts as PlatformMessage['parts'] : message.parts;
  const body = parts.filter(part => !part.thought && typeof part.text === 'string').map(part => part.text).join('');
  const thoughts = route.output?.showThoughts ? parts.filter(part => part.thought && typeof part.text === 'string').map(part => part.text).join('') : '';
  if (platform === 'discord') {
    const considered = route.output?.showThoughts && (thoughts || milliseconds(message.thinkingDuration) !== undefined);
    return (considered ? `**${thinkingComplete(message.thinkingDuration)}**\n\n` : '') + (body || '任务已完成。');
  }
  return (thoughts ? `**思考内容**\n${thoughts}\n\n` : '') + (body || '任务已完成。');
}
