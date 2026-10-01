import { SettingsManager } from '../../modules/settings/SettingsManager';
import { MemorySettingsStorage } from '../../modules/settings/storage';
import type { SubAgentToolsConfig } from '../../modules/settings/types/subAgentsTypes';

const agent = (tools: SubAgentToolsConfig) => ({ type: 'editor', name: '并行修改者', description: '', systemPrompt: '', enabled: true,
    channel: { channelId: 'provider' }, tools });

describe('子代理工具配置持久化兼容', () => {
    test.each([
        { mode: 'whitelist', whitelist: ['workspace_files', 'read_file', 'write_file'] },
        { mode: 'blacklist', blacklist: ['write_file', 'execute_command'] },
        { mode: 'whitelist', list: ['read_file', 'goto_definition'] },
        { mode: 'blacklist', list: ['write_file'] },
    ] as SubAgentToolsConfig[])('具名列表和旧 list 在保存、读取及现有渠道迁移后均保留：%j', async tools => {
        const storage = new MemorySettingsStorage();
        const settings = new SettingsManager(storage); await settings.initialize();
        await settings.updateSubAgentsConfig({ agents: [agent(tools)], forceUseCurrentChannel: true });
        const savedTools = (await storage.load())!.toolsConfig!.subagents!.agents[0].tools;
        expect(savedTools).toEqual(tools);
        const reloaded = new SettingsManager(storage); await reloaded.initialize();
        expect(reloaded.getSubAgent('editor')!.tools).toEqual(tools);
        expect(reloaded.getSubAgent('editor')!.channel.syncWithCurrentModel).toBe(true);
        expect(reloaded.getSubAgentsConfig()).not.toHaveProperty('forceUseCurrentChannel');
    });

    test.each(['whitelist', 'blacklist'] as const)('显式清空 %s 持久化为空，不丢失、不合并遗留工具列表', async mode => {
        const storage = new MemorySettingsStorage();
        const settings = new SettingsManager(storage); await settings.initialize();
        const tools: SubAgentToolsConfig = { mode, [mode]: ['read_file'], list: ['write_file'] };
        await settings.addSubAgent(agent(tools));
        const empty: SubAgentToolsConfig = { ...tools, [mode]: [] };
        await settings.updateSubAgent('editor', { tools: empty });
        expect((await storage.load())!.toolsConfig!.subagents!.agents[0].tools).toEqual(empty);
        const reloaded = new SettingsManager(storage); await reloaded.initialize();
        expect(reloaded.getSubAgent('editor')!.tools).toEqual(empty);
    });
});
