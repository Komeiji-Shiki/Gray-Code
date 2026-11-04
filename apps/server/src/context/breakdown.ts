import type { ModelInput, PlatformMessage, ToolDeclaration } from '@graycode/contracts';
import type { ChannelConfig } from '../../../../backend/modules/config/types';
import type { ContentPart } from '../../../../backend/modules/conversation/types';
import { deserializePromptContextCache } from '../../../../backend/modules/prompt/promptContextCache';
import { resolveContextManagementPolicy } from '../../../../backend/modules/api/chat/services/contextTrim/policy';
import { countJsonTokens, countTextTokens } from '../../../../packages/core/src/tokenizer';
import { decodeMcpToolName } from '../../../../shared/mcpToolNameCodec';
import type { PlatformApplication } from '../application';
import { MEMORY_INDEX_HEADER } from '../memory/files';
import { prepareRequestPreview } from '../prompt/preview';
import type { ProductSettingsDraft } from '../settings/product';
import type { ClientSession } from '../transport/router';
import { createContextBudget } from './budget';

export interface ContextBreakdownItem {
  id: string;
  tokens: number;
  /** 工具名和提示词段落标题按原文显示；缺省时由界面按 id 翻译。 */
  label?: string;
  detail?: string;
}
export interface ContextBreakdownCategory {
  id: 'messages' | 'systemTools' | 'mcpTools' | 'memory' | 'systemPrompt' | 'dynamicContext' | 'systemToolsDeferred' | 'mcpToolsDeferred';
  tokens: number;
  items: ContextBreakdownItem[];
}

type Label = Pick<ContextBreakdownItem, 'label' | 'detail'>;

function createCategory(id: ContextBreakdownCategory['id']) {
  const items = new Map<string, ContextBreakdownItem>();
  const category = {
    tokens: 0,
    add(itemId: string, tokens: number, label?: Label) {
      const item = items.get(itemId);
      if (item) item.tokens += tokens;
      else items.set(itemId, { id: itemId, tokens, ...label });
    },
    finish: (): ContextBreakdownCategory => ({ id, tokens: category.tokens,
      items: [...items.values()].filter(item => item.tokens > 0).sort((left, right) => right.tokens - left.tokens) }),
  };
  return category;
}

const SECTION_HEADER = /(?:^|\n)====\n\n([^\n]+)\n\n/g;

/** wrapPromptSection 的标题是提示词里唯一的结构边界；标题之前的正文归入无标题的一段。 */
export function splitPromptSections(text: string): { title?: string; text: string }[] {
  const sections: { title?: string; text: string }[] = [];
  let start = 0;
  let title: string | undefined;
  for (const match of text.matchAll(SECTION_HEADER)) {
    sections.push({ title, text: text.slice(start, match.index) });
    start = match.index;
    title = match[1];
  }
  sections.push({ title, text: text.slice(start) });
  return sections.filter(section => section.text.trim());
}

