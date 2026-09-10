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

export function botRoundText(message: PlatformMessage, route: BotRoute, iteration: number): string {
  const parts = Array.isArray(message.characterDisplayParts) ? message.characterDisplayParts as PlatformMessage['parts'] : message.parts;
  const body = parts.filter(part => !part.thought && typeof part.text === 'string').map(part => part.text).join('');
  const considered = route.output?.showThoughts && (parts.some(part => part.thought) || milliseconds(message.thinkingDuration) !== undefined);
  const tools = route.output?.showToolStatus ? message.parts.flatMap(part => {
    const call = part.functionCall as { name?: string } | undefined;
    return typeof call?.name === 'string' ? [call.name] : [];
  }) : [];
  // 模型可能在未闭合的代码块中结束，先补齐围栏再放逐轮统计。
  const formattedBody = body ? splitBotText(body, Math.max(1900, body.length + 100))[0] : '';
  return [considered ? `**${thinkingComplete(message.thinkingDuration)}**` : '', formattedBody,
    botRoundStats(message, iteration, tools)].filter(Boolean).join('\n\n');
}
export function botRunReply(messages: PlatformMessage[], route: BotRoute, conclusion?: string): { text: string; footer?: string } {
  const rounds = messages.map((message, index) => botRoundText(message, route, index + 1));
  if (conclusion) rounds.push(conclusion);
  return { text: rounds.join('\n\n') || '任务已完成。', ...(messages.length ? { footer: botTotalStats(messages) } : {}) };
}
