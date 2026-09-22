import type { ConversationNavigationItem } from '../packages/contracts/src/navigation';

/** 只重排展示位置，未手动排列的条目保持调用方原有顺序。 */
export function orderSidebarItems<T>(items: readonly T[], order: readonly string[], key: (item: T) => string): T[] {
  const positions = new Map(order.map((id, index) => [id, index]));
  return [...items].sort((left, right) => (positions.get(key(left)) ?? order.length) - (positions.get(key(right)) ?? order.length));
}

export function moveSidebarItem(ids: readonly string[], source: string, target: string, after: boolean): string[] {
  if (source === target || !ids.includes(source) || !ids.includes(target)) return [...ids];
  const result = ids.filter(id => id !== source);
  result.splice(result.indexOf(target) + Number(after), 0, source);
  return result;
}

export function conversationOrderGroup(item: Pick<ConversationNavigationItem, 'workspaceId' | 'workspaceUri' | 'workspaceIdentity' | 'automaticWorkspace' | 'botPlatform'>): string {
  if (item.botPlatform) return item.botPlatform;
  if (item.automaticWorkspace) return 'general';
  return item.workspaceId || item.workspaceIdentity || item.workspaceUri || 'general';
}