/** 只认范围标题，MEMORY.md 正文里的三级标题不算边界；文件头归入第一个范围，合计才与注入的正文一致。 */
function splitMemoryIndex(text: string): { root: string; text: string }[] {
  const [header, first, ...rest] = text.split(/\n(?=### (?:global|project|channel|story)\n)/);
  return [`${header}\n${first}`, ...rest].map(part => ({ root: /^### (.+)$/m.exec(part)![1], text: part }));
}

function isMemoryIndex(message: PlatformMessage): boolean {
  const text = (message.parts as ContentPart[])[0]?.text;
  return typeof text === 'string' && text.startsWith(MEMORY_INDEX_HEADER);
}

/**
 * 按来源分账本次请求。计数器和自动总结判定同源，因此剩余空间就是触发总结前还能写入的内容。
 *
 * 格式器还会把历史回合保存的动态快照插回原位，这些内容进入真实请求但不在消息正文里，这里单独计入。
 */
export function measureContextInput(input: ModelInput, config: ChannelConfig, options: {
  absoluteLimit?: number;
  serverNames?: ReadonlyMap<string, string>;
  deferred?: ReadonlyMap<string, ToolDeclaration>;
} = {}) {
  const counter = createContextBudget(input, config, options.absoluteLimit);
  const { estimateMessage, tokenizerOptions: tokenizer } = counter;

  const messages = createCategory('messages');
  for (const message of input.messages) {
    messages.tokens += estimateMessage(message);
    for (const part of message.parts as ContentPart[]) {
      const tokens = estimateMessage({ role: message.role, parts: [part] } as PlatformMessage);
      const toolName = part.functionResponse?.name;
      if (message.isSummary) messages.add('summary', tokens);
      else if (toolName) messages.add(`tool:${toolName}`, tokens, { label: toolName });
      else if (part.functionCall) messages.add('toolCalls', tokens);
      else if (part.thought) messages.add('thinking', tokens);
      else messages.add(message.role === 'model' ? 'assistant' : 'user', tokens);
    }
  }

  const systemTools = createCategory('systemTools');
  const mcpTools = createCategory('mcpTools');
  const systemToolsDeferred = createCategory('systemToolsDeferred');
  const mcpToolsDeferred = createCategory('mcpToolsDeferred');
  for (const tool of input.tools) {
    const tokens = countJsonTokens(tool, tokenizer);
    const decoded = decodeMcpToolName(tool.name);
    const category = decoded ? mcpTools : systemTools;
    const label = decoded
      ? { label: decoded.toolName, detail: options.serverNames?.get(decoded.serverId) ?? decoded.serverId }
      : { label: tool.name };
    const definition = options.deferred?.get(tool.name);
    category.tokens += tokens;
    if (definition) {
      category.add('stubs', tokens);
      const unsent = decoded ? mcpToolsDeferred : systemToolsDeferred;
      const size = countJsonTokens(definition, tokenizer);
      unsent.tokens += size;
      unsent.add(tool.name, size, label);
    } else category.add(tool.name, tokens, label);
  }

  const memory = createCategory('memory');
  const systemPrompt = createCategory('systemPrompt');
  for (const section of splitPromptSections(input.systemPrompt)) {
    const tokens = countTextTokens(section.text, tokenizer);
    if (section.title === 'MEMORY') {
      memory.tokens += tokens;
      memory.add('guidance', tokens);
    } else {
      systemPrompt.tokens += tokens;
      if (section.title) systemPrompt.add(`section:${section.title}`, tokens, { label: section.title });
      else systemPrompt.add('base', tokens);
    }
  }

  const dynamicContext = createCategory('dynamicContext');
  const context = [...input.promptContext?.beforeHistoryMessages ?? [], ...input.promptContext?.afterHistoryMessages ?? []];
  for (const message of context) {
    const tokens = estimateMessage(message);
    if (isMemoryIndex(message)) {
      memory.tokens += tokens;
      for (const { root, text } of splitMemoryIndex((message.parts as ContentPart[])[0].text!)) {
        memory.add(`index:${root}`, countTextTokens(text, tokenizer), { label: 'MEMORY.md', detail: root });
      }
      continue;
    }
    dynamicContext.tokens += tokens;
    for (const part of message.parts as ContentPart[]) {
      if (typeof part.text !== 'string' || part.thought) {
        dynamicContext.add('other', estimateMessage({ role: message.role, parts: [part] } as PlatformMessage));
        continue;
      }
      for (const section of splitPromptSections(part.text)) {
        const sectionTokens = countTextTokens(section.text, tokenizer);
        if (section.title) dynamicContext.add(`section:${section.title}`, sectionTokens, { label: section.title });
        else dynamicContext.add('other', sectionTokens);
      }
    }
  }
  const currentTurn = input.messages.findLastIndex(message => message.isUserInput);
  input.messages.forEach((message, index) => {
    if (index === currentTurn || !message.isUserInput || typeof message.turnDynamicContext !== 'string') return;
    for (const snapshot of deserializePromptContextCache(message.turnDynamicContext).dynamicSnapshotMessages) {
      const tokens = estimateMessage(snapshot as PlatformMessage);
      dynamicContext.tokens += tokens;
      dynamicContext.add('snapshots', tokens);
    }
  });

  const categories = [messages, systemTools, memory, systemPrompt, mcpTools, dynamicContext].map(category => category.finish());
  const totalTokens = categories.reduce((total, category) => total + category.tokens, 0);
  const { maxContextTokens, maxInputTokens } = counter.resolution;
  const managementEnabled = resolveContextManagementPolicy(config).enabled;
  // 关闭上下文管理时不会自动总结，软阈值以上的空间仍然可用。
  const softLimitTokens = managementEnabled ? counter.softLimitTokens : maxInputTokens;
  return {
    categories, totalTokens, maxContextTokens, maxInputTokens, softLimitTokens, managementEnabled,
    // 按需工具的完整定义没有发送，只用于说明省下了多少，不计入已用。
    deferredCategories: [systemToolsDeferred, mcpToolsDeferred].map(category => category.finish()).filter(category => category.tokens > 0),
    tokenizer: counter.tokenizer.encoding,
    reservedOutputTokens: Math.max(0, maxContextTokens - maxInputTokens),
    autoCompactBufferTokens: Math.max(0, maxInputTokens - Math.max(totalTokens, softLimitTokens)),
    freeTokens: Math.max(0, softLimitTokens - totalTokens),
  };
}

/** 只读：走正式请求的同一条组装流水线，不创建对话、不写历史，也不调用供应商计数接口。 */
export async function describeContextBreakdown(app: PlatformApplication, client: ClientSession, data: Record<string, any>,
  preferences: ProductSettingsDraft, workspaceId?: string, mode?: 'chat' | 'code' | 'character') {
  const prepared = await prepareRequestPreview(app, client, { ...data, message: '', attachments: [] }, preferences, workspaceId, mode);
  const config = await app.product.channel(prepared.input.providerId, { includeCredential: false });
  if (!config) throw new Error('当前模型渠道不可用，无法统计上下文。');
  return {
    ...measureContextInput(prepared.input, config, {
      absoluteLimit: app.product.runtimeSettings().getSummarizeConfig().autoSummarizeTokenLimit,
      serverNames: app.mcp.serverNames(),
      deferred: prepared.deferredTools,
    }),
    model: prepared.input.modelOverride ?? config.model,
    notices: prepared.notices,
    measuredAt: Date.now(),
  };
}
