import type { RuntimeTool } from '@graycode/core';
import type { LongMemoryRecord, ToolOutcome } from '@graycode/contracts';
import type { PlatformLongMemory } from './service';
import { recordRef } from './content';

const scopeId = { type: 'string', description: '工具返回过的授权 scopeId。' };
const topic = {
  type: 'array',
  items: { type: 'string', maxLength: 120 },
  maxItems: 8,
  description: '从宽到窄的主题路径。',
};
const kinds = { type: 'string', enum: ['fact', 'preference', 'experience', 'project', 'procedure', 'event', 'summary'] };
const time = { type: 'number', description: 'UTC Unix 毫秒时间戳；没有明确的时间依据时省略。' };
const schema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const query = {
  scopeId,
  topic,
  text: { type: 'string', maxLength: 32000 },
  asOf: { ...time, description: '事实有效时间，UTC Unix 毫秒。' },
  knownAt: { ...time, description: '当时已知信息的截止时间，UTC Unix 毫秒。' },
  limit: { type: 'integer', minimum: 1, maximum: 50 },
  tokenBudget: { type: 'integer', minimum: 256, maximum: 16000 },
  confirmedOnly: { type: 'boolean' },
};
const fields = {
  scopeId,
  text: { type: 'string', minLength: 1, maxLength: 32000 },
  kind: { ...kinds, enum: kinds.enum.filter((kind) => kind !== 'summary') },
  subject: { type: 'string', maxLength: 512 },
  attribute: { type: 'string', maxLength: 256 },
  value: { type: 'string', maxLength: 4000 },
  topic,
  entities: { type: 'array', items: { type: 'string' }, maxItems: 64 },
  validFrom: { ...time, description: '事实生效时间，UTC Unix 毫秒；无依据时省略。' },
  validTo: time,
  eventAt: { ...time, description: '事件发生时间，UTC Unix 毫秒；无依据时省略。' },
  confidence: { type: 'string', enum: ['confirmed', 'inferred', 'disputed'] },
  sourceMessageId: {
    type: 'string',
    description: '本会话原消息 ID，默认本轮用户输入；last_assistant 引用本轮已保存的模型文字，须提供逐字 quote。',
  },
  quote: { type: 'string', maxLength: 32000, description: '原消息中相关片段的逐字摘录。' },
  supersedes: { type: 'array', items: { type: 'string' }, maxItems: 128 },
};
const compact = (records: LongMemoryRecord[]): ToolOutcome => ({
  success: true,
  data: { records: records.map(({ id, version, scopeId, kind, topic }) => ({ id, version, scopeId, kind, topic })) },
  memoryReferences: records.map(recordRef),
});

