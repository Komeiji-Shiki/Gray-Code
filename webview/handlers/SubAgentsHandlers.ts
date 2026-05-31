/**
 * SubAgents 子代理管理消息处理器
 */

import { t } from '../../backend/i18n';
import { subAgentRegistry, refreshSubAgentsTool, subAgentRunController, subAgentRunEventBus } from '../../backend/tools/subagents';
import { deleteLogicalMessage, truncateFrom } from '../../backend/modules/conversation/TranscriptMutation';
import type { SubAgentConfigItem } from '../../backend/modules/settings/types';
import type { HandlerContext, MessageHandler } from '../types';

const MUTATION_RESPONSE_WINDOW_LIMIT = 20;

function createRunMutationResponse(runId: string, anchorIndex?: number) {
  const manifest = subAgentRunEventBus.getManifest(runId);
  if (!manifest) return undefined;

  let contentWindow = typeof anchorIndex === 'number'
    ? subAgentRunEventBus.getContentWindow(runId, {
      startIndex: Math.max(0, Math.floor(anchorIndex) - Math.floor(MUTATION_RESPONSE_WINDOW_LIMIT / 2)),
      limit: MUTATION_RESPONSE_WINDOW_LIMIT,
      fromTail: false
    })
    : undefined;

  if (!contentWindow || contentWindow.contents.length === 0) {
    contentWindow = subAgentRunEventBus.getContentWindow(runId, { limit: MUTATION_RESPONSE_WINDOW_LIMIT, fromTail: true });
  }

  return { success: true, manifest, window: contentWindow };
}

/**
 * 获取所有子代理列表和全局配置
 */
export const listSubAgents: MessageHandler = async (data, requestId, ctx) => {
  try {
    // 从 SettingsManager 获取持久化的配置
    const config = ctx.settingsManager.getSubAgentsConfig();
    const agents = config.agents || [];
    const maxConcurrentAgents = config.maxConcurrentAgents ?? 3;
    const failureModeAfterRetries = config.failureModeAfterRetries || 'fail_parent_tool';
    
    ctx.sendResponse(requestId, { agents, maxConcurrentAgents, failureModeAfterRetries });
  } catch (error: any) {
    ctx.sendError(requestId, 'LIST_SUBAGENTS_ERROR', error.message || 'Failed to list subagents');
  }
};

/**
 * 获取单个子代理配置
 */
export const getSubAgent: MessageHandler = async (data, requestId, ctx) => {
  try {
    const { type } = data;
    const agent = ctx.settingsManager.getSubAgent(type);
    
    if (!agent) {
      ctx.sendError(requestId, 'SUBAGENT_NOT_FOUND', `SubAgent "${type}" not found`);
      return;
    }
    
    ctx.sendResponse(requestId, { agent });
  } catch (error: any) {
    ctx.sendError(requestId, 'GET_SUBAGENT_ERROR', error.message || 'Failed to get subagent');
  }
};

/**
 * 创建子代理
 */
export const createSubAgent: MessageHandler = async (data, requestId, ctx) => {
  try {
    const config: SubAgentConfigItem = {
      type: data.type,
      name: data.name,
      description: data.description || '',
      systemPrompt: data.systemPrompt || '',
      channel: data.channel || { channelId: '' },
      tools: data.tools || { mode: 'all' },
      maxIterations: data.maxIterations,
      maxRuntime: data.maxRuntime,
      failureModeAfterRetries: data.failureModeAfterRetries || 'fail_parent_tool',
      enabled: data.enabled !== false
    };
    
    // 检查类型 ID 是否已存在
    if (ctx.settingsManager.getSubAgent(config.type)) {
      ctx.sendError(requestId, 'SUBAGENT_EXISTS', `SubAgent "${config.type}" already exists`);
      return;
    }
    
    // 检查名称是否重复
    const existingAgents = ctx.settingsManager.getSubAgents();
    const nameExists = existingAgents.some(a => a.name.toLowerCase() === config.name.toLowerCase());
    if (nameExists) {
      ctx.sendError(requestId, 'SUBAGENT_NAME_EXISTS', `A sub-agent with name "${config.name}" already exists`);
      return;
    }
    
    // 保存到 SettingsManager
    await ctx.settingsManager.addSubAgent(config);
    
    // 注册到内存 registry
    subAgentRegistry.registerFromConfig(config);
    
    // 通知工具定义刷新
    refreshSubAgentsTool();
    
    ctx.sendResponse(requestId, { success: true, type: config.type });
  } catch (error: any) {
    ctx.sendError(requestId, 'CREATE_SUBAGENT_ERROR', error.message || 'Failed to create subagent');
  }
};

