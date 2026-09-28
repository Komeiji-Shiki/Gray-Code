import type { PlatformMessage } from '@graycode/contracts';
import type { Content } from '../../../../backend/modules/conversation/types';
import { isRealUserMessage } from '../../../../backend/modules/conversation/helpers';
import type { ContextUserMessageRetention } from '../../../../shared/contextManagement';

/** 历史身份不随总结覆盖标记改变；仍排除工具回执、控制消息和后台通知。 */
export function isHistoricalUserInput(message: PlatformMessage): boolean {
  return isRealUserMessage({ ...message, isSummarized: false } as Content);
}

export function retainedUserIds(messages: PlatformMessage[], policy?: ContextUserMessageRetention): Set<string> {
  const users = messages.filter(isHistoricalUserInput);
  // undefined 用于 Bot：保留其原来的首条活跃输入语义。
  const selected = policy === 'all' ? users : policy === 'first' ? [users[0], users.at(-1)]
    : [messages.find(message => isRealUserMessage(message as Content))];
  return new Set(selected.flatMap(message => message?.id ? [message.id] : []));
}
