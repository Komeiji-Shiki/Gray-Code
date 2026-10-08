import type { TerminalOutputEvent } from '../../../../backend/tools/terminal/processRunnerRuntime';

/** 合并连续输出片段；结构事件即时发送，保留终端身份与 stdout/stderr 的原顺序。 */
export class TerminalOutputBuffer {
  private pending?: TerminalOutputEvent;
  private chunks: string[] = [];
  private bytes = 0;
  private started = false;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(private readonly send: (event: TerminalOutputEvent) => void) {}

  push(event: TerminalOutputEvent): void {
    if ((event.type !== 'output' && event.type !== 'error') || !event.data) {
      this.flush(); this.send(event); return;
    }
    if (this.pending && (this.pending.terminalId !== event.terminalId || this.pending.type !== event.type)) this.flush();
    if (!this.started) {
      this.started = true;
      this.send(event); return;
    }
    this.pending ??= { ...event };
    this.chunks.push(event.data);
    this.bytes += Buffer.byteLength(event.data);
    // 与模型流式推送采用相同的帧间隔和刷新阈值，避免大量短行挤占界面消息队列。
    if (this.bytes >= 16_384) this.flush();
    else if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), 16);
      this.timer.unref();
    }
  }

  flush(): void {
    clearTimeout(this.timer); this.timer = undefined;
    if (!this.pending) return;
    const event = { ...this.pending, data: this.chunks.join('') };
    this.pending = undefined; this.chunks = []; this.bytes = 0;
    this.send(event);
  }
}