/**
 * 更新子代理配置
 */
export const updateSubAgent: MessageHandler = async (data, requestId, ctx) => {
  try {
    const { type, updates } = data;
    
    if (!ctx.settingsManager.getSubAgent(type)) {
      ctx.sendError(requestId, 'SUBAGENT_NOT_FOUND', `SubAgent "${type}" not found`);
      return;
    }
    
    // 如果更新名称，检查是否重复
    if (updates.name) {
      const existingAgents = ctx.settingsManager.getSubAgents();
      const nameExists = existingAgents.some(
        a => a.type !== type && a.name.toLowerCase() === updates.name.toLowerCase()
      );
      if (nameExists) {
        ctx.sendError(requestId, 'SUBAGENT_NAME_EXISTS', `A sub-agent with name "${updates.name}" already exists`);
        return;
      }
    }
    
    // 保存到 SettingsManager
    const success = await ctx.settingsManager.updateSubAgent(type, updates);
    
    if (!success) {
      ctx.sendError(requestId, 'UPDATE_SUBAGENT_FAILED', 'Failed to update subagent');
      return;
    }
    
    // 更新内存 registry
    subAgentRegistry.updateConfig(type, updates);
    
    // 通知工具定义刷新
    refreshSubAgentsTool();
    
    ctx.sendResponse(requestId, { success: true });
  } catch (error: any) {
    ctx.sendError(requestId, 'UPDATE_SUBAGENT_ERROR', error.message || 'Failed to update subagent');
  }
};

/**
 * 删除子代理
 */
export const deleteSubAgent: MessageHandler = async (data, requestId, ctx) => {
  try {
    const { type } = data;
    
    if (!ctx.settingsManager.getSubAgent(type)) {
      ctx.sendError(requestId, 'SUBAGENT_NOT_FOUND', `SubAgent "${type}" not found`);
      return;
    }
    
    // 从 SettingsManager 删除
    const success = await ctx.settingsManager.deleteSubAgent(type);
    
    if (!success) {
      ctx.sendError(requestId, 'DELETE_SUBAGENT_FAILED', 'Failed to delete subagent');
      return;
    }
    
    // 从内存 registry 删除
    subAgentRegistry.unregister(type);
    
    // 通知工具定义刷新
    refreshSubAgentsTool();
    
    ctx.sendResponse(requestId, { success: true });
  } catch (error: any) {
    ctx.sendError(requestId, 'DELETE_SUBAGENT_ERROR', error.message || 'Failed to delete subagent');
  }
};

/**
 * 设置子代理启用状态
 */
export const setSubAgentEnabled: MessageHandler = async (data, requestId, ctx) => {
  try {
    const { type, enabled } = data;
    
    if (!ctx.settingsManager.getSubAgent(type)) {
      ctx.sendError(requestId, 'SUBAGENT_NOT_FOUND', `SubAgent "${type}" not found`);
      return;
    }
    
    // 保存到 SettingsManager
    const success = await ctx.settingsManager.updateSubAgent(type, { enabled });
    
    if (!success) {
      ctx.sendError(requestId, 'SET_ENABLED_FAILED', 'Failed to set subagent enabled status');
      return;
    }
    
    // 更新内存 registry
    subAgentRegistry.setEnabled(type, enabled);
    
    // 启用状态变化会影响可用的子代理列表
    refreshSubAgentsTool();
    
    ctx.sendResponse(requestId, { success: true });
  } catch (error: any) {
    ctx.sendError(requestId, 'SET_SUBAGENT_ENABLED_ERROR', error.message || 'Failed to set subagent enabled status');
  }
};

