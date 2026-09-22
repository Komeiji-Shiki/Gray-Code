import { validateMessagePayload } from '../../../../shared/protocol';
import { SUB_AGENT_PRESETS } from '../../../../backend/tools/subagents/presets';
import type { SubAgentConfigItem } from '../../../../backend/modules/settings/types';
import type { PlatformApplication } from '../application';
import type { ProductSettingsDraft } from '../settings/product';

export function subagentSettingsHandlers(draft: ProductSettingsDraft, app: PlatformApplication) {
  const settings = draft.settings;
  function validate(type: string, data: unknown) {
    const result = validateMessagePayload(type, data); if (!result.ok) throw new Error(result.errors.join('；'));
  }
  function name(value: unknown, type?: string) {
    const text = typeof value === 'string' ? value.trim() : '';
    if (!text) throw new Error('子代理名称不能为空。');
    if (settings.getSubAgents().some(agent => agent.type !== type && agent.name.toLowerCase() === text.toLowerCase())) throw new Error('已经存在同名子代理。');
    return text;
  }
  return {
    'subagents.list': () => structuredClone(settings.getSubAgentsConfig()),
    'subagents.getPresets': () => ({ presets: structuredClone(SUB_AGENT_PRESETS) }),
    'subagents.create': async (data: Record<string, any>) => {
      validate('subagents.create', data);
      const type = data.type.trim(); if (!type || settings.getSubAgent(type)) throw new Error('子代理类型为空或已存在。');
      const agent: SubAgentConfigItem = { type, name: name(data.name), description: data.description || '', systemPrompt: data.systemPrompt || '',
        channel: data.channel || { channelId: '' }, tools: data.tools || { mode: 'all' }, maxIterations: data.maxIterations,
        maxRuntime: data.maxRuntime, failureModeAfterRetries: data.failureModeAfterRetries || 'fail_parent_tool', enabled: data.enabled !== false };
      await settings.addSubAgent(agent); return { success: true, type };
    },
    'subagents.update': async (data: Record<string, any>) => {
      validate('subagents.update', data);
      if (!settings.getSubAgent(data.type)) throw new Error('子代理不存在。');
      const updates = structuredClone(data.updates);
      if ('name' in updates) updates.name = name(updates.name, data.type);
      const success = await settings.updateSubAgent(data.type, updates); return { success };
    },
    'subagents.delete': async (data: Record<string, any>) => {
      validate('subagents.delete', data);
      const existing = settings.getSubAgent(data.type); if (!existing) throw new Error('子代理不存在。');
      if (app.subagents.hasActiveAgent(existing.name)) throw new Error('子代理仍有运行任务，请先从监视器停止。');
      return { success: await settings.deleteSubAgent(data.type) };
    },
    'subagents.updateGlobalConfig': async (data: Record<string, any>) => {
      validate('subagents.updateGlobalConfig', data);
      const updates: Record<string, any> = {};
      for (const key of ['maxConcurrentAgents', 'queueTimeoutSeconds', 'defaultMaxRuntimeSeconds', 'defaultMaxIterations']) if (data[key] !== undefined) {
        if (!Number.isSafeInteger(data[key]) || data[key] !== -1 && data[key] < 1) throw new Error(`${key} 必须为 -1 或正整数。`);
        updates[key] = data[key];
      }
      if (['fail_parent_tool', 'wait_for_monitor_action'].includes(data.failureModeAfterRetries)) updates.failureModeAfterRetries = data.failureModeAfterRetries;
      if (typeof data.generalWorkerEnabled === 'boolean') updates.generalWorkerEnabled = data.generalWorkerEnabled;
      await settings.updateSubAgentsConfig(updates); return { success: true };
    },
  };
}
