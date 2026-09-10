import { pathToFileURL } from 'node:url';
import type { ConversationNavigationItem, ConversationNavigationResult, ConversationSummary } from '@graycode/contracts';
import type { PlatformApplication } from '../application';
import { conversationWorkspace, workspaceDirectoryKey } from '../workspace/identity';
import { ProjectNavigation, projectNavigationKey } from './projects';
const namespace = 'conversation-navigation';

/** 侧边栏只读取摘要和运行索引，点击对话后才装载对应消息。 */
export class ConversationNavigation {
  constructor(private readonly app: PlatformApplication) {}
  async list(actorId: string, options: { scope?: 'personal' | 'bots'; query?: string; cursor?: { updatedAt: number; id: string } } = {}): Promise<ConversationNavigationResult> {
    this.app.requireOwner(actorId);
    if (options.scope !== undefined && !['personal', 'bots'].includes(options.scope)) throw new Error('未知对话列表。');
    const botPlatform = (item: { id?: string; botPlatform?: string; custom?: { botOrigin?: { platform?: string } } }): ConversationSummary['botPlatform'] => {
      const value = item.botPlatform ?? item.custom?.botOrigin?.platform;
      return value === 'discord' || value === 'onebot' ? value : undefined;
    };
    const included = (item: Parameters<typeof botPlatform>[0]) => (options.scope === 'bots') === ['discord', 'onebot'].includes(botPlatform(item) ?? '');
    const workspaces = this.app.settings.snapshot().settings.workspaces.map(item => ({ ...item, uri: pathToFileURL(item.directory).toString() }));
    const projects = await new ProjectNavigation(this.app).preferences();
    const preference = (item: { workspaceId?: string; workspaceUri?: string }) => {
      const workspace = conversationWorkspace(item, workspaces);
      if (workspace?.managedConversationId) return undefined;
      const direct = workspace && projects.get(projectNavigationKey({ workspaceId: workspace.id }));
      if (direct) return direct;
      const uri = workspace ? pathToFileURL(workspace.directory).toString() : item.workspaceUri;
      // 同一主目录存在多个显式工作区时，旧对话的目录设置不能覆盖这些独立项目。
      if (workspace && workspaces.filter(value => workspaceDirectoryKey(value.directory) === workspaceDirectoryKey(uri)).length > 1) return undefined;
      return uri ? projects.get(projectNavigationKey({ workspaceUri: uri })) : undefined;
    };
    const hidden = this.app.subagents.childConversationIds();
    const pins = new Map<string, number>();
    for (const id of await this.app.storage.listRecords(namespace)) {
      const value = await this.app.storage.getRecord(namespace, id) as { pinnedAt?: number } | null;
      if (value?.pinnedAt && !hidden.has(id)) pins.set(id, value.pinnedAt);
    }
    const enrich = (item: Omit<ConversationSummary, 'revision'>): ConversationNavigationItem => ({ ...item,
      automaticWorkspace: !!conversationWorkspace(item, workspaces)?.managedConversationId,
      workspaceId: conversationWorkspace(item, workspaces)?.id,
      workspaceIdentity: workspaceDirectoryKey(item.workspaceUri),
      botPlatform: botPlatform(item),
      projectName: preference(item)?.name,
      ...(pins.has(item.id) ? { pinnedAt: pins.get(item.id) } : {}),
    });
    const pinned: ConversationNavigationItem[] = [];
    const query = options.query?.trim().toLocaleLowerCase() ?? '';
    if (pins.size) {
      const summaries = await this.app.productUi.conversations.getConversationMetadataBatch([...pins.keys()]);
      for (const item of summaries) {
        if (!item || query && !item.title?.toLocaleLowerCase().includes(query)) continue;
        const metadata = await this.app.storage.getConversation(item.id);
        const origin = (metadata?.custom as { botOrigin?: { platform?: string } } | undefined)?.botOrigin?.platform;
        const summary = { ...item, botPlatform: botPlatform({ botPlatform: origin }) };
        if (included(summary)) pinned.push(enrich(summary));
      }
      pinned.sort((a, b) => (a.pinnedAt ?? 0) - (b.pinnedAt ?? 0));
    }
    const items: ConversationNavigationItem[] = []; let cursor = options.cursor;
    do {
      const page = await this.app.storage.listConversations({ limit: 30 - items.length, cursor, query: options.query });
      items.push(...page.items.filter(item => included(item) && !hidden.has(item.id) && !pins.has(item.id) && (options.scope === 'bots' || !preference(item)?.removed)).map(enrich)); cursor = page.nextCursor;
    } while (cursor && items.length < 30);
    const runs = (await this.app.storage.listRuns({ activeOnly: true, limit: 1000 })).filter(run => !hidden.has(run.conversationId))
      .map(({ id, conversationId, status }) => ({ id, conversationId, status }));
    return { items, pinned, workspaces: workspaces.filter(item => options.scope !== 'bots' && !item.managedConversationId && !item.id.startsWith('workspace-bot_') && !preference({ workspaceId: item.id })?.removed)
      .map(item => ({ ...item, name: preference({ workspaceId: item.id })?.name ?? item.name })), runs, ...(cursor ? { nextCursor: cursor } : {}) };
  }
  async pin(actorId: string, conversationId: string, pinned: boolean) {
    this.app.requireOwner(actorId); await this.app.conversation(actorId, conversationId);
    const current = await this.app.storage.getVersionedRecord(namespace, conversationId);
    await this.app.storage.commitRecords([{ namespace, id: conversationId, ownerId: conversationId, expectedRevision: current.revision,
      ...(pinned ? { value: { pinnedAt: (current.value as { pinnedAt?: number } | null)?.pinnedAt ?? Date.now() } } : { delete: true }) }]);
    this.app.publish({ type: 'conversation.changed', conversationId, metadataOnly: true }); return { success: true };
  }
  async rename(actorId: string, conversationId: string, title: string) {
    this.app.requireOwner(actorId); await this.app.conversation(actorId, conversationId);
    if (typeof title !== 'string' || !title.trim() || title.trim().length > 300) throw new Error('对话标题需要 1 至 300 个字符。');
    await this.app.productUi.conversations.setTitle(conversationId, title.trim());
    this.app.publish({ type: 'conversation.changed', conversationId, metadataOnly: true }); return { success: true };
  }
}
