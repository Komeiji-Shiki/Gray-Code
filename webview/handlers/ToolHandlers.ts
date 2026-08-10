/**
 * 工具管理消息处理器
 */

import { t } from '../../backend/i18n';
import { checkAllShellsAvailability, killTerminalProcess, getTerminalOutput, cancelImageGeneration, TaskManager, detachRunningTerminalsToBackground } from '../../backend/tools';
import type { HandlerContext, MessageHandler } from '../types';

function getResultError(result: unknown, fallback: string): string {
  if (!result || typeof result !== 'object') return fallback;
  const error = (result as { error?: unknown }).error;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string') {
    return (error as { message: string }).message;
  }
  return fallback;
}

function withToolBoundary(errorCode: string, fallback: string, handler: MessageHandler): MessageHandler {
  return async (data, requestId, ctx) => {
    try {
      await handler(data || {}, requestId, ctx);
    } catch (error) {
      ctx.sendError(requestId, errorCode, error instanceof Error && error.message ? error.message : fallback);
    }
  };
}

// ========== 工具列表和配置 ==========

export const getTools: MessageHandler = async (data, requestId, ctx) => {
  const result = await ctx.settingsHandler.getToolsList({});
  if (result.success) {
    ctx.sendResponse(requestId, { tools: result.tools });
  } else {
    ctx.sendError(requestId, 'GET_TOOLS_ERROR', getResultError(result, t('webview.errors.getToolsFailed')));
  }
};

export const setToolEnabled: MessageHandler = async (data, requestId, ctx) => {
  const { toolName, enabled } = data;
  const result = await ctx.settingsHandler.setToolEnabled({ toolName, enabled });
  if (result.success) {
    ctx.sendResponse(requestId, { success: true });
  } else {
    ctx.sendError(requestId, 'SET_TOOL_ENABLED_ERROR', getResultError(result, t('webview.errors.setToolEnabledFailed')));
  }
};

export const getToolConfig: MessageHandler = async (data, requestId, ctx) => {
  const { toolName } = data;
  const result = await ctx.settingsHandler.getToolConfig({ toolName });
  if (result.success) {
    ctx.sendResponse(requestId, { config: result.config });
  } else {
    ctx.sendError(requestId, 'GET_TOOL_CONFIG_ERROR', getResultError(result, t('webview.errors.getToolConfigFailed')));
  }
};

export const updateToolConfig: MessageHandler = async (data, requestId, ctx) => {
  const { toolName, config } = data;
  const result = await ctx.settingsHandler.updateToolConfig({ toolName, config });
  if (result.success) {
    ctx.sendResponse(requestId, { success: true });
  } else {
    ctx.sendError(requestId, 'UPDATE_TOOL_CONFIG_ERROR', getResultError(result, t('webview.errors.updateToolConfigFailed')));
  }
};

export const getAutoExecConfig: MessageHandler = async (data, requestId, ctx) => {
  try {
    const config = ctx.settingsManager.getToolAutoExecConfig();
    ctx.sendResponse(requestId, { config });
  } catch (error: any) {
    ctx.sendError(requestId, 'GET_AUTO_EXEC_CONFIG_ERROR', error.message || t('webview.errors.getAutoExecConfigFailed'));
  }
};

export const getMcpTools: MessageHandler = async (data, requestId, ctx) => {
  try {
    const allMcpTools = ctx.mcpManager.getAllTools();
    // 按 serverId 查询实际启用状态（listServers 从存储读取配置并合并运行时状态），
    // 不再硬编码 enabled: true，使 setMcpServerEnabled 后的禁用状态如实反映到前端（R2-08 复查）。
    const serverInfos = await ctx.mcpManager.listServers();
    const enabledByServerId = new Map(serverInfos.map(info => [info.config.id, info.config.enabled !== false]));
    const mcpTools: Array<{
      name: string;
      description: string;
      enabled: boolean;
      category: string;
      serverId: string;
      serverName: string;
    }> = [];
    
    for (const serverTools of allMcpTools) {
      for (const tool of (serverTools.tools ?? [])) {
        const fullToolName = `mcp__${serverTools.serverId}__${tool.name}`;
        mcpTools.push({
          name: fullToolName,
          description: tool.description || '',
          enabled: enabledByServerId.get(serverTools.serverId) ?? true,
          category: 'mcp',
          serverId: serverTools.serverId,
          serverName: serverTools.serverName
        });
      }
    }
    
    ctx.sendResponse(requestId, { tools: mcpTools });
  } catch (error: any) {
    ctx.sendError(requestId, 'GET_MCP_TOOLS_ERROR', error.message || t('webview.errors.getMcpToolsFailed'));
  }
};

