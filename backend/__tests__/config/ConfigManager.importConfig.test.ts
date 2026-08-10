/**
 * ConfigManager importConfig / replaceConfig / updateModels 回归测试（R2 M5 补测）。
 *
 * 覆盖：导入整体替换语义（旧配置多余子字段/数组项被清空）、保留 id/createdAt、
 * updateModels 原子合并（基于最新列表合并后写回，非 check-then-write）。
 */
import { ConfigManager } from '../../modules/config/ConfigManager';
import { MemoryStorageAdapter } from '../../modules/config/storage';

async function createGeminiManager(overrides: Record<string, unknown> = {}): Promise<{ manager: ConfigManager; id: string }> {
    const manager = new ConfigManager(new MemoryStorageAdapter());
    const id = await manager.createConfig({
        name: '我的 Gemini',
        type: 'gemini',
        enabled: true,
        timeout: 60000,
        url: 'https://generativelanguage.googleapis.com/v1beta',
        model: 'gemini-2.5-flash',
        apiKey: 'AIza-test-key',
        toolMode: 'xml',
        retryCount: 5,
        customHeadersEnabled: true,
        customHeaders: [{ key: 'X-User', value: 'alice', enabled: true }],
        options: { temperature: 0.7 },
        ...overrides,
    } as any);
    return { manager, id };
}

describe('ConfigManager.importConfig（R2 M5 补测）', () => {
    it('新建导入：保留原始 id，createdAt 写入', async () => {
        const { manager } = await createGeminiManager();
        const importedId = await manager.importConfig({
            id: 'imported_1',
            name: 'Imported',
            type: 'openai',
            apiKey: 'sk-imported',
            model: 'gpt-4o',
        } as any);
        expect(importedId).toBe('imported_1');
        const config = await manager.getConfig('imported_1') as any;
        expect(config.name).toBe('Imported');
        expect(config.type).toBe('openai');
        expect(config.createdAt).toBeGreaterThan(0);
    });

    it('同 id 已存在且未开 overwrite：抛 configExists', async () => {
        const { manager, id } = await createGeminiManager();
        await expect(manager.importConfig({ id, name: 'Dup' } as any)).rejects.toThrow(/exists|已存在/);
    });

    it('overwrite 导入：整体替换——旧配置多余子字段/数组项被清空（replaceConfig 语义）', async () => {
        const { manager, id } = await createGeminiManager({
            customHeaders: [
                { key: 'X-User', value: 'alice', enabled: true },
                { key: 'X-Extra', value: 'bob', enabled: true },
            ],
            options: {
                temperature: 0.7,
                maxOutputTokens: 4096,
            },
        });

        // 导入文件只含少量字段：updateConfig 深合并无法清空 X-Extra / maxOutputTokens
        await manager.importConfig({
            id,
            name: 'Replaced',
            type: 'gemini',
            apiKey: 'new-key',
            model: 'gemini-2.5-pro',
            customHeaders: [{ key: 'X-User', value: 'carol', enabled: true }],
        } as any, { overwrite: true });

        const after = await manager.getConfig(id) as any;
        expect(after.name).toBe('Replaced');
        // 数组整体替换：旧项 X-Extra 清空
        expect(after.customHeaders).toEqual([{ key: 'X-User', value: 'carol', enabled: true }]);
        // 纯对象字段整体替换：导入文件未含 options → 旧子字段（maxOutputTokens）整体移除
        expect(after.options).toBeUndefined();
        // 未在导入文件中的旧字段（url）被移除
        expect(after.url).toBeUndefined();
        // id / createdAt 保留
        expect(after.id).toBe(id);
    });

    it('replaceConfig 保留 id 与 createdAt，updatedAt 更新', async () => {
        const { manager, id } = await createGeminiManager();
        const before = await manager.getConfig(id) as any;

        await manager.replaceConfig(id, {
            id: 'ignored',
            name: 'Replaced Direct',
            type: 'openai',
            apiKey: 'sk-new',
        } as any);

        const after = await manager.getConfig(id) as any;
        expect(after.id).toBe(id); // 忽略传入的 id，使用参数 id
        expect(after.createdAt).toBe(before.createdAt);
        expect(after.updatedAt).toBeGreaterThanOrEqual(before.updatedAt);
        expect(after.name).toBe('Replaced Direct');
    });

    it('replaceConfig 未知 id：抛 configNotFound', async () => {
        const { manager } = await createGeminiManager();
        await expect(manager.replaceConfig('nope', { id: 'nope', name: 'x', type: 'openai' } as any))
            .rejects.toThrow(/not found|不存在/);
    });
});

describe('ConfigManager.updateModels（R2 M5 补测）', () => {
    it('基于最新列表合并后写回（mergeFn 输入为当前 models）', async () => {
        const { manager, id } = await createGeminiManager({
            models: [
                { id: 'gemini-2.5-flash', name: 'Flash', contextWindow: 128000 },
            ],
        });

        const updated = await manager.updateModels(id, (current) => [
            ...current,
            { id: 'gemini-2.5-pro', name: 'Pro', contextWindow: 256000 },
        ]);

        expect(updated.models).toHaveLength(2);
        expect((updated.models as any[])[1].id).toBe('gemini-2.5-pro');

        // 持久化到存储：重新读取一致
        const reread = await manager.getConfig(id) as any;
        expect(reread.models).toHaveLength(2);
    });

    it('无 models 的配置：mergeFn 收到空数组', async () => {
        const { manager, id } = await createGeminiManager();
        const updated = await manager.updateModels(id, (current) => {
            expect(current).toEqual([]);
            return [{ id: 'm1', name: 'M1' }];
        });
        expect((updated.models as any[])).toHaveLength(1);
    });

    it('未知 id：抛 configNotFound', async () => {
        const { manager } = await createGeminiManager();
        await expect(manager.updateModels('nope', (c) => c)).rejects.toThrow(/not found|不存在/);
    });
});
