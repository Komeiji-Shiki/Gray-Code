import { pathToFileURL } from 'node:url';
import type { ConversationNavigationCursor, ConversationNavigationItem, ConversationNavigationResult, ConversationSummary } from '@graycode/contracts';
import type { PlatformApplication } from '../application';
import { conversationWorkspaceIndex, workspaceDirectoryKey } from '../workspace/identity';
import { ProjectNavigation, projectNavigationKey, type ProjectNavigationPreference } from './projects';
import { NavigationOrderingStore } from './navigationOrdering';
import { orderSidebarItems } from '../../../../shared/sidebarOrder';
const namespace = 'conversation-navigation';

/** 侧边栏只读取摘要和运行索引，点击对话后才装载对应消息。 */
export class ConversationNavigation {
  constructor(private readonly app: PlatformApplication) {}
  async list(actorId: string, options: { scope?: 'personal' | 'bots'; query?: string; cursor?: ConversationNavigationCursor } = {}): Promise<ConversationNavigationResult> {
    this.app.requireOwner(actorId);
    if (options.scope !== undefined && !['personal', 'bots'].includes(options.scope)) throw new Error('未知对话列表。');
    const ordering = await new NavigationOrderingStore(this.app).get(actorId, options.scope);
    if (options.cursor && options.cursor.orderingRevision !== ordering.revision) throw new Error('侧边栏顺序已变化，请刷新列表。');
    const botPlatform = (item: { id?: string; botPlatform?: string; custom?: { botOrigin?: { platform?: string } } }): ConversationSummary['botPlatform'] => {
      const value = item.botPlatform ?? item.custom?.botOrigin?.platform;
      return value === 'discord' || value === 'onebot' ? value : undefined;
    };
    const included = (item: Parameters<typeof botPlatform>[0]) => (options.scope === 'bots') === ['discord', 'onebot'].includes(botPlatform(item) ?? '');
    const workspaces = this.app.settings.read('workspaces').workspaces.map(item => ({ ...item, uri: pathToFileURL(item.directory).toString() }));
    const workspaceFor = conversationWorkspaceIndex(workspaces);
    const projects = await new ProjectNavigation(this.app).preferences();
    const directoryCounts = new Map<string | undefined, number>();
    const workspaceKeys = new Map(workspaces.map(item => [item.id, workspaceDirectoryKey(item.directory)]));
    for (const key of workspaceKeys.values()) directoryCounts.set(key, (directoryCounts.get(key) ?? 0) + 1);
    // 项目设置在本次查询中固定，每个项目只解析一次目录与偏好。
    const workspacePreferences = new Map(workspaces.map(workspace => {
      const direct = projects.get(projectNavigationKey({ workspaceId: workspace.id }));
      // 同一主目录存在多个显式工作区时，旧对话的目录设置不能覆盖这些独立项目。
      const value = workspace.managedConversationId ? undefined : direct ?? ((directoryCounts.get(workspaceKeys.get(workspace.id)) ?? 0) > 1
        ? undefined : projects.get(projectNavigationKey({ workspaceUri: workspace.uri })));
      return [workspace.id, value] as const;
    }));
    const legacyPreferences = new Map<string, ProjectNavigationPreference | undefined>();
    const preference = (item: { workspaceId?: string; workspaceUri?: string }) => {
      const workspace = workspaceFor(item);
      if (workspace) return workspacePreferences.get(workspace.id);
      const uri = item.workspaceUri;
      if (!uri) return undefined;
      if (!legacyPreferences.has(uri)) legacyPreferences.set(uri, projects.get(projectNavigationKey({ workspaceUri: uri })));
      return legacyPreferences.get(uri);
    };
    const hidden = this.app.subagents.childConversationIds();
    const pins = new Map<string, number>();
    for (const id of await this.app.storage.listRecords(namespace)) {
      const value = await this.app.storage.getRecord(namespace, id) as { pinnedAt?: number } | null;
      if (value?.pinnedAt && !hidden.has(id)) pins.set(id, value.pinnedAt);
    }
    const query = options.query?.trim().toLocaleLowerCase() ?? '';
    const matches = query ? await this.app.storage.searchConversationIds(query) : undefined;
    const matching = new Map(matches?.matches.map(item => [item.id, item]) ?? []);
    const enrich = (item: Omit<ConversationSummary, 'revision'>): ConversationNavigationItem => {
      const hit = matching.get(item.id);
      const workspace = workspaceFor(item);
      return { ...item,
        automaticWorkspace: !!workspace?.managedConversationId,
        workspaceId: workspace?.id,
        workspaceIdentity: workspaceDirectoryKey(item.workspaceUri),
        botPlatform: botPlatform(item),
        projectName: preference(item)?.name,
        ...(pins.has(item.id) ? { pinnedAt: pins.get(item.id) } : {}),
        ...(hit?.messageIndex !== undefined ? { searchHit: {
          messageIndex: hit.messageIndex, ...(hit.messageId ? { messageId: hit.messageId } : {}), excerpt: hit.excerpt ?? '',
        } } : {}),
      };
    };
    const pinned: ConversationNavigationItem[] = [];
    if (pins.size) {
      const ids = [...pins.keys()];
      // 旧宿主的批量摘要最多返回 200 条，置顶数量不能因此被静默截断。
      for (let offset = 0; offset < ids.length; offset += 200) {
        const summaries = await this.app.productUi.conversations.getConversationMetadataBatch(ids.slice(offset, offset + 200));
        for (const item of summaries) {
          if (!item || query && !matching.has(item.id)) continue;
          const metadata = await this.app.storage.getConversation(item.id);
          const origin = (metadata?.custom as { botOrigin?: { platform?: string } } | undefined)?.botOrigin?.platform;
          const summary = { ...item, workspaceId: typeof metadata?.workspaceId === 'string' ? metadata.workspaceId : undefined, botPlatform: botPlatform({ botPlatform: origin }) };
          if (included(summary)) pinned.push(enrich(summary));
        }
      }
      pinned.sort((a, b) => (a.pinnedAt ?? 0) - (b.pinnedAt ?? 0));
    }
    const items: ConversationNavigationItem[] = []; let cursor = options.cursor?.recent;
    let orderedOffset = options.cursor?.orderedOffset ?? 0;
    if (!Number.isSafeInteger(orderedOffset) || orderedOffset < 0 || orderedOffset > ordering.conversations.length) throw new Error('侧边栏分页位置无效。');
    const orderedIds = new Set(ordering.conversations);
    // 手动排列的旧对话直接读取摘要，翻页和重新启动后仍保留其显示位置。
    while (orderedOffset < ordering.conversations.length && items.length < 30) {
      const ids = ordering.conversations.slice(orderedOffset, orderedOffset + 30 - items.length);
      const summaries = await this.app.productUi.conversations.getConversationMetadataBatch(ids);
      const summariesById = new Map(summaries.filter(Boolean).map(summary => [summary.id, summary]));
      orderedOffset += ids.length;
      for (const id of ids) {
        const item = summariesById.get(id);
        if (!item || pins.has(id) || hidden.has(id) || query && !matching.has(id)) continue;
        const metadata = await this.app.storage.getConversation(id);
        const origin = (metadata?.custom as { botOrigin?: { platform?: string } } | undefined)?.botOrigin?.platform;
        // 旧批量摘要只有目录 URI，显式项目 ID 必须取自已有的元数据读取。
        const summary = { ...item, workspaceId: typeof metadata?.workspaceId === 'string' ? metadata.workspaceId : undefined, botPlatform: botPlatform({ botPlatform: origin }) };
        if (included(summary) && (options.scope === 'bots' || !preference(summary)?.removed)) items.push(enrich(summary));
      }
    }
    let recentStarted = !!options.cursor?.recent;
    if (items.length < 30) do {
      recentStarted = true;
      const page = await this.app.storage.listConversations({ limit: 30 - items.length, cursor, query: options.query });
      items.push(...page.items.filter(item => included(item) && !hidden.has(item.id) && !pins.has(item.id) && !orderedIds.has(item.id) && (options.scope === 'bots' || !preference(item)?.removed)).map(enrich)); cursor = page.nextCursor;
    } while (cursor && items.length < 30);
    const runs = (await this.app.storage.listRuns({ activeOnly: true, limit: 1000 })).filter(run => !hidden.has(run.conversationId))
      .map(({ id, conversationId, status }) => ({ id, conversationId, status }));
    return { items, pinned: orderSidebarItems(pinned, ordering.pinned, item => item.id), ordering,
      ...(matches?.indexing ? { searchIndexing: true } : {}),
      workspaces: workspaces.filter(item => options.scope !== 'bots' && !item.managedConversationId && !item.id.startsWith('workspace-bot_') && !preference({ workspaceId: item.id })?.removed)
        .map(item => ({ ...item, name: preference({ workspaceId: item.id })?.name ?? item.name })), runs,
      ...(cursor || orderedOffset < ordering.conversations.length || !recentStarted ? { nextCursor: { orderedOffset, orderingRevision: ordering.revision, ...(cursor ? { recent: cursor } : {}) } } : {}) };
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