export const openSubAgentMonitor: MessageHandler = async (data, requestId, ctx) => {
  try {
    const runId = typeof data?.runId === 'string' ? data.runId : undefined;
    const conversationId = typeof data?.conversationId === 'string' ? data.conversationId : undefined;

    if (!ctx.openSubAgentMonitor) {
      ctx.sendError(requestId, 'SUBAGENT_MONITOR_UNAVAILABLE', 'SubAgent Monitor is not available in this context');
      return;
    }

    if (conversationId) {
      await subAgentRunEventBus.loadConversationSnapshots(conversationId, ctx.conversationManager);
    }

    await ctx.openSubAgentMonitor(runId, conversationId);
    ctx.sendResponse(requestId, { success: true });
  } catch (error: any) {
    ctx.sendError(requestId, 'OPEN_SUBAGENT_MONITOR_ERROR', error.message || 'Failed to open SubAgent Monitor');
  }
};

export const pauseRun: MessageHandler = async (data, requestId, ctx) => {
  try {
    const runId = typeof data?.runId === 'string' ? data.runId.trim() : '';
    if (!runId) {
      ctx.sendError(requestId, 'SUBAGENT_PAUSE_RUN_INVALID_INPUT', 'runId is required');
      return;
    }

    const success = subAgentRunController.pause(runId);
    ctx.sendResponse(requestId, { success });
  } catch (error: any) {
    ctx.sendError(requestId, 'SUBAGENT_PAUSE_RUN_ERROR', error.message || 'Failed to pause SubAgent run');
  }
};

export const resumeRun: MessageHandler = async (data, requestId, ctx) => {
  try {
    const runId = typeof data?.runId === 'string' ? data.runId.trim() : '';
    if (!runId) {
      ctx.sendError(requestId, 'SUBAGENT_RESUME_RUN_INVALID_INPUT', 'runId is required');
      return;
    }

    const success = subAgentRunController.resume(runId);
    ctx.sendResponse(requestId, { success });
  } catch (error: any) {
    ctx.sendError(requestId, 'SUBAGENT_RESUME_RUN_ERROR', error.message || 'Failed to resume SubAgent run');
  }
};

export const exitRun: MessageHandler = async (data, requestId, ctx) => {
  try {
    const runId = typeof data?.runId === 'string' ? data.runId.trim() : '';
    const reason = typeof data?.reason === 'string' && data.reason.trim()
      ? data.reason.trim()
      : '用户主动终止 SubAgent 执行';
    if (!runId) {
      ctx.sendError(requestId, 'SUBAGENT_EXIT_RUN_INVALID_INPUT', 'runId is required');
      return;
    }

    const success = subAgentRunController.exit(runId, reason);
    ctx.sendResponse(requestId, { success });
  } catch (error: any) {
    ctx.sendError(requestId, 'SUBAGENT_EXIT_RUN_ERROR', error.message || 'Failed to exit SubAgent run');
  }
};

export const deleteRunMessage: MessageHandler = async (data, requestId, ctx) => {
  try {
    const runId = typeof data?.runId === 'string' ? data.runId : '';
    const contentIndex = Number(data?.contentIndex);
    const conversationId = typeof data?.conversationId === 'string' ? data.conversationId : undefined;

    if (!runId || !Number.isFinite(contentIndex)) {
      ctx.sendError(requestId, 'SUBAGENT_DELETE_MESSAGE_INVALID_INPUT', 'runId and contentIndex are required');
      return;
    }

    if (conversationId) {
      await subAgentRunEventBus.loadConversationSnapshots(conversationId, ctx.conversationManager);
    }

    const snapshot = subAgentRunEventBus.mutateContents(runId, contents => deleteLogicalMessage(contents, contentIndex));
    if (!snapshot) {
      ctx.sendError(requestId, 'SUBAGENT_RUN_NOT_FOUND', `SubAgent run not found: ${runId}`);
      return;
    }

    const response = createRunMutationResponse(runId, contentIndex);
    if (!response) {
      ctx.sendError(requestId, 'SUBAGENT_RUN_NOT_FOUND', `SubAgent run not found: ${runId}`);
      return;
    }
    ctx.sendResponse(requestId, response);
  } catch (error: any) {
    ctx.sendError(requestId, 'SUBAGENT_DELETE_MESSAGE_ERROR', error.message || 'Failed to delete SubAgent message');
  }
};