export const setToolAutoExec: MessageHandler = async (data, requestId, ctx) => {
  try {
    const { toolName, autoExec } = data;
    await ctx.settingsManager.setToolAutoExec(toolName, autoExec);
    ctx.sendResponse(requestId, { success: true });
  } catch (error: any) {
    ctx.sendError(requestId, 'SET_TOOL_AUTO_EXEC_ERROR', error.message || t('webview.errors.setToolAutoExecFailed'));
  }
};

export const getMaxToolIterations: MessageHandler = async (data, requestId, ctx) => {
  try {
    const maxIterations = ctx.settingsManager.getMaxToolIterations();
    ctx.sendResponse(requestId, { maxIterations });
  } catch (error: any) {
    ctx.sendError(requestId, 'GET_MAX_TOOL_ITERATIONS_ERROR', error.message || t('webview.errors.getMaxToolIterationsFailed'));
  }
};

export const updateMaxToolIterations: MessageHandler = async (data, requestId, ctx) => {
  try {
    const { maxIterations } = data;
    await ctx.settingsManager.setMaxToolIterations(maxIterations);
    ctx.sendResponse(requestId, { success: true });
  } catch (error: any) {
    ctx.sendError(requestId, 'UPDATE_MAX_TOOL_ITERATIONS_ERROR', error.message || t('webview.errors.updateMaxToolIterationsFailed'));
  }
};

// ========== 工具特定配置 ==========

export const updateListFilesConfig: MessageHandler = async (data, requestId, ctx) => {
  const result = await ctx.settingsHandler.updateListFilesConfig({ config: data.config });
  if (result.success) {
    ctx.sendResponse(requestId, { success: true });
  } else {
    ctx.sendError(requestId, 'UPDATE_LIST_FILES_CONFIG_ERROR', getResultError(result, t('webview.errors.updateListFilesConfigFailed')));
  }
};

export const getFindFilesConfig: MessageHandler = async (data, requestId, ctx) => {
  try {
    const config = ctx.settingsManager.getFindFilesConfig();
    ctx.sendResponse(requestId, { config });
  } catch (error: any) {
    ctx.sendError(requestId, 'GET_FIND_FILES_CONFIG_ERROR', error.message || t('webview.errors.getFindFilesConfigFailed'));
  }
};

export const updateFindFilesConfig: MessageHandler = async (data, requestId, ctx) => {
  try {
    await ctx.settingsManager.updateFindFilesConfig(data.config);
    ctx.sendResponse(requestId, { success: true });
  } catch (error: any) {
    ctx.sendError(requestId, 'UPDATE_FIND_FILES_CONFIG_ERROR', error.message || t('webview.errors.updateFindFilesConfigFailed'));
  }
};

export const getSearchInFilesConfig: MessageHandler = async (data, requestId, ctx) => {
  try {
    const config = ctx.settingsManager.getSearchInFilesConfig();
    ctx.sendResponse(requestId, { config });
  } catch (error: any) {
    ctx.sendError(requestId, 'GET_SEARCH_IN_FILES_CONFIG_ERROR', error.message || t('webview.errors.getSearchInFilesConfigFailed'));
  }
};

export const updateSearchInFilesConfig: MessageHandler = async (data, requestId, ctx) => {
  try {
    await ctx.settingsManager.updateSearchInFilesConfig(data.config);
    ctx.sendResponse(requestId, { success: true });
  } catch (error: any) {
    ctx.sendError(requestId, 'UPDATE_SEARCH_IN_FILES_CONFIG_ERROR', error.message || t('webview.errors.updateSearchInFilesConfigFailed'));
  }
};

export const updateApplyDiffConfig: MessageHandler = async (data, requestId, ctx) => {
  const result = await ctx.settingsHandler.updateApplyDiffConfig({ config: data.config });
  if (result.success) {
    ctx.sendResponse(requestId, { success: true });
  } else {
    ctx.sendError(requestId, 'UPDATE_APPLY_DIFF_CONFIG_ERROR', getResultError(result, t('webview.errors.updateApplyDiffConfigFailed')));
  }
};

