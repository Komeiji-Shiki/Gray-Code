import { TOOL_SEARCH_NAME, type RuntimeTool, type ToolContext, type ToolLoadingHints } from '@graycode/core';
import type { ToolDeclaration } from '@graycode/contracts';
import type { ToolLoadingMode } from '../../../../backend/modules/settings/types';
import type { SettingsManager } from '../../../../backend/modules/settings/SettingsManager';
import { getActualLanguage } from '../../../../backend/i18n';
import { resolveLocalizationLanguage } from '../../../../backend/tools/localization/types';

/** 低频且定义较大的内置工具。文档类工具已由模式决定是否发送，核心读写和命令工具每轮都可能用到，都保持常驻。 */
const DEFERRED_BY_DEFAULT: ReadonlySet<string> = new Set([
  'office_read', 'office_create', 'office_edit',
  'generate_image', 'remove_background', 'crop_image', 'resize_image', 'rotate_image',
  'get_symbols', 'find_references', 'goto_definition',
  'history_search', 'memory_read', 'memory_search', 'memory_topics',
  'team_tasks', 'team_wait', 'subagent_requests', 'agent_send_message',
  'get_activity_stats', 'show_windows_notification',
]);

export function defaultToolLoading(name: string): ToolLoadingMode {
  return name.startsWith('mcp__') || name.startsWith('browser_') || name.startsWith('computer_') || DEFERRED_BY_DEFAULT.has(name)
    ? 'deferred' : 'resident';
}

/**
 * 工具搜索不进 Agent 清单：有按需工具时才追加，子代理继承的清单也在这里统一去重。
 * 严格工具要求参数表封闭，占位的宽松参数表无法转换，开启严格工具的渠道发送完整定义。
 * 提示词给出的固定按需工具不看工具页设置；渠道不能按需时锁定工具不发送，解锁后才随完整定义出现。
 */
export function resolveToolLoading(preferences: Pick<SettingsManager, 'getToolLoading' | 'isToolEnabled'>, names: readonly string[],
  channel?: { toolDeferredLoading?: boolean; strictToolsEnabled?: boolean } | null, hints?: ToolLoadingHints)
  : { names: string[]; deferred?: ReadonlySet<string>; locked?: ReadonlyMap<string, string> } {
  const selected = names.filter(name => name !== TOOL_SEARCH_NAME);
  const locked = new Map(Object.entries(hints?.locked ?? {}).filter(([name]) => selected.includes(name)));
  if (channel?.toolDeferredLoading === false || channel?.strictToolsEnabled === true || !preferences.isToolEnabled(TOOL_SEARCH_NAME)) {
    return { names: selected.filter(name => !locked.has(name)) };
  }
  const configured = preferences.getToolLoading();
  const fixed = new Set(hints?.deferred);
  const deferred = new Set(selected.filter(name => fixed.has(name) || locked.has(name) || (configured[name] ?? defaultToolLoading(name)) === 'deferred'));
  return deferred.size ? { names: [...selected, TOOL_SEARCH_NAME], deferred, ...(locked.size ? { locked } : {}) } : { names: selected };
}

const SELECT_PREFIX = 'select:';

/** 关键词命中名称比命中说明更可信；同分按名称排序，相同查询总是得到相同结果。 */
function rankByKeywords(tools: readonly ToolDeclaration[], query: string, limit: number): ToolDeclaration[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return tools.map(tool => {
    const name = tool.name.toLowerCase();
    const description = tool.description.toLowerCase();
    return { tool, score: terms.reduce((total, term) => total + (name.includes(term) ? 3 : description.includes(term) ? 1 : 0), 0) };
  }).filter(item => item.score > 0)
    .sort((left, right) => right.score - left.score || left.tool.name.localeCompare(right.tool.name))
    .slice(0, limit).map(item => item.tool);
}

/** 只返回模型调用需要的字段，声明上的展示元数据不进消息。 */
const definitionOf = ({ name, description, parameters }: ToolDeclaration) => ({ name, description, parameters });

export function searchDeferredTools(deferred: ReadonlyMap<string, ToolDeclaration> | undefined, query: string, limit = 5) {
  const available = deferred ?? new Map<string, ToolDeclaration>();
  if (!query.startsWith(SELECT_PREFIX)) return { tools: rankByKeywords([...available.values()], query, limit).map(definitionOf) };
  const names = query.slice(SELECT_PREFIX.length).split(',').map(name => name.trim()).filter(Boolean);
  const unavailable = names.filter(name => !available.has(name));
  return { tools: names.flatMap(name => available.get(name) ?? []).map(definitionOf), ...(unavailable.length ? { unavailable } : {}) };
}

const toolSearchText = {
  'zh-CN': {
    description: '加载按需工具的完整定义。标为按需的工具在加载前只有名称：先调用本工具，再按工具原名、用这里返回的参数调用它。'
      + '定义在本对话中持续有效；之前的结果已被总结掉时重新加载。',
    query: '精确加载用 "select:名称1,名称2"，否则按关键词匹配工具名称和说明。',
    maxResults: '关键词搜索最多返回的条数，默认 5。',
  },
  en: {
    description: 'Load the full definition of on-demand tools. Tools marked on-demand list only their name until loaded: '
      + 'call this first, then call the tool by its own name with the parameters returned here. '
      + 'Definitions stay valid for the rest of the conversation; load again if an earlier result was summarized away.',
    query: '"select:name1,name2" for exact names, otherwise keywords matched against names and descriptions.',
    maxResults: 'Keyword search result limit. Defaults to 5.',
  },
};

/** 定义作为工具结果追加进消息，请求的 tools 数组不变，加载工具不会打断前缀缓存。 */
export function toolSearchTool(): RuntimeTool {
  const text = toolSearchText[resolveLocalizationLanguage(getActualLanguage())];
  return {
    declaration: {
      name: TOOL_SEARCH_NAME,
      description: text.description,
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: text.query },
          max_results: { type: 'integer', minimum: 1, maximum: 20, description: text.maxResults },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
    parallelRead: true,
    nativeAsync: false,
    effects: () => [],
    execute: async (args: Readonly<Record<string, unknown>>, context: ToolContext) => ({
      success: true,
      data: searchDeferredTools(context.deferredTools, args.query as string, args.max_results as number | undefined),
    }),
  };
}