export const retryRunFromMessage: MessageHandler = async (data, requestId, ctx) => {
  try {
    const runId = typeof data?.runId === 'string' ? data.runId : '';
    const contentIndex = Number(data?.contentIndex);
    const conversationId = typeof data?.conversationId === 'string' ? data.conversationId : undefined;

    if (!runId || !Number.isFinite(contentIndex)) {
      ctx.sendError(requestId, 'SUBAGENT_RETRY_MESSAGE_INVALID_INPUT', 'runId and contentIndex are required');
      return;
    }

    if (conversationId) {
      await subAgentRunEventBus.loadConversationSnapshots(conversationId, ctx.conversationManager);
    }

    const snapshot = subAgentRunEventBus.mutateContents(runId, contents => truncateFrom(contents, contentIndex));
    if (!snapshot) {
      ctx.sendError(requestId, 'SUBAGENT_RUN_NOT_FOUND', `SubAgent run not found: ${runId}`);
      return;
    }

    const response = createRunMutationResponse(runId, contentIndex);
    if (!response) {
      ctx.sendError(requestId, 'SUBAGENT_RUN_NOT_FOUND', `SubAgent run not found: ${runId}`);
      return;
    }
    ctx.sendResponse(requestId, response);
  } catch (error: any) {
    ctx.sendError(requestId, 'SUBAGENT_RETRY_MESSAGE_ERROR', error.message || 'Failed to retry SubAgent message');
  }
};

/**
 * 更新全局配置（maxConcurrentAgents 等）
 */
export const updateGlobalConfig: MessageHandler = async (data, requestId, ctx) => {
  try {
    const updates: Record<string, unknown> = {};
    
    // 支持的全局配置字段
    if (data.maxConcurrentAgents !== undefined) {
      updates.maxConcurrentAgents = data.maxConcurrentAgents;
    }

    if (data.failureModeAfterRetries === 'fail_parent_tool' || data.failureModeAfterRetries === 'wait_for_monitor_action') {
      updates.failureModeAfterRetries = data.failureModeAfterRetries;
    }
    
    if (Object.keys(updates).length > 0) {
      await ctx.settingsManager.updateSubAgentsConfig(updates);
      
      // 通知工具定义刷新（因为工具描述中包含限制信息）
      refreshSubAgentsTool();
    }
    
    ctx.sendResponse(requestId, { success: true });
  } catch (error: any) {
    ctx.sendError(requestId, 'UPDATE_GLOBAL_CONFIG_ERROR', error.message || 'Failed to update global config');
  }
};

/**
 * 初始化子代理（从持久化存储加载到内存）
 */
export function initializeSubAgentsFromSettings(ctx: HandlerContext): void {
  try {
    const agents = ctx.settingsManager.getSubAgents();
    
    for (const agent of agents) {
      // 跳过已存在的
      if (!subAgentRegistry.has(agent.type)) {
        subAgentRegistry.registerFromConfig(agent);
      }
    }
    
    console.log(`[SubAgents] Initialized ${agents.length} sub-agents from settings`);
  } catch (error) {
    console.error('[SubAgents] Failed to initialize from settings:', error);
  }
}

/**
 * 注册 SubAgents 处理器
 */
export function registerSubAgentsHandlers(registry: Map<string, MessageHandler>): void {
  registry.set('subagents.list', listSubAgents);
  registry.set('subagents.get', getSubAgent);
  registry.set('subagents.create', createSubAgent);
  registry.set('subagents.update', updateSubAgent);
  registry.set('subagents.delete', deleteSubAgent);
  registry.set('subagents.setEnabled', setSubAgentEnabled);
  registry.set('subagents.updateGlobalConfig', updateGlobalConfig);
  registry.set('subagents.openMonitor', openSubAgentMonitor);
  registry.set('subagents.pauseRun', pauseRun);
  registry.set('subagents.resumeRun', resumeRun);
  registry.set('subagents.exitRun', exitRun);
  registry.set('subagents.deleteRunMessage', deleteRunMessage);
  registry.set('subagents.retryRunFromMessage', retryRunFromMessage);
}