/** getExecuteCommandConfig 的 shell 可用性探测结果缓存：避免每次请求对每个 shell spawn 探测 */
const EXEC_CMD_AVAILABILITY_TTL_MS = 30 * 1000;
let execCmdAvailabilityCache: {
  at: number;
  map: Map<string, { available: boolean; reason?: string }>;
} | null = null;

export const getExecuteCommandConfig: MessageHandler = async (_data, requestId, ctx) => {
  try {
    const config = ctx.settingsManager.getExecuteCommandConfig();

    // 短 TTL 缓存（30s）：spawn 探测慢且占住串行队列，结果在 TTL 内直接复用（R2-08 复查）
    const now = Date.now();
    if (!execCmdAvailabilityCache || now - execCmdAvailabilityCache.at >= EXEC_CMD_AVAILABILITY_TTL_MS) {
      execCmdAvailabilityCache = {
        at: now,
        map: await checkAllShellsAvailability(
          config.shells.map(s => ({ type: s.type, path: s.path }))
        )
      };
    }
    const availabilityMap = execCmdAvailabilityCache.map;

    const configWithAvailability = {
      ...config,
      shells: config.shells.map(shell => ({
        ...shell,
        available: availabilityMap.get(shell.type)?.available ?? false,
        unavailableReason: availabilityMap.get(shell.type)?.reason
      }))
    };
    
    ctx.sendResponse(requestId, { config: configWithAvailability });
  } catch (error: any) {
    ctx.sendError(requestId, 'GET_EXECUTE_COMMAND_CONFIG_ERROR', error.message || 'Failed to get execute command config');
  }
};

export const updateExecuteCommandConfig: MessageHandler = async (data, requestId, ctx) => {
  try {
    const configToSave = {
      ...data.config,
      shells: data.config.shells.map((shell: any) => ({
        type: shell.type,
        enabled: shell.enabled,
        path: shell.path,
        displayName: shell.displayName
      }))
    };
    await ctx.settingsManager.updateExecuteCommandConfig(configToSave);
    ctx.sendResponse(requestId, { success: true });
  } catch (error: any) {
    ctx.sendError(requestId, 'UPDATE_EXECUTE_COMMAND_CONFIG_ERROR', error.message || t('webview.errors.updateExecuteCommandConfigFailed'));
  }
};

export const getHistorySearchConfig: MessageHandler = async (data, requestId, ctx) => {
  try {
    const config = ctx.settingsManager.getHistorySearchConfig();
    ctx.sendResponse(requestId, { config });
  } catch (error: any) {
    ctx.sendError(requestId, 'GET_HISTORY_SEARCH_CONFIG_ERROR', error.message || 'Failed to get history_search config');
  }
};

export const updateHistorySearchConfig: MessageHandler = async (data, requestId, ctx) => {
  try {
    await ctx.settingsManager.updateHistorySearchConfig(data.config);
    ctx.sendResponse(requestId, { success: true });
  } catch (error: any) {
    ctx.sendError(requestId, 'UPDATE_HISTORY_SEARCH_CONFIG_ERROR', error.message || 'Failed to update history_search config');
  }
};


// ========== 终端管理 ==========

export const terminalKill: MessageHandler = async (data, requestId, ctx) => {
  try {
    const { terminalId } = data;
    const result = killTerminalProcess(terminalId);
    ctx.sendResponse(requestId, result);
  } catch (error: any) {
    ctx.sendError(requestId, 'KILL_TERMINAL_ERROR', error.message || t('webview.errors.killTerminalFailed'));
  }
};

export const terminalGetOutput: MessageHandler = async (data, requestId, ctx) => {
  try {
    const { terminalId } = data;
    const result = getTerminalOutput(terminalId);
    ctx.sendResponse(requestId, result);
  } catch (error: any) {
    ctx.sendError(requestId, 'GET_OUTPUT_ERROR', error.message || t('webview.errors.getTerminalOutputFailed'));
  }
};

/**
 * 用户在命令执行期间发送新消息：把当前会话正在前台等待的命令转入后台。
 * 工具立即返回“已转后台”结果，模型得以尽快收尾并响应用户的新消息；
 * 命令完成后结果经任务事件回流为 [Background task completed] 回执。
 */
export const terminalDetachToBackground: MessageHandler = async (data, requestId, ctx) => {
  try {
    const conversationId = typeof data?.conversationId === 'string' ? data.conversationId : undefined;
    const result = detachRunningTerminalsToBackground(conversationId);
    ctx.sendResponse(requestId, { success: true, detached: result.detached });
  } catch (error: any) {
    ctx.sendError(requestId, 'TERMINAL_DETACH_ERROR', error.message || 'Failed to detach running terminal to background');
  }
};

