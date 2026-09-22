import { SettingsCore } from '../../modules/settings/SettingsCore';
import { SubAgentsSettingsService } from '../../modules/settings/SubAgentsSettingsService';
import { MemorySettingsStorage } from '../../modules/settings/storage';

test('撤销代理上限只移除覆盖值，持久化后继续继承全局配置', async () => {
    const storage = new MemorySettingsStorage();
    const service = new SubAgentsSettingsService(new SettingsCore(storage));
    await service.updateSubAgentsConfig({ agents: [], defaultMaxIterations: 80, defaultMaxRuntimeSeconds: 1800 });
    await service.addSubAgent({ type: 'reviewer', name: '审核', description: '', systemPrompt: '', enabled: true,
        channel: { channelId: 'provider', modelId: 'model' }, tools: { mode: 'all' }, maxIterations: 10, maxRuntime: 300 });

    await service.updateSubAgent('reviewer', { maxIterations: null, maxRuntime: null });
    const saved = (await storage.load())!.toolsConfig!.subagents as ReturnType<typeof service.getSubAgentsConfig>;
    expect(saved.agents[0]).not.toHaveProperty('maxIterations');
    expect(saved.agents[0]).not.toHaveProperty('maxRuntime');
    expect(saved.agents[0].channel).toEqual({ channelId: 'provider', modelId: 'model' });
    expect(saved.defaultMaxIterations).toBe(80);
    expect(saved.defaultMaxRuntimeSeconds).toBe(1800);

    await service.updateSubAgent('reviewer', { maxIterations: -1 });
    await expect(service.updateSubAgent('reviewer', { description: '不能部分保存', maxIterations: 2.5 })).rejects.toThrow('正整数');
    expect(service.getSubAgent('reviewer')?.maxIterations).toBe(-1);
    expect(service.getSubAgent('reviewer')?.description).toBe('');
});
