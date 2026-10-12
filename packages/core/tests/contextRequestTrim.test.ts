import type { PlatformMessage } from '@graycode/contracts';
import { trimContextRequest } from '../../../apps/server/src/context/requestTrim';
import type { ContextBudget } from '../../../apps/server/src/context/budget';
import { ContextBudgetExceededError } from '../../../backend/modules/api/chat/services/contextTrim/granularFallback';
import type { ContentPart } from '../../../backend/modules/conversation/types';

interface ToolHistoryMessage extends PlatformMessage {
  parts: Array<ContentPart & Record<string, unknown>>;
}

// 固定计数夹具只验证裁剪边界，词表与媒体估算由 tokenizer 的定向测试覆盖。
function counter(fixedTokens = 0, maxInputTokens = 1000) {
  const estimateMessage = (message: PlatformMessage): number => Math.max(1, (message.parts as ContentPart[]).reduce((sum, part) => {
    const response = part.functionResponse?.response;
    const text = typeof response?.content === 'string' ? response.content : typeof response?.message === 'string' ? response.message : '';
    return sum + (part.text?.length ?? 0) + text.length + (part.functionCall ? 1 : 0) + (part.inlineData ? 50 : 0)
      + (part.functionResponse?.parts ?? []).reduce((nested, item) => nested + (item.text?.length ?? 0) + (item.inlineData ? 50 : 0), 0);
  }, 0));
  const evaluate = (messages: PlatformMessage[]): ContextBudget => {
    const messageTokens = messages.map(estimateMessage);
    const historyTokens = messageTokens.reduce((sum, value) => sum + value, 0);
    return { inputTokens: fixedTokens + historyTokens, historyTokens, fixedTokens, maxInputTokens,
      softLimitTokens: maxInputTokens * 0.8, messageTokens,
      exceedsSoftLimit: fixedTokens + historyTokens > maxInputTokens * 0.8,
      exceedsInputLimit: fixedTokens + historyTokens > maxInputTokens };
  };
  return { estimateMessage, evaluate };
}

function history(length: number): ToolHistoryMessage[] {
  return [
    { id: 'user', role: 'user', isUserInput: true, parts: [{ text: 'task' }] },
    { id: 'call', role: 'model', parts: [{ functionCall: { id: 'read-1', name: 'read_file', args: {} } }] },
    { id: 'result', role: 'user', parts: [{ functionResponse: { id: 'read-1', name: 'read_file', response: { content: 'x'.repeat(length) } } }] },
  ];
}

describe('请求级上下文硬预算裁剪', () => {
  test('单条巨型文本固定替换，保留附件、调用配对与存档原文', () => {
    const messages = history(1200);
    const image = { inlineData: { mimeType: 'image/png', data: 'saved-image' } };
    messages[2].parts.push(image);
    const source = messages[2].parts[0].functionResponse!.response;
    const first = counter(100);
    const second = counter(250);
    const a = trimContextRequest(messages, first.evaluate(messages), first);
    const b = trimContextRequest(messages, second.evaluate(messages), second);
    expect(a.budget.exceedsInputLimit).toBe(false);
    expect(a.messages.map(message => message.id)).toEqual(['user', 'call', 'result']);
    expect(a.messages[2].parts[0].functionResponse).toEqual(b.messages[2].parts[0].functionResponse);
    expect(a.messages[2].parts[1]).toBe(image);
    expect(a.messages[2].parts[0].functionResponse).toMatchObject({ id: 'read-1', name: 'read_file', response: { contextTruncated: true, messageId: 'result' } });
    expect(messages[2].parts[0].functionResponse!.response).toBe(source);
    expect(source).toEqual({ content: 'x'.repeat(1200) });
  });

  test.each([950, 1000])('结果自身 %i token 未超过窗口时，固定前缀超限不能触发替换', length => {
    const messages = history(length);
    const budget = counter(100);
    expect(() => trimContextRequest(messages, budget.evaluate(messages), budget)).toThrow(ContextBudgetExceededError);
    expect(messages[2].parts[0].functionResponse!.response).toEqual({ content: 'x'.repeat(length) });
  });

  test('同一消息的多个正常结果累计超限不能逐项省略', () => {
    const messages = history(600);
    messages[1].parts.push({ functionCall: { id: 'read-2', name: 'read_file', args: {} } });
    messages[2].parts.push({ functionResponse: { id: 'read-2', name: 'read_file', response: { content: 'y'.repeat(600) } } });
    const budget = counter();
    expect(() => trimContextRequest(messages, budget.evaluate(messages), budget)).toThrow(ContextBudgetExceededError);
    expect(messages[2].parts.every(part => typeof part.functionResponse?.response?.content === 'string')).toBe(true);
  });

  test('图片造成超限时不能替换原本可容纳的工具文本', () => {
    const messages = history(990);
    messages[2].parts[0].functionResponse!.parts = [{ inlineData: { mimeType: 'image/png', data: 'saved-image' } }];
    const budget = counter();
    expect(() => trimContextRequest(messages, budget.evaluate(messages), budget)).toThrow(ContextBudgetExceededError);
    expect(messages[2].parts[0].functionResponse!.response).toEqual({ content: 'x'.repeat(990) });
  });

  test('单个结果的 JSON 与嵌套文本共同超限时固定替换文本并保留嵌套图片', () => {
    const messages = history(600);
    const image = { inlineData: { mimeType: 'image/png', data: 'saved-image' } };
    messages[2].parts[0].functionResponse!.parts = [{ text: 'nested'.repeat(100) }, image];
    const budget = counter();
    const result = trimContextRequest(messages, budget.evaluate(messages), budget);
    const resultParts = result.messages[2].parts as ContentPart[];
    expect(result.budget.exceedsInputLimit).toBe(false);
    expect(resultParts[0].functionResponse!.parts).toEqual([image]);
    expect(resultParts[0].functionResponse!.parts![0]).toBe(image);
    expect(messages[2].parts[0].functionResponse!.parts![0]).toEqual({ text: 'nested'.repeat(100) });
  });

  test('裁掉早期正文后仍保留待完成异步调用及最近完整工具配对', () => {
    const messages: PlatformMessage[] = [
      { id: 'first', role: 'user', isUserInput: true, parts: [{ text: 'task' }] },
      { id: 'old', role: 'model', parts: [{ text: 'x'.repeat(1200) }] },
      { id: 'pending', role: 'model', parts: [{ functionCall: { id: 'pending-1', name: 'run_job', args: {}, async: true } }] },
      ...history(50),
    ];
    const budget = counter();
    const result = trimContextRequest(messages, budget.evaluate(messages), budget, new Set(['pending-1']));
    expect(result.messages.map(message => message.id)).toEqual(['first', 'pending', 'user', 'call', 'result']);
    expect(result.messages.at(-1)).toBe(messages.at(-1));
    expect(result.budget.exceedsInputLimit).toBe(false);
  });
});