// ========== 图像生成 ==========

export const imageGenerationCancel: MessageHandler = async (data, requestId, ctx) => {
  try {
    const { toolId } = data;
    const result = cancelImageGeneration(toolId);
    ctx.sendResponse(requestId, result);
  } catch (error: any) {
    ctx.sendError(requestId, 'CANCEL_IMAGE_GEN_ERROR', error.message || t('webview.errors.cancelImageGenFailed'));
  }
};

// ========== 任务管理 ==========

export const taskCancel: MessageHandler = async (data, requestId, ctx) => {
  try {
    const { taskId } = data;
    const result = TaskManager.cancelTask(taskId);
    ctx.sendResponse(requestId, result);
  } catch (error: any) {
    ctx.sendError(requestId, 'CANCEL_TASK_ERROR', error.message || t('webview.errors.cancelTaskFailed'));
  }
};

export const taskGetAll: MessageHandler = async (data, requestId, ctx) => {
  try {
    const tasks = TaskManager.getAllTasks().map(task => ({
      id: task.id,
      type: task.type,
      startTime: task.startTime,
      metadata: task.metadata
    }));
    ctx.sendResponse(requestId, { tasks });
  } catch (error: any) {
    ctx.sendError(requestId, 'GET_ALL_TASKS_ERROR', error.message || t('webview.errors.getTasksFailed'));
  }
};

/**
 * 注册工具管理处理器
 */
export function registerToolHandlers(registry: Map<string, MessageHandler>): void {
  const register = (name: string, errorCode: string, fallback: string, handler: MessageHandler): void => {
    registry.set(name, withToolBoundary(errorCode, fallback, handler));
  };
  // 工具列表和配置
  register('tools.getTools', 'GET_TOOLS_ERROR', t('webview.errors.getToolsFailed'), getTools);
  register('tools.setToolEnabled', 'SET_TOOL_ENABLED_ERROR', t('webview.errors.setToolEnabledFailed'), setToolEnabled);
  register('tools.getToolConfig', 'GET_TOOL_CONFIG_ERROR', t('webview.errors.getToolConfigFailed'), getToolConfig);
  register('tools.updateToolConfig', 'UPDATE_TOOL_CONFIG_ERROR', t('webview.errors.updateToolConfigFailed'), updateToolConfig);
  registry.set('tools.getAutoExecConfig', getAutoExecConfig);
  registry.set('tools.getMcpTools', getMcpTools);
  registry.set('tools.setToolAutoExec', setToolAutoExec);
  registry.set('tools.getMaxToolIterations', getMaxToolIterations);
  registry.set('tools.updateMaxToolIterations', updateMaxToolIterations);
  
  // 工具特定配置
  register('tools.updateListFilesConfig', 'UPDATE_LIST_FILES_CONFIG_ERROR', t('webview.errors.updateListFilesConfigFailed'), updateListFilesConfig);
  registry.set('tools.getFindFilesConfig', getFindFilesConfig);
  registry.set('tools.updateFindFilesConfig', updateFindFilesConfig);
  registry.set('tools.getSearchInFilesConfig', getSearchInFilesConfig);
  registry.set('tools.updateSearchInFilesConfig', updateSearchInFilesConfig);
  register('tools.updateApplyDiffConfig', 'UPDATE_APPLY_DIFF_CONFIG_ERROR', t('webview.errors.updateApplyDiffConfigFailed'), updateApplyDiffConfig);
  register('tools.getExecuteCommandConfig', 'GET_EXECUTE_COMMAND_CONFIG_ERROR', 'Failed to get execute command config', getExecuteCommandConfig);
  registry.set('tools.updateExecuteCommandConfig', updateExecuteCommandConfig);
  registry.set('tools.getHistorySearchConfig', getHistorySearchConfig);
  registry.set('tools.updateHistorySearchConfig', updateHistorySearchConfig);
  
  // 终端管理
  registry.set('terminal.kill', terminalKill);
  registry.set('terminal.getOutput', terminalGetOutput);
  registry.set('terminal.detachToBackground', terminalDetachToBackground);
  
  // 图像生成
  registry.set('imageGeneration.cancel', imageGenerationCancel);
  
  // 任务管理
  registry.set('task.cancel', taskCancel);
  registry.set('task.getAll', taskGetAll);
}
