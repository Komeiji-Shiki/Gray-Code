import type { NavigationOrdering, NavigationOrderKind } from '@graycode/contracts';
import type { PlatformApplication } from '../application';
import { conversationWorkspace, workspaceDirectoryKey } from '../workspace/identity';
import { conversationOrderGroup } from '../../../../shared/sidebarOrder';

const namespace = 'conversation-navigation-order';
type Scope = 'personal' | 'bots';

export class NavigationOrderingStore {
  constructor(private readonly app: PlatformApplication) {}
  async get(actorId: string, scope: Scope = 'personal'): Promise<NavigationOrdering> {
    this.app.requireOwner(actorId);
    if (!['personal', 'bots'].includes(scope)) throw new Error('未知侧边栏列表。');
    const saved = await this.app.storage.getVersionedRecord(namespace, JSON.stringify([actorId, scope]));
    return { groups: [], pinnedGroups: [], conversations: [], pinned: [], drafts: [], ...saved.value as Partial<NavigationOrdering>, revision: saved.revision ?? 0 };
  }

  async pinGroup(actorId: string, input: { key: string; pinned: boolean; revision: number }) {
    this.app.requireOwner(actorId);
    if (typeof input.key !== 'string' || typeof input.pinned !== 'boolean' ||
      input.key !== 'general' && !this.app.settings.snapshot().settings.workspaces.some(workspace =>
        workspace.id === input.key && !workspace.managedConversationId && !workspace.id.startsWith('workspace-bot_')))
      throw new Error('这个对话分组不存在。');
    const current = await this.get(actorId);
    if (current.revision !== input.revision) throw new Error('侧边栏顺序已变化，请刷新后重试。');
    if (current.pinnedGroups.includes(input.key) === input.pinned) return current;
    // 置顶状态只决定分组所在区域，原有手动排列顺序继续保留。
    const pinnedGroups = input.pinned ? [...current.pinnedGroups, input.key] : current.pinnedGroups.filter(key => key !== input.key);
    const { revision, ...value } = { ...current, pinnedGroups };
    await this.app.storage.commitRecords([{ namespace, id: JSON.stringify([actorId, 'personal']), ownerId: actorId,
      expectedRevision: revision || null, value }]);
    this.app.publish({ type: 'conversation.navigation.changed' });
    return this.get(actorId);
  }

  async reorder(actorId: string, input: { scope?: Scope; kind: NavigationOrderKind; ids: string[]; revision: number }) {
    this.app.requireOwner(actorId);
    const scope = input.scope ?? 'personal';
    if (!['groups', 'conversations', 'pinned', 'drafts'].includes(input.kind) || !Array.isArray(input.ids) || !input.ids.length || input.ids.length > 10000 ||
      input.ids.some(id => typeof id !== 'string' || !id || id.length > 8192) || new Set(input.ids).size !== input.ids.length) throw new Error('侧边栏排序列表无效。');
    const current = await this.get(actorId, scope);
    if (current.revision !== input.revision) throw new Error('侧边栏顺序已变化，请刷新后重试。');
    if (input.kind === 'conversations' || input.kind === 'pinned') {
      const groups = new Set<string>();
      const workspaces = this.app.settings.snapshot().settings.workspaces;
      const hidden = this.app.subagents.childConversationIds();
      for (const id of input.ids) {
        if (hidden.has(id)) throw new Error('子任务不在当前侧边栏列表中。');
        const conversation = await this.app.conversation(actorId, id);
        const origin = (conversation.custom as { botOrigin?: { platform?: string } } | undefined)?.botOrigin?.platform;
        const botPlatform = origin === 'discord' || origin === 'onebot' ? origin : undefined;
        if ((scope === 'bots') !== !!botPlatform) throw new Error('只能调整同一列表内的显示顺序。');
        const pin = await this.app.storage.getRecord('conversation-navigation', id) as { pinnedAt?: number } | null;
        if ((input.kind === 'pinned') !== !!pin?.pinnedAt) throw new Error('对话的置顶状态已变化，请刷新后重试。');
        const workspace = conversationWorkspace(conversation, workspaces);
        groups.add(conversationOrderGroup({ workspaceId: workspace?.id, workspaceUri: conversation.workspaceUri,
          workspaceIdentity: workspaceDirectoryKey(conversation.workspaceUri), automaticWorkspace: !!workspace?.managedConversationId, botPlatform }));
      }
      if (input.kind === 'conversations' && groups.size > 1) throw new Error('拖动仅调整同一分组内的顺序。');
    }
    const changed = new Set(input.ids), previous = current[input.kind];
    const first = previous.findIndex(id => changed.has(id));
    const remaining = previous.filter(id => !changed.has(id));
    const position = first < 0 ? remaining.length : previous.slice(0, first).filter(id => !changed.has(id)).length;
    remaining.splice(position, 0, ...input.ids);
    const { revision, ...value } = { ...current, [input.kind]: remaining };
    await this.app.storage.commitRecords([{ namespace, id: JSON.stringify([actorId, scope]), ownerId: actorId,
      expectedRevision: revision || null, value }]);
    this.app.publish({ type: 'conversation.navigation.changed' });
    return this.get(actorId, scope);
  }
}
