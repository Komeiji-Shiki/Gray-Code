import type { RuntimeTool } from '@graycode/core';
import type { ToolContext as LegacyToolContext } from '../../../../backend/tools/types';
import { createTodoWriteTool } from '../../../../backend/tools/todo/todo_write';
import { createTodoUpdateTool } from '../../../../backend/tools/todo/todo_update';
import { createHistorySearchTool } from '../../../../backend/tools/history/history_search';
import { createActivityStatsTool } from '../../../../backend/tools/activity/activityRuntime';
import { DEFAULT_HISTORY_SEARCH_CONFIG, type HistorySearchToolConfig } from '../../../../backend/modules/settings/types';
import type { PlatformApplication } from '../application';

/** 原对话工具操作已捕获的任务状态，成功后一次提交元数据。 */
export function conversationTools(app: PlatformApplication, historyConfig: HistorySearchToolConfig = DEFAULT_HISTORY_SEARCH_CONFIG): RuntimeTool[] {
  const tools = [createTodoWriteTool(), createTodoUpdateTool(), createHistorySearchTool(() => historyConfig),
    createActivityStatsTool(async (query, context) => {
      if (typeof context?.actorId !== 'string') throw new Error('活动查询缺少账号身份。');
      return app.activity.stats(context.actorId, query);
    })];
  return tools.map(tool => ({
    declaration: { name: tool.declaration.name, description: tool.declaration.description, parameters: tool.declaration.parameters },
    // 只访问所属任务，不读写工作区或其他账号的对话。
    effects: () => [],
    execute: async (args, context) => {
      if (!context.conversationId) throw new Error('工具缺少对话身份。');
      const id = context.conversationId;
      await app.conversation(context.actorId, id);
      const run = await app.storage.getRun(context.runId);
      if (run?.conversationId !== id || run.actorId !== context.actorId) throw new Error('工具调用不属于当前对话。');
      const state = await app.storage.readConversationState(id);
      let changed = false;
      const requireId = (requested: string) => { if (requested !== id) throw new Error('不能访问其他对话。'); context.signal.throwIfAborted(); };
      const conversationStore: NonNullable<LegacyToolContext['conversationStore']> = {
        getHistory: async requested => { requireId(requested); return structuredClone(state.history.messages); },
        getCustomMetadata: async (requested, key) => { requireId(requested); return structuredClone((state.metadata.custom as Record<string, unknown> | undefined)?.[key]); },
        setCustomMetadata: async (requested, key, value) => {
          requireId(requested);
          state.metadata.custom = { ...state.metadata.custom as Record<string, unknown>, [key]: structuredClone(value) };
          changed = true;
        },
      };
      const { multimodal, ...result } = await tool.handler(args, { conversationId: id, toolId: context.toolCallId,
        abortSignal: context.signal, conversationStore, actorId: context.actorId });
      context.signal.throwIfAborted();
      if (changed && result.success) {
        await app.storage.commitConversation({ conversationId: id, expectedRevision: state.history.revision,
          expectedMetadataToken: state.metadataToken, activeRunId: context.runId, metadata: state.metadata });
        app.productUi.conversations.clearMetadataCache();
        app.publish({ type: 'conversation.changed', conversationId: id });
      }
      return { ...result, attachments: multimodal };
    },
  }));
}
