import type { PlatformMessage } from '@graycode/contracts';

/** 摘要列表、详情与生成校验统一只读取可见正文。 */
export function extractSummaryText(message: Pick<PlatformMessage, 'parts'>): string {
  return message.parts.filter(part => typeof part.text === 'string' && !part.thought).map(part => part.text).join('\n');
}
