import type { RuntimeTool } from '@graycode/core';
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
export function longMemoryTools(service: PlatformLongMemory): RuntimeTool[] {
  return [
    {
      declaration: {
        name: 'memory_topics',
        description:
          '浏览已启用资料库的授权范围、主题和摘要。按需逐层深入；nextCursor 用作 cursor 续读当前层。',
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
          '搜索已启用资料库，支持主题、类别和时间筛选；结合关键词与语义匹配，结果受 tokenBudget 限制。',
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
          '按 ids 读取已启用资料库，includeSources 附带来源。长文用 page 分段，sourceId 指定来源；' +
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
  ];
}
