/** 只合并尚未发送的连续全文更新；保存等操作形成边界，边界两侧的编辑永不合并。 */
export class PendingDocumentChanges<T extends object> {
  private readonly pending = new WeakMap<T, { text: string }>();
  constructor(private readonly enqueue: (document: T, operation: () => Promise<void>) => void,
    private readonly apply: (document: T, text: string) => Promise<void>) {}

  push(document: T, text: string): void {
    const previous = this.pending.get(document);
    if (previous) { previous.text = text; return; }
    const entry = { text };
    this.pending.set(document, entry);
    this.enqueue(document, async () => {
      if (this.pending.get(document) === entry) this.pending.delete(document);
      await this.apply(document, entry.text);
    });
  }
  /** 调用保存/关闭/批量操作前冻结队列中的文本快照。 */
  barrier(document: T): void { this.pending.delete(document); }
}
