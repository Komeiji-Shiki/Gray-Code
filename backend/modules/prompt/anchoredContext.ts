import type { Content } from '../conversation/types';

/** 插入位置锚定真实消息 ID，后续工具迭代与旧回合恢复不会重新计算深度。 */
export function insertAnchoredPromptMessages(history: Content[], insertions: Content[]): Content[] {
  if (!insertions.length) return history;
  const positions = new Map(history.map((message, index) => [message.id, index]));
  const buckets = new Map<number, Content[]>();
  for (const message of insertions) {
    const anchor = message.promptAnchor;
    if (!anchor) continue;
    const target = anchor.messageId ? positions.get(anchor.messageId) : undefined;
    const position = target === undefined ? 0 : target + (anchor.edge === 'after' ? 1 : 0);
    const bucket = buckets.get(position) ?? []; bucket.push(message); buckets.set(position, bucket);
  }
  const output: Content[] = [];
  for (let index = 0; index <= history.length; index++) {
    const bucket = buckets.get(index);
    if (bucket) output.push(...bucket.sort((a, b) => (a.promptAnchor?.order ?? 0) - (b.promptAnchor?.order ?? 0)));
    if (index < history.length) output.push(history[index]);
  }
  return output;
}
