import type { BotMessageDiagnostic, BotMessageStage } from '@graycode/contracts';
import type { BotInbound } from './gateway';

/** 最近消息诊断仅驻留内存，正文只保留简短预览，重启后由真实新事件重新建立。 */
export class BotDiagnostics {
  private readonly records = new Map<string, BotMessageDiagnostic>();
  receive(message: BotInbound) {
    const at = Date.now();
    if (this.records.has(message.id)) return;
    if (this.records.size >= 100) this.records.delete(this.records.keys().next().value!);
    this.records.set(message.id, { id: message.id, channelId: message.channelId, userId: message.authorId,
      preview: message.content.slice(0, 160), receivedAt: at, updatedAt: at, stage: 'received', steps: [{ stage: 'received', at }] });
  }
  update(id: string, stage: BotMessageStage, reason?: string, conversationId?: string, runId?: string) {
    const record = this.records.get(id);
    if (!record) return;
    const at = Date.now();
    Object.assign(record, { stage, updatedAt: at, reason, ...(conversationId ? { conversationId } : {}), ...(runId ? { runId } : {}) });
    record.steps.push({ stage, at, reason });
    if (record.steps.length > 12) record.steps.splice(1, record.steps.length - 12);
  }
  list(): BotMessageDiagnostic[] { return structuredClone([...this.records.values()].reverse()); }
}
