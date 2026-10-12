import type { PlatformMessage } from '@graycode/contracts';
import type { Content, ContentPart } from '../../../../backend/modules/conversation/types';
import { isRealUserMessage } from '../../../../backend/modules/conversation/helpers';
import { computeValidSuffixMap } from '../../../../backend/modules/api/chat/services/contextTrim/historyNormalization';
import { ContextBudgetExceededError } from '../../../../backend/modules/api/chat/services/contextTrim/granularFallback';
import type { ContextBudget, ContextBudgetCounter } from './budget';

type ModelPart = ContentPart & Record<string, unknown>;
interface TrimmedContextRequest {
  messages: PlatformMessage[];
  budget: ContextBudget;
  startId?: string;
  truncatedMessageIds?: string[];
}

/** 裁剪已组装的请求副本；一次扫描同时保护最近输入和仍在执行的工具调用。 */
export function trimContextRequest(messages: PlatformMessage[], budget: ContextBudget, counter: Pick<ContextBudgetCounter, 'evaluate' | 'estimateMessage'>,
  pendingAsyncCallIds?: ReadonlySet<string>, stableStartId?: string): TrimmedContextRequest {
  if (!budget.exceedsInputLimit && !stableStartId) return { messages, budget, startId: undefined };
  const required = new Set<number>();
  const users = messages.map((message, index) => isRealUserMessage(message as Content) && !message.memoryContext ? index : -1)
    .filter(index => index >= 0);
  for (const index of [users[0], users.at(-1)]) {
    if (index === undefined) continue;
    required.add(index);
    for (let previous = index - 1; previous >= 0 && messages[previous].memoryContext; previous--) required.add(previous);
  }
  let latestStart = messages.length - 1;
  messages.forEach((message, index) => {
    if ((message.parts as ModelPart[]).some(part => part.functionCall && pendingAsyncCallIds?.has(String(part.functionCall.id))))
      latestStart = Math.min(latestStart, index);
  });
  const valid = computeValidSuffixMap(messages as Content[]);
  const suffix = new Array<number>(messages.length + 1).fill(0);
  const preserved = new Array<number>(messages.length + 1).fill(0);
  for (let index = messages.length - 1; index >= 0; index--) suffix[index] = suffix[index + 1] + budget.messageTokens[index];
  for (let index = 0; index < messages.length; index++) preserved[index + 1] = preserved[index]
    + (required.has(index) ? budget.messageTokens[index] : 0);
  const fits = (index: number) => index >= 0 && index <= latestStart && valid[index]
    && budget.fixedTokens + suffix[index] + preserved[index] <= budget.maxInputTokens;
  let start = stableStartId ? messages.findIndex(message => message.id === stableStartId) : -1;
  if (!fits(start)) {
    start = -1;
    for (let index = 0; index <= latestStart; index++) if (fits(index)) { start = index; break; }
  }
  if (start < 0) {
    let minimum = Number.POSITIVE_INFINITY;
    for (let index = 0; index <= latestStart; index++) {
      if (!valid[index]) continue;
      const tokens = suffix[index] + preserved[index];
      if (tokens < minimum) { minimum = tokens; start = index; }
    }
  }
  if (start < 0) throw new ContextBudgetExceededError(budget.inputTokens, budget.maxInputTokens);
  const selected = [...required].filter(index => index < start).sort((a, b) => a - b).map(index => messages[index])
    .concat(messages.slice(start));
  let selectedBudget = counter.evaluate(selected);
  const truncatedMessageIds: string[] = [];
  if (selectedBudget.exceedsInputLimit) {
    // 仅单个结果自身超过完整输入窗口时替换文本；累计超限不能改变任何正常结果。
    for (let index = 0; index < selected.length; index++) {
      const message = selected[index];
      if (!message.id) continue;
      let changed = false;
      const parts = (message.parts as ModelPart[]).map(part => {
        if (!part.functionResponse) return part;
        const { id, name, response } = part.functionResponse;
        const textParts = part.functionResponse.parts?.flatMap(nested => typeof nested.text === 'string'
          ? [Object.keys(nested).length === 1 ? nested : { text: nested.text }] : []);
        const textOnly = { role: message.role, parts: [{ functionResponse: { id, name, response, parts: textParts } }] };
        if (counter.estimateMessage(textOnly) <= budget.maxInputTokens) return part;
        const attachments = part.functionResponse.parts?.flatMap(nested => {
          if (typeof nested.text !== 'string') return [nested];
          const { text: _text, ...other } = nested;
          return Object.keys(other).length ? [other] : [];
        });
        const shortened = { ...part, functionResponse: { ...part.functionResponse, ...(attachments ? { parts: attachments } : {}), response: {
          contextTruncated: true, messageId: message.id, toolCallId: part.functionResponse.id,
          message: `Tool text exceeded the input budget. Read the stored result with context_history action=read messageId=${message.id} using offset and limit.`,
        } } };
        changed = true;
        return shortened;
      });
      if (!changed) continue;
      selected[index] = { ...message, parts };
      truncatedMessageIds.push(message.id);
    }
    selectedBudget = counter.evaluate(selected);
  }
  if (selectedBudget.exceedsInputLimit) throw new ContextBudgetExceededError(selectedBudget.inputTokens, budget.maxInputTokens);
  return { messages: selected, budget: selectedBudget, startId: messages[start]?.id, truncatedMessageIds };
}
