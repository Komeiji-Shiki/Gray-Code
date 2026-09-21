type Part = Record<string, unknown>;

/** 合并连续纯文本推送；首块、工具参数和签名保持即时，结束时先交付剩余内容。 */
export class DeltaCoalescer {
  closed = false;
  private timer?: ReturnType<typeof setTimeout>;
  private parts: Part[] = [];
  private bytes = 0;
  private inputEvents = 0;
  private outputEvents = 0;
  constructor(private readonly emit: (parts: Part[]) => void) {}

  push(parts: Part[]): void {
    if (this.closed || !parts.length) return;
    this.inputEvents++;
    if (this.inputEvents === 1 || parts.some(part => typeof part.text !== 'string' || Object.keys(part).some(key => key !== 'text' && key !== 'thought'))) {
      this.flush(); this.send(parts); return;
    }
    for (const part of parts) {
      const previous = this.parts.at(-1);
      if (previous && previous.thought === part.thought) previous.text = String(previous.text) + part.text;
      else this.parts.push({ ...part });
      this.bytes += Buffer.byteLength(part.text as string);
    }
    if (this.bytes >= 16_384) this.flush();
    else if (!this.timer) { this.timer = setTimeout(() => this.flush(), 16); this.timer.unref(); }
  }
  private send(parts: Part[]): void { this.outputEvents++; this.emit(parts); }
  private flush(): void {
    clearTimeout(this.timer); this.timer = undefined;
    if (!this.parts.length) return;
    const parts = this.parts; this.parts = []; this.bytes = 0; this.send(parts);
  }
  finish(): void { this.closed = true; this.flush(); }
  statistics() { return { inputEvents: this.inputEvents, outputEvents: this.outputEvents }; }
}
