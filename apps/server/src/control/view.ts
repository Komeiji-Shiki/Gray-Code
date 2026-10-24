import type { PlatformMessage, RunRecord, RunStatus } from '@graycode/contracts';

const previewLimit = 2_000;
const finishedStatuses = new Set<RunStatus>(['completed', 'failed', 'cancelled', 'interrupted']);

export const runFinished = (run: RunRecord): boolean => finishedStatuses.has(run.status);

type Part = Record<string, any>;

export function preview(value: unknown): { text: string; truncated?: true } {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  return text.length > previewLimit ? { text: text.slice(0, previewLimit), truncated: true } : { text };
}

function attachment(part: Part) {
  const media = part.inlineData ?? part.fileData;
  return media ? { mimeType: String(media.mimeType ?? '') } : undefined;
}

const replyText = (message: PlatformMessage) => (message.parts as Part[])
  .filter(part => typeof part.text === 'string' && part.thought !== true)
  .map(part => part.text as string).join('');

/**
 * 外部代理读取历史时的紧凑形态：正文、工具调用摘要和附件类型，不含思考内容与 base64 数据，
 * 工具参数和结果超过上限时截断。需要原始结构时使用 view=raw。
 */
export function compactMessage(message: PlatformMessage, index: number) {
  const parts = message.parts as Part[];
  const toolCalls = parts.filter(part => part.functionCall).map(part => {
    const call = part.functionCall;
    return { id: call.id, name: call.name, input: preview(call.args) };
  });
  const toolResults = parts.filter(part => part.functionResponse).map(part => {
    const result = part.functionResponse;
    const nested = (result.parts as Part[] | undefined)?.map(attachment).filter(Boolean) ?? [];
    return { id: result.id, name: result.name, output: preview(result.response), ...(nested.length ? { attachments: nested } : {}) };
  });
  const attachments = parts.map(attachment).filter(Boolean);
  const text = replyText(message);
  return {
    index, id: message.id, role: message.role === 'model' ? 'assistant' : message.role,
    ...(typeof message.runId === 'string' ? { runId: message.runId } : {}),
    ...(typeof message.timestamp === 'number' ? { timestamp: message.timestamp } : {}),
    ...(text ? { text } : {}),
    ...(toolCalls.length ? { toolCalls } : {}),
    ...(toolResults.length ? { toolResults } : {}),
    ...(attachments.length ? { attachments } : {}),
  };
}

/** 本次任务最后一条带正文的助手消息，即外部调用方等待的回复。 */
export function runReply(messages: PlatformMessage[], runId: string): string | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.runId !== runId || message.role !== 'model') continue;
    const text = replyText(message).trim();
    if (text) return text;
  }
  return undefined;
}
