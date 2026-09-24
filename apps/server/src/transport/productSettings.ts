import { subagentSettingsHandlers } from '../subagents/settingsUi';
import { DEFAULT_SUMMARIZE_CONFIG } from '../../../../backend/modules/settings/types/summarizeTypes';
import { branchRetentionDays, DEFAULT_BRANCH_RETENTION_DAYS } from '../conversations/retention';
import type { ProductSettingsDraft } from '../settings/product';
import type { PlatformApplication } from '../application';
import { mcpUiHandlers } from '../mcp/ui';
import { getModels } from '../../../../backend/modules/channel/modelList';

type Handler = (data: Record<string, any>) => unknown | Promise<unknown>;
/** Explicit mapping preserves the existing feature service validation and response contracts. */
export function productSettingsHandlers(draft: ProductSettingsDraft, app: PlatformApplication, mode: 'chat' | 'code' | 'character' = 'chat'): Record<string, Handler> {
  const settings = draft.settings;
  const configs: Record<string, () => unknown> = {
    list_files: () => settings.getListFilesConfig(), read_file: () => settings.getReadFileConfig(), write_file: () => settings.getWriteFileConfig(),
    apply_diff: () => settings.getApplyDiffConfig(), delete_file: () => settings.getDeleteFileConfig(), find_files: () => settings.getFindFilesConfig(),
    search_in_files: () => settings.getSearchInFilesConfig(), execute_command: () => settings.getExecuteCommandConfig(), history_search: () => settings.getHistorySearchConfig(),
    generate_image: () => settings.getGenerateImageConfig(), remove_background: () => settings.getRemoveBackgroundConfig(),
    crop_image: () => settings.getCropImageConfig(), resize_image: () => settings.getResizeImageConfig(), rotate_image: () => settings.getRotateImageConfig(),
  };
  return {
    ...mcpUiHandlers(draft, app),
    'conversation.getBranchRetentionConfig': () => ({ retentionDays: draft.value.branchRetentionDays ?? DEFAULT_BRANCH_RETENTION_DAYS }),
    'conversation.updateBranchRetentionConfig': data => {
      draft.value.branchRetentionDays = branchRetentionDays(data.retentionDays); draft.dirty = true;
      return { success: true, retentionDays: draft.value.branchRetentionDays };
    },
    getSettings: () => ({ success: true, settings: settings.getSettings() }),
    updateSettings: async data => { await settings.updateSettings(data.settings); return { success: true, settings: settings.getSettings() }; },
    updateUISettings: async data => { await settings.updateUISettings(data.ui); return { success: true }; },
    updateProxySettings: async data => { await settings.updateProxySettings(data.proxySettings); return { success: true }; },
    'settings.getActiveChannelId': () => ({ channelId: settings.getActiveChannelId() }),
    'settings.setActiveChannelId': async data => { await settings.setActiveChannelId(data.channelId); return { success: true }; },
    getDefaultSummarizeConfig: () => structuredClone(DEFAULT_SUMMARIZE_CONFIG),
    getSummarizeConfig: () => settings.getSummarizeConfig(),
    updateSummarizeConfig: async data => { await settings.updateSummarizeConfig(data.config); return { success: true }; },
    getGenerateImageConfig: () => settings.getGenerateImageConfig(),
    updateGenerateImageConfig: async data => { await settings.updateGenerateImageConfig(data.config); return { success: true }; },
    getSystemPromptConfig: () => settings.getSystemPromptConfig(),
    updateSystemPromptConfig: async data => { await settings.updateSystemPromptConfig(data.config); return { success: true }; },
    getPromptModes: () => ({ modes: settings.getAllPromptModes(), currentModeId: draft.app.modeProfiles?.[mode]?.promptModeId ?? settings.getCurrentPromptModeId(), dynamicContextStrategy: settings.resolveDynamicContextStrategy() }),
    setCurrentPromptMode: async data => { await settings.setCurrentPromptMode(data.modeId); return { success: true }; },
    savePromptMode: async data => { await settings.savePromptMode(data.mode); return { success: true }; },
    renamePromptMode: data => settings.renamePromptMode(data.modeId, data.name),
    deletePromptMode: async data => { await settings.deletePromptMode(data.modeId); return { success: true }; },
    getTokenCountConfig: () => settings.getTokenCountConfig(),
    updateTokenCountConfig: async data => { await settings.updateTokenCountConfig(data.config); return { success: true }; },
    getContextAwarenessConfig: () => settings.getContextAwarenessConfig(),
    updateContextAwarenessConfig: async data => { await settings.updateContextAwarenessConfig(data.config); return { success: true }; },
    getPinnedFilesConfig: () => settings.getPinnedFilesConfig(),
    updatePinnedFilesConfig: async data => { await settings.updatePinnedFilesConfig(data.config); return { success: true }; },
    'checkpoint.getConfig': () => ({ config: settings.getCheckpointConfig() }),
    'checkpoint.updateConfig': async data => { await settings.updateCheckpointConfig(data.config); return { success: true }; },
    'tools.getAutoExecConfig': () => ({ config: settings.getToolAutoExecConfig() }),
    'tools.getListFilesConfig': () => ({ config: settings.getListFilesConfig() }),
    'tools.updateListFilesConfig': async data => { await settings.updateListFilesConfig(data.config); return { success: true }; },
    'tools.getFindFilesConfig': () => ({ config: settings.getFindFilesConfig() }),
    'tools.updateFindFilesConfig': async data => { await settings.updateFindFilesConfig(data.config); return { success: true }; },
    'tools.getSearchInFilesConfig': () => ({ config: settings.getSearchInFilesConfig() }),
    'tools.updateSearchInFilesConfig': async data => { await settings.updateSearchInFilesConfig(data.config); return { success: true }; },
    'tools.getApplyDiffConfig': () => ({ config: settings.getApplyDiffConfig() }),
    'tools.updateApplyDiffConfig': async data => { await settings.updateApplyDiffConfig(data.config); return { success: true }; },
    'tools.getHistorySearchConfig': () => ({ config: settings.getHistorySearchConfig() }),
    'tools.updateHistorySearchConfig': async data => { await settings.updateHistorySearchConfig(data.config); return { success: true }; },
    'tools.getExecuteCommandConfig': () => ({ config: settings.getExecuteCommandConfig() }),
    'tools.updateExecuteCommandConfig': async data => { await settings.updateExecuteCommandConfig(data.config); return { success: true }; },
    'tools.getToolConfig': data => ({ config: configs[data.toolName]?.() ?? settings.getToolsConfig()[data.toolName] ?? {} }),
    'tools.updateToolConfig': async data => { await settings.updateToolConfig(data.toolName, data.config); return { success: true }; },
    'tools.getMaxToolIterations': () => ({ maxIterations: settings.getMaxToolIterations() }),
    'tools.updateMaxToolIterations': async data => { await settings.setMaxToolIterations(data.maxIterations); for (const agent of draft.app.agents) agent.maxIterations = settings.getMaxToolIterations(); return { success: true }; },
    'tools.setToolAutoExec': async data => { await settings.setToolAutoExec(data.toolName, data.autoExec); return { success: true }; },
    'tools.getTools': () => ({ tools: app.tools.declarations().map(tool => ({ ...tool, enabled: settings.isToolEnabled(tool.name),
      category: /^(read_file|write_file|apply_diff|insert_code|delete_code|delete_file|create_directory|list_files|find_files|search_in_files|workspace_files|search_files)$/.test(tool.name) ? 'file'
        : /^(run_command|process_session|execute_command)$/.test(tool.name) ? 'terminal'
          : tool.name.startsWith('memory_') ? 'memory' : tool.name === 'read_skill' ? 'skills' : tool.name.startsWith('todo_') ? 'todo' : tool.name === 'history_search' ? 'history'
            : tool.name === 'get_activity_stats' ? 'activity' : tool.name.startsWith('mcp_') ? 'mcp' : ['generate_image', 'remove_background', 'crop_image', 'resize_image', 'rotate_image'].includes(tool.name) ? 'media' : 'other' })) }),
    'tools.setToolEnabled': async data => { await settings.setToolEnabled(data.toolName, data.enabled); return { success: true }; },
    'tools.setToolsEnabled': async data => { await settings.setToolsEnabled(data.states); return { success: true }; },
    getSkillsConfig: () => settings.getSkillsConfig(),
    updateSkillsConfig: async data => { await settings.updateSkillsConfig(data.config); return { success: true }; },
    'subagents.getConfig': () => ({ config: settings.getSubAgentsConfig() }),
    'subagents.updateConfig': async data => { await settings.updateSubAgentsConfig(data.config); return { success: true }; },
    ...subagentSettingsHandlers(draft, app),
    'config.listConfigs': () => draft.configs.listConfigs().then(configs => configs.map(config => config.id)),
    'config.getConfig': async data => {
      const config = await draft.configs.getConfig(data.configId);
      if (!config) return null;
      // 保存后 ConfigManager 缓存仍可能持有刚提交的明文；设置草稿才是当前展示值。
      return { ...config, apiKey: draft.value.channels.find(value => value.id === data.configId)?.apiKey ?? config.apiKey };
    },
    'config.revealApiKey': async data => {
      const config = await draft.configs.getConfig(data.configId);
      if (!config) throw new Error('渠道不存在。');
      // 设置草稿中已有新凭据时优先显示草稿；占位值才从凭据存储按需读取。
      const draftKey = draft.value.channels.find(value => value.id === data.configId)?.apiKey ?? config.apiKey;
      return { apiKey: draftKey === '••••••••'
        ? (await app.product.channel(data.configId))?.apiKey ?? ''
        : draftKey };
    },
    'config.createConfig': data => draft.configs.createConfig(data as any),
    'config.updateConfig': async data => { await draft.configs.updateConfig(data.configId, data.updates); return { success: true }; },
    'config.deleteConfig': async data => { await draft.configs.deleteConfig(data.configId); return { success: true }; },
    'models.getModels': async data => {
      const config = await draft.configs.getConfig(data.configId);
      if (!config) throw new Error('渠道不存在。');
      if (config.apiKey === '••••••••') config.apiKey = (await app.product.channel(data.configId))?.apiKey ?? '';
      return getModels(config, settings.getEffectiveProxyUrl());
    },
    'models.setActiveModel': async data => { await draft.configs.updateConfig(data.configId, { model: data.modelId }); return { success: true }; },
    'models.addModels': async data => {
      const config = await draft.configs.getConfig(data.configId); if (!config) throw new Error('渠道不存在。');
      const models = new Map((config.models ?? []).map(model => [model.id, model]));
      for (const item of data.models) { const model = typeof item === 'string' ? { id: item, name: item } : item; models.set(model.id, model); }
      await draft.configs.updateConfig(data.configId, { models: [...models.values()] }); return { success: true };
    },
    'models.removeModel': async data => {
      const config = await draft.configs.getConfig(data.configId); if (!config) throw new Error('渠道不存在。');
      await draft.configs.updateConfig(data.configId, { models: (config.models ?? []).filter(model => model.id !== data.modelId) }); return { success: true };
    },
  };
}
