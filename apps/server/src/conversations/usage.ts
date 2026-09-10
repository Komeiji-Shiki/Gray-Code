import type { ConversationSummary, PlatformConversation } from '@graycode/contracts';
import { aggregateUsageStats, buildConversationUsageIndex, extractBranchUsageMessages,
  type UsageIndex, type UsageIndexMessage } from '../../../../backend/modules/conversation/usageStats';
import type { Content, ConversationMetadata } from '../../../../backend/modules/conversation/types';
import type { ConversationBranchGraph } from '../../../../backend/modules/conversation/branch/types';
import type { PlatformApplication } from '../application';

interface CachedUsage { signature: string; value: UsageIndex }
type UsageQuery = { startTime?: number; endTime?: number };
type UsageResult = Awaited<ReturnType<typeof aggregateUsageStats>> & { readErrors: Record<string, string> };
export function validateLegacyUsageIndex(value: unknown, conversationId: string): UsageIndex {
  const index = value as UsageIndex;
  if (!index || index.version !== 1 || index.conversationId !== conversationId || !Array.isArray(index.messages))
    throw new Error(`旧用量索引格式无效：${conversationId}`);
  for (const item of index.messages) {
    if (!item || ![item.prompt, item.candidates, item.thoughts, item.cacheCreation ?? 0, item.cacheRead ?? 0].every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0) ||
      item.modelVersion !== undefined && typeof item.modelVersion !== 'string' || item.id !== undefined && typeof item.id !== 'string' ||
      item.source !== undefined && !['main', 'subagent', 'branch'].includes(item.source)) throw new Error(`旧用量条目无效：${conversationId}`);
  }
  return index;
}
function importedSubagentUsage(value: unknown, conversationId: string): UsageIndexMessage[] {
  return value === null ? [] : validateLegacyUsageIndex(value, conversationId).messages.filter(item => item.source === 'subagent')
    .map(item => ({ ...item, cacheCreation: item.cacheCreation ?? 0, cacheRead: item.cacheRead ?? 0 }));
}

/** 沿用原统计算法，主历史、分支与旧子代理明细从新版存储读取。 */
export class PlatformUsage {
  private readonly cache = new Map<string, CachedUsage>();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly pending = new Map<string, Promise<UsageResult>>();
  constructor(private readonly app: PlatformApplication) {
    app.subscribe(event => { if (event.type === 'migration.completed') this.cache.clear(); });
  }
  private async own(conversation: ConversationSummary): Promise<UsageIndex> {
    const id = conversation.id;
    const records = [{ namespace: 'conversation-usage', id }, { namespace: 'conversation-branches', id, projection: { fields: ['graph'], omitBinary: true } }];
    const revisions = await this.app.storage.recordRevisions(records);
    const signature = JSON.stringify([conversation.revision, ...revisions]);
    const previous = this.cache.get(id);
    if (previous?.signature === signature) { this.cache.delete(id); this.cache.set(id, previous); return previous.value; }
    const state = await this.app.storage.readUsageState(id, records);
    const index = buildConversationUsageIndex(id, state.messages as Content[]);
    const imported = state.records.find(item => item.namespace === 'conversation-usage')!.record;
    const branches = state.records.find(item => item.namespace === 'conversation-branches')!.record;
    index.messages.push(...importedSubagentUsage(imported.value, id));
    if (branches.value) {
      const graph = (branches.value as { graph?: ConversationBranchGraph }).graph;
      if (!graph || typeof graph.nodes !== 'object' || !graph.nodes) throw new Error(`分支用量数据无法读取：${id}`);
      index.messages.push(...extractBranchUsageMessages(graph, new Set(state.messages.flatMap(message => message.id ? [message.id] : []))));
    }
    this.cache.set(id, { signature: JSON.stringify([state.revision, imported.revision, branches.revision]), value: index });
    while (this.cache.size > 128) this.cache.delete(this.cache.keys().next().value!);
    return index;
  }
  stats(actorId: string, options: UsageQuery): Promise<UsageResult> {
    this.app.requireOwner(actorId);
    const key = JSON.stringify([options.startTime ?? null, options.endTime ?? null]);
    const existing = this.pending.get(key); if (existing) return existing;
    const request = this.queue.catch(() => {}).then(() => this.collect(options));
    this.queue = request; this.pending.set(key, request);
    void request.finally(() => this.pending.delete(key)).catch(() => {});
    return request;
  }
  private async collect(options: UsageQuery): Promise<UsageResult> {
    const summaries = new Map<string, ConversationSummary>();
    const metadata = new Map<string, PlatformConversation>();
    let cursor: { updatedAt: number; id: string } | undefined;
    do {
      const page = await this.app.storage.listConversations({ limit: 1000, cursor });
      // 存储队列最多容纳 64 个请求，分批读取并为聊天和后台任务保留容量。
      for (let offset = 0; offset < page.items.length; offset += 16) {
        await Promise.all(page.items.slice(offset, offset + 16).map(async item => {
          const value = await this.app.storage.getConversation(item.id);
          if (value) { summaries.set(item.id, item); metadata.set(item.id, value); }
        }));
      }
      cursor = page.nextCursor;
    } while (cursor);
    const parent = new Map<string, string>();
    for (const [id, value] of metadata) if ((value.custom as Record<string, unknown> | undefined)?.platformSubagentId &&
      typeof value.parentConversationId === 'string' && metadata.has(value.parentConversationId)) parent.set(id, value.parentConversationId);
    const groups = new Map<string, string[]>();
    for (const id of summaries.keys()) {
      let root = id; const visited = new Set<string>();
      while (parent.has(root)) {
        if (visited.has(root)) { root = id; break; }
        visited.add(root); root = parent.get(root)!;
      }
      groups.set(root, [...(groups.get(root) ?? []), id]);
    }
    const errors: Record<string, string> = {};
    const loaded = new Map<string, Promise<UsageIndex>>();
    const read = (id: string) => {
      let pending = loaded.get(id);
      if (!pending) { pending = this.own(summaries.get(id)!); loaded.set(id, pending); }
      return pending;
    };
    const result = await aggregateUsageStats({
      listConversations: async () => [...groups.keys()],
      getMetadata: async id => metadata.get(id) as ConversationMetadata,
      getMetadataLight: async id => metadata.get(id) as ConversationMetadata,
      getMessages: async id => (await this.app.storage.readUsageState(id)).messages as Content[],
      getUsageIndex: async id => {
        try {
          const own = await read(id); const messages = [...own.messages];
          for (const child of groups.get(id) ?? []) if (child !== id) {
            // 新版子代理只归入最上层主会话一次；不再另计为一个普通会话。
            for (const item of (await read(child)).messages) messages.push({ ...item, source: 'subagent',
              ...(item.id ? { id: `${child}:${item.id}` } : {}) });
          }
          return { ...own, messages };
        } catch (error) { errors[id] = String(error); throw error; }
      },
    }, options);
    return { ...result, readErrors: errors };
  }
}