export function longMemoryTools(service: PlatformLongMemory): RuntimeTool[] {
  return [
    {
      declaration: {
        name: 'memory_topics',
        description:
          '浏览个人长期记忆的授权范围、主题和摘要。按需逐层深入；nextCursor 用作 cursor 续读当前层。',
        parameters: schema({
          scopeId,
          topic,
          limit: query.limit,
          tokenBudget: query.tokenBudget,
          cursor: { type: 'string', maxLength: 512, description: '上一页返回的 nextCursor；使用时保持原来的主题和范围。' },
        }),
      },
      effects: () => ['workspace_read'],
      execute: async (args, context) => {
        const access = await service.access(context.actorId, context);
        const request = await service.query(access, { ...args, confirmedOnly: false });
        const result = await service.app.storage.longMemoryTopics({ ...request, cursor: args.cursor as string | undefined });
        return {
          success: true,
          data: { ...(!args.cursor ? { scopes: access.scopes } : {}), ...result },
          memoryScopeVersions: await Promise.all(
            request.scopes.map(async (scope) => ({
              scopeId: scope.id,
              invalidation: (await service.app.storage.longMemoryState(scope)).invalidation,
            })),
          ),
          memoryReferences: result.topics.flatMap((item) =>
            item.summaries.map((summary) => ({ scopeId: item.scopeId, id: summary.id, version: summary.version })),
          ),
        };
      },
    },
    {
      declaration: {
        name: 'memory_search',
        description:
          '搜索个人长期记忆，支持主题、类别和时间筛选；结合关键词与语义匹配，结果受 tokenBudget 限制。',
        parameters: schema({ ...query, kinds: { type: 'array', items: kinds } }, ['text']),
      },
      effects: () => ['workspace_read'],
      execute: async (args, context) => {
        const access = await service.access(context.actorId, context),
          result = await service.search(access, args, context.signal);
        return { success: true, data: result, memoryReferences: result.hits.map((hit) => recordRef(hit.record)) };
      },
    },
    {
      declaration: {
        name: 'memory_read',
        description:
          '按 ids 读取个人长期记忆，includeSources 附带来源。长文用 page 分段，sourceId 指定来源；' +
          'nextOffset 用作 offset 续读同一 version。omitted 或 requiredTokenBudget 表示预算不足。',
        parameters: {
          ...schema(
            {
              ...query,
              ids: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 50 },
              includeSources: { type: 'boolean' },
              page: schema(
                {
                  id: { type: 'string' },
                  version: { type: 'integer', minimum: 1 },
                  sourceId: { type: 'string' },
                  offset: { type: 'integer', minimum: 0 },
                },
                ['id', 'version'],
              ),
            },
            ['scopeId'],
          ),
          oneOf: [{ required: ['ids'] }, { required: ['page'] }],
        },
      },
      effects: () => ['workspace_read'],
      execute: async (args, context) => {
        const access = await service.access(context.actorId, context),
          request = await service.query(access, { ...args, confirmedOnly: false });
        const page = args.page as { id: string; version: number; sourceId?: string; offset?: number } | undefined;
        const result = await service.app.storage.longMemoryRead({
          query: request,
          references: ((args.ids ?? []) as string[]).map((id) => ({ scopeId: String(args.scopeId), id })),
          includeSources: args.includeSources === true,
          ...(page
            ? {
                page: {
                  record: { scopeId: String(args.scopeId), id: page.id, version: page.version },
                  sourceId: page.sourceId,
                  offset: page.offset,
                },
              }
            : {}),
        });
        return {
          success: true,
          data: result,
          memoryReferences: [...result.records.map(recordRef), ...(result.page ? [recordRef(result.page.record)] : [])],
        };
      },
    },
    {
      declaration: {
        name: 'memory_remember',
        description:
          '按用户明确要求保存个人长期记忆，引用真实消息；模型推断保持未确认，角色剧情使用独立范围。修改已有记录用 memory_revise。',
        parameters: schema(fields, ['scopeId', 'text', 'kind', 'topic']),
      },
      effects: () => ['workspace_write'],
      execute: async (args, context) => {
        const result = await service.remember(await service.access(context.actorId, context), args as any, context);
        return compact(result.records);
      },
    },
    {
      declaration: {
        name: 'memory_revise',
        description:
          '修订已读取的个人长期记忆，expectedVersion 使用当前版本。text、oldText/newText、append 三选一；' +
          '来源要求同 memory_remember，保留历史并使旧摘要失效。attribute、value、validTo、eventAt 可用 null 清除。',
        parameters: {
          ...schema(
            {
              ...fields,
              kind: kinds,
              oldText: { type: 'string', minLength: 1, maxLength: 32000, description: '原文中只出现一次的连续片段。' },
              newText: { type: 'string', maxLength: 32000, description: '替换后的文字，空字符串表示删除该片段。' },
              append: { type: 'string', minLength: 1, maxLength: 32000, description: '追加到末尾的文字，需要换行时自行包含换行符。' },
              attribute: { anyOf: [fields.attribute, { type: 'null' }] },
              value: { anyOf: [fields.value, { type: 'null' }] },
              validTo: { anyOf: [time, { type: 'null' }] },
              eventAt: { anyOf: [fields.eventAt, { type: 'null' }] },
              id: { type: 'string' },
              expectedVersion: { type: 'integer', minimum: 1 },
            },
            ['scopeId', 'id', 'expectedVersion'],
          ),
          anyOf: [{ required: ['text'] }, { required: ['oldText', 'newText'] }, { required: ['append'] }],
        },
      },
      effects: () => ['workspace_write'],
      execute: async (args, context) => {
        const result = await service.revise(await service.access(context.actorId, context), args as any, context);
        return compact(result.records);
      },
    },
    {
      declaration: {
        name: 'memory_remove',
        description:
          '按用户明确要求删除或撤回个人长期记忆。先 preview 影响，再 apply 并传当前 expectedVersion。' +
          'delete 包含被取代的旧事实；retract 撤回错误说法。删除来源及派生内容后，原对话仍供用户查看，模型上下文排除相关内容。',
        parameters: schema(
          {
            scopeId,
            id: { type: 'string' },
            expectedVersion: { type: 'integer', minimum: 1 },
            action: { type: 'string', enum: ['delete', 'retract'] },
            operation: { type: 'string', enum: ['preview', 'apply'] },
          },
          ['scopeId', 'id', 'action', 'operation'],
        ),
      },
      effects: (args) => (args.operation === 'preview' ? ['workspace_read'] : ['workspace_write']),
      execute: async (args, context) => {
        const access = await service.access(context.actorId, context),
          scope = service.select(access, String(args.scopeId))[0];
        if (args.operation === 'preview') {
          const affected = await service.app.storage.longMemoryImpact({
            scope,
            kind: 'record',
            id: String(args.id),
            action: args.action as 'delete' | 'retract',
          });
          return {
            success: true,
            data: {
              affected: affected.slice(0, 30),
              total: affected.length,
              recordCount: affected.filter((item) => item.kind === 'record').length,
              truncated: affected.length > 30,
            },
          };
        }
        if (!Number.isSafeInteger(args.expectedVersion)) throw new Error('删除需要提供已读取的 expectedVersion。');
        const result = await service.remove(access, args as any);
        return { success: true, data: { removed: result.removed, revision: result.state.revision } };
      },
    },
    {
      declaration: {
        name: 'memory_summarize',
        description:
          '按需汇总已读取的个人长期记忆。recordIds 引用同一范围内的事实或下层摘要；保留原记录，来源修订或删除后摘要失效。',
        parameters: schema(
          {
            scopeId,
            topic,
            text: { type: 'string', minLength: 1, maxLength: 16000 },
            recordIds: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 100 },
            id: { type: 'string' },
            expectedVersion: { type: 'integer', minimum: 0 },
          },
          ['scopeId', 'topic', 'text', 'recordIds'],
        ),
      },
      effects: () => ['workspace_write'],
      execute: async (args, context) => {
        const result = await service.summarize(await service.access(context.actorId, context), args as any);
        return compact(result.records);
      },
    },
  ];
}
