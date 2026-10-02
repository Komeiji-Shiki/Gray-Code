import type { UsageConversation } from '@graycode/core';
import { aggregateUsageStats, buildConversationUsageIndex, extractBranchUsageMessages,
  type UsageIndex, type UsageIndexMessage } from '../../../../backend/modules/conversation/usageStats';
import type { Content, ConversationMetadata } from '../../../../backend/modules/conversation/types';
import type { ConversationBranchGraph } from '../../../../backend/modules/conversation/branch/types';
import type { PlatformApplication } from '../application';

/** 每条主历史 model 消息一项（无用量时 entry 为 null），条数与存储返回的 keep 对齐，用于截断共享前缀之后的部分。 */
interface UsageRow { entry: UsageIndexMessage | null; id?: string }
interface CachedUsage {
  signature: string; value: UsageIndex; token: string; main: UsageRow[];
  imported: { revision: number | null; entries: UsageIndexMessage[] };
  // 只保留分支图提取出的用量条目，不持有整张图；all 供主历史 ID 去重，inactive 是主历史无 ID 时的活跃路径兜底结果。
  branches: { revision: number | null; all: UsageIndexMessage[]; inactive: UsageIndexMessage[] };
}
/** extractBranchUsageMessages 只用 size 和 has：非空且不含任何 ID，得到全部可计的候选，再按当前主历史 ID 筛选。 */
const NO_HISTORY_IDS = { size: 1, has: () => false } as unknown as ReadonlySet<string>;
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
  private async own(conversation: UsageConversation): Promise<UsageIndex> {
    const id = conversation.id;
    const signature = JSON.stringify([conversation.historyId, conversation.revision, conversation.usageRevision, conversation.branchesRevision]);
    const previous = this.cache.get(id);
    if (previous?.signature === signature) return previous.value;
    // 只重读版本变化的附属记录；历史只取共享前缀之后的 model 消息，前缀改写时存储返回较小的 keep。
    const records = [
      ...(!previous || previous.imported.revision !== conversation.usageRevision ? [{ namespace: 'conversation-usage', id }] : []),
      ...(!previous || previous.branches.revision !== conversation.branchesRevision
        ? [{ namespace: 'conversation-branches', id, projection: { fields: ['graph'], omitBinary: true } }] : []),
    ];
    let state = await this.app.storage.readUsageState(id, records, previous?.token);
    // 缓存与令牌不一致时不猜测对应关系，重新全量读取。
    if (state.keep > (previous?.main.length ?? 0)) state = await this.app.storage.readUsageState(id, records);
    const rows = (state.messages as Content[]).map(message => ({ entry: buildConversationUsageIndex(id, [message]).messages[0] ?? null,
      ...(message.id ? { id: message.id } : {}) }));
    const main = state.keep ? [...previous!.main.slice(0, state.keep), ...rows] : rows;
    const read = (namespace: string) => state.records.find(item => item.namespace === namespace)?.record;
    const usageRecord = read('conversation-usage'), branchRecord = read('conversation-branches');
    const imported = usageRecord ? { revision: usageRecord.revision, entries: importedSubagentUsage(usageRecord.value, id) } : previous!.imported;
    let branches = previous?.branches;
    if (branchRecord) {
      branches = { revision: branchRecord.revision, all: [], inactive: [] };
      if (branchRecord.value) {
        const graph = (branchRecord.value as { graph?: ConversationBranchGraph }).graph;
        if (!graph || typeof graph.nodes !== 'object' || !graph.nodes) throw new Error(`分支用量数据无法读取：${id}`);
        branches.all = extractBranchUsageMessages(graph, NO_HISTORY_IDS);
        branches.inactive = extractBranchUsageMessages(graph, new Set());
      }
    }
    const historyIds = new Set(main.flatMap(row => row.id ? [row.id] : []));
    const branchEntries = historyIds.size ? branches!.all.filter(item => !(item.id && historyIds.has(item.id))) : branches!.inactive;
    const index: UsageIndex = { version: 1, conversationId: id, updatedAt: Date.now(),
      messages: [...main.flatMap(row => row.entry ? [row.entry] : []), ...imported.entries, ...branchEntries] };
    this.cache.set(id, { signature: JSON.stringify([conversation.historyId, state.revision, imported.revision, branches!.revision]),
      value: index, token: state.token, main, imported, branches: branches! });
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
    const summaries = new Map<string, UsageConversation>();
    let cursor: { updatedAt: number; id: string } | undefined;
    do {
      const page = await this.app.storage.listUsageConversations({ limit: 100, cursor });
      for (const item of page.items) summaries.set(item.id, item);
      cursor = page.nextCursor;
    } while (cursor);
    // 一轮统计需要所有会话的精简用量；固定条数的 LRU 会在大存档中反复淘汰下一轮所需数据。
    for (const id of this.cache.keys()) if (!summaries.has(id)) this.cache.delete(id);
    const parent = new Map<string, string>();
    for (const [id, value] of summaries) if (value.isSubagent &&
      typeof value.parentConversationId === 'string' && summaries.has(value.parentConversationId)) parent.set(id, value.parentConversationId);
    const groups = new Map<string, string[]>();
    for (const id of summaries.keys()) {
      let root = id; const visited = new Set<string>();
      while (parent.has(root)) {
        if (visited.has(root)) { root = id; break; }
        visited.add(root); root = parent.get(root)!;
      }
      const group = groups.get(root);
      if (group) group.push(id); else groups.set(root, [id]);
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
      getMetadata: async id => summaries.get(id) as ConversationMetadata,
      getMetadataLight: async id => summaries.get(id) as ConversationMetadata,
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
