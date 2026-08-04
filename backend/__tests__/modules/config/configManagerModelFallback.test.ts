/**
 * ConfigManager 模型回退测试
 *
 * 修复原因：渠道只配置了 models 列表而 model 为空时，前端发送按钮被禁用
 * （currentModel 为空），存在最近对话栏时无法发送消息；请求侧也没有可用模型。
 * 修复方式：createConfig / updateConfig / getConfig 三个路径统一解析
 * model = models[0].id（读取路径只作用于返回的副本，不污染缓存）。
 */
import { ConfigManager } from '../../../modules/config/ConfigManager';
import type { ConfigStorageAdapter } from '../../../modules/config/storage';
import type { CreateConfigInput, ChannelType } from '../../../modules/config/types';

function createMemoryAdapter(): ConfigStorageAdapter {
  const store = new Map<string, any>();
  return {
    async save(config: any): Promise<void> {
      store.set(config.id, config);
    },
    async load(configId: string): Promise<any> {
      return store.get(configId) || null;
    },
    async list(): Promise<string[]> {
      return Array.from(store.keys());
    },
    async delete(configId: string): Promise<void> {
      store.delete(configId);
    }
  } as ConfigStorageAdapter;
}

const baseInput = {
  name: 'DeepSeek',
  type: 'openai' as ChannelType,
  enabled: true,
  timeout: 120000,
  apiKey: 'sk-test',
  url: 'https://api.deepseek.com/v1',
  models: [
    { id: 'deepseek-v4-flash', name: 'deepseek-v4-flash' },
    { id: 'deepseek-v4-pro', name: 'deepseek-v4-pro' }
  ]
} as CreateConfigInput;

describe('ConfigManager 模型回退', () => {
  it('createConfig 时 model 为空则自动选中 models[0]', async () => {
    const manager = new ConfigManager(createMemoryAdapter());
    const id = await manager.createConfig({ ...baseInput, model: '' });
    const config = await manager.getConfig(id);
    expect(config?.model).toBe('deepseek-v4-flash');
  });

  it('getConfig 时 model 为空自动回退 models[0]（读取路径不污染缓存）', async () => {
    const adapter = createMemoryAdapter();
    const manager = new ConfigManager(adapter);
    // 直接写入坏数据（绕过 createConfig 的自我修复），模拟历史遗留配置
    const rawConfig = {
      id: 'legacy-bad', name: 'Legacy', type: 'openai' as ChannelType, enabled: true,
      timeout: 120000, apiKey: 'sk-test', url: 'https://api.example.com/v1',
      model: '', models: [{ id: 'm1', name: 'm1' }, { id: 'm2', name: 'm2' }],
      createdAt: 0, updatedAt: 0
    };
    await adapter.save(rawConfig);
    await manager.listConfigs(); // 触发 ensureLoaded 加载缓存
    // 通过 getConfig 读取两次，均返回解析后的模型
    const config = await manager.getConfig('legacy-bad');
    expect(config?.model).toBe('m1');
    const config2 = await manager.getConfig('legacy-bad');
    expect(config2?.model).toBe('m1');
    // 缓存内原始配置保持 model 为空字符串（仅读取路径解析，不改写缓存）
    const cached = (manager as any).configCache.get('legacy-bad');
    expect(cached.model).toBe('');
  });

  it('updateConfig 时自动修复历史坏数据（空 model + models 非空）', async () => {
    const manager = new ConfigManager(createMemoryAdapter());
    const id = await manager.createConfig({ ...baseInput, model: 'deepseek-v4-pro' });
    // 模拟坏数据：直接把 model 更新为空
    await manager.updateConfig(id, { model: '' });
    const config = await manager.getConfig(id);
    expect(config?.model).toBe('deepseek-v4-flash');
  });

  it('model 显式指定时不被回退覆盖', async () => {
    const manager = new ConfigManager(createMemoryAdapter());
    const id = await manager.createConfig({ ...baseInput, model: 'deepseek-v4-pro' });
    const config = await manager.getConfig(id);
    expect(config?.model).toBe('deepseek-v4-pro');
  });

  it('无 models 列表时 model 保持为空', async () => {
    const manager = new ConfigManager(createMemoryAdapter());
    const id = await manager.createConfig({ name: 'Plain', type: 'openai' as ChannelType, enabled: true, timeout: 120000, apiKey: 'k', url: 'https://api.example.com/v1', model: '' });
    const config = await manager.getConfig(id);
    expect(config?.model).toBe('');
  });

  it('updateConfig 传入非空 model 正常生效', async () => {
    const manager = new ConfigManager(createMemoryAdapter());
    const id = await manager.createConfig({ ...baseInput, model: '' });
    await manager.updateConfig(id, { model: 'deepseek-v4-pro' });
    const config = await manager.getConfig(id);
    expect(config?.model).toBe('deepseek-v4-pro');
  });
});
