import type { PlatformMessage, RunRecord } from '@graycode/contracts';
import type { PlatformApplication } from '../application';
import type { BotRoute } from './sessions';
import { botRoundStats, botTotalStats, milliseconds, thinkingComplete } from './messageStats';
import { splitBotText } from './text';

/** 从任务所属历史向前分页，越过本次输入即停止，不受最后 100 条消息的限制。 */
export async function botRunMessages(app: PlatformApplication, run: RunRecord): Promise<PlatformMessage[]> {
  const rounds: PlatformMessage[] = [];
  let beforeIndex: number | undefined;
  do {
    const page = await app.storage.readHistory(run.conversationId, { limit: 100, beforeIndex });
    rounds.unshift(...page.messages.filter(message => message.runId === run.id && message.role === 'model'));
    if (!page.startIndex || page.messages.some(message => message.runId === run.id && message.isUserInput)
      || page.messages.some(message => typeof message.timestamp === 'number' && message.timestamp < run.createdAt)) break;
    beforeIndex = page.startIndex;
  } while (beforeIndex);
  return rounds;
}

/** 供应商会给无摘要推理返回只有 thought 标记的空段（签名、摘要占位），这些不算可见思考。 */
function visibleThoughts(parts: PlatformMessage['parts']): string {
  return parts.filter(part => part.thought && typeof part.text === 'string').map(part => String(part.text)).join('');
}

export function botRoundText(message: PlatformMessage, route: BotRoute, iteration: number): string {
  const parts = Array.isArray(message.characterDisplayParts) ? message.characterDisplayParts as PlatformMessage['parts'] : message.parts;
  const body = parts.filter(part => !part.thought && typeof part.text === 'string').map(part => part.text).join('');
  const duration = milliseconds(message.thinkingDuration);
  const considered = route.output?.showThoughts && (!!visibleThoughts(parts).trim() || (duration !== undefined && duration > 0));
  const tools = route.output?.showToolStatus ? message.parts.flatMap(part => {
    const call = part.functionCall as { name?: string; args?: unknown } | undefined;
    return typeof call?.name === 'string' ? [{ name: call.name, args: call.args }] : [];
  }) : [];
  // 模型可能在未闭合的代码块中结束，先补齐围栏再放逐轮统计。
  const formattedBody = body ? splitBotText(body, Math.max(1900, body.length + 100))[0] : '';
  const content = [considered ? `**${thinkingComplete(message.thinkingDuration)}**` : '', formattedBody].filter(Boolean).join('\n\n');
  return (content ? content + (formattedBody ? '\n\n' : '\n') : '') + botRoundStats(message, iteration, tools);
}
export function botRunReply(messages: PlatformMessage[], route: BotRoute, conclusion?: string): { text: string; footer?: string } {
  const rounds = messages.map((message, index) => botRoundText(message, route, index + 1));
  if (conclusion) rounds.push(conclusion);
  return { text: rounds.join('\n\n') || '任务已完成。', ...(messages.length > 1 ? { footer: botTotalStats(messages) } : {}) };
}

/** QQ 文字段不渲染 Markdown：按消息段顺序拼出思考内容、工具名和正文，不发送工具参数。 */
export function botPlainRoundText(message: PlatformMessage, route: BotRoute): string {
  const parts = Array.isArray(message.characterDisplayParts) ? message.characterDisplayParts as PlatformMessage['parts'] : message.parts;
  const blocks: string[] = [];
  // QQ 是非流式渠道，直接发送完整的思维链正文，而不是等待耗时。
  const thoughts = route.output?.showThoughts ? visibleThoughts(parts) : '';
  if (thoughts.trim()) blocks.push(thoughts);
  let body = '';
  const flush = () => { if (body) { blocks.push(body); body = ''; } };
  for (const part of parts) {
    if (part.thought) continue;
    if (typeof part.text === 'string' && part.text) { body += part.text; continue; }
    const name = route.output?.showToolStatus ? (part.functionCall as { name?: unknown } | undefined)?.name : undefined;
    if (typeof name !== 'string') continue;
    flush();
    blocks.push(`调用工具：「${name.replace(/[\r\n]/g, ' ')}」`);
  }
  flush();
  return blocks.join('\n\n');
}

/** 每一轮模型输出单独成条：QQ 不能编辑消息，工具调用与正文的前后顺序只能靠多次发送保留。 */
export function botRunPlainReply(messages: PlatformMessage[], route: BotRoute, conclusion?: string): string[] {
  const rounds = messages.map(message => botPlainRoundText(message, route)).filter(Boolean);
  if (conclusion) rounds.push(conclusion);
  return rounds.length ? rounds : ['任务已完成。'];
}
