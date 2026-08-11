/**
 * ConfigManager.exportConfig 脱敏回归测试
 *
 * includeSensitive=false 时递归脱敏：
 * - 顶层 apiKey
 * - customHeaders 条目的 value（如 Authorization）
 * - customBody 条目的 value / advanced 模式的 json
 * - tokenCountApiConfig.apiKey（嵌套对象）
 *
 * includeSensitive=true 时原样导出。
 */
import { ConfigManager } from '../../modules/config/ConfigManager';
import { MemoryStorageAdapter } from '../../modules/config/storage';

describe('ConfigManager.exportConfig 脱敏', () => {
    async function createManagerWithSensitiveConfig(): Promise<{ manager: ConfigManager; id: string }> {
        const manager = new ConfigManager(new MemoryStorageAdapter());
        const id = await manager.createConfig({
            name: 'OpenAI Test',
            type: 'openai',
            enabled: true,
            timeout: 120000,
            url: 'https://api.openai.com/v1',
            model: 'gpt-4o',
            apiKey: 'sk-secret-123',
            customHeadersEnabled: true,
            customHeaders: [
                { key: 'Authorization', value: 'Bearer tok-abc-456', enabled: true },
                { key: 'X-User', value: 'alice', enabled: true },
            ],
            customBodyEnabled: true,
            customBody: {
                mode: 'simple',
                items: [
                    { key: 'extra_body', value: '{"api_key":"sk-nested-999"}', enabled: true },
                ],
            },
            tokenCountApiConfig: {
                url: 'https://token.example.com/v1',
                apiKey: 'tok-key-777',
                model: 'gpt-4o-mini',
            },
        } as any);
        return { manager, id };
    }

    test('includeSensitive=false：递归脱敏所有敏感字段，保留非敏感字段', async () => {
        const { manager, id } = await createManagerWithSensitiveConfig();
        const exported = await manager.exportConfig(id);

        // 顶层 apiKey
        expect(exported.apiKey).toBe('***REDACTED***');

        // customHeaders 的 value（含 Authorization），key 保留
        expect(exported.customHeaders[0].key).toBe('Authorization');
        expect(exported.customHeaders[0].value).toBe('***REDACTED***');
        expect(exported.customHeaders[1].value).toBe('***REDACTED***');

        // customBody 条目的 value，key 保留
        expect(exported.customBody.items[0].key).toBe('extra_body');
        expect(exported.customBody.items[0].value).toBe('***REDACTED***');

        // 嵌套 tokenCountApiConfig.apiKey
        expect(exported.tokenCountApiConfig.apiKey).toBe('***REDACTED***');

        // 非敏感字段原样保留
        expect(exported.name).toBe('OpenAI Test');
        expect(exported.url).toBe('https://api.openai.com/v1');
        expect(exported.model).toBe('gpt-4o');
        expect(exported.customBody.mode).toBe('simple');
        expect(exported.tokenCountApiConfig.url).toBe('https://token.example.com/v1');
        expect(exported.tokenCountApiConfig.model).toBe('gpt-4o-mini');
    });

    test('includeSensitive=false：advanced 模式的 customBody.json 被脱敏', async () => {
        const manager = new ConfigManager(new MemoryStorageAdapter());
        const id = await manager.createConfig({
            name: 'Advanced Body',
            type: 'openai',
            enabled: true,
            timeout: 120000,
            customBody: { mode: 'advanced', json: '{"auth":{"token":"sk-adv-1"}}' },
        } as any);

        const exported = await manager.exportConfig(id);
        expect(exported.customBody.mode).toBe('advanced');
        expect(exported.customBody.json).toBe('***REDACTED***');
    });

    test('includeSensitive=true：原样导出，不脱敏', async () => {
        const { manager, id } = await createManagerWithSensitiveConfig();
        const exported = await manager.exportConfig(id, { includeSensitive: true });

        expect(exported.apiKey).toBe('sk-secret-123');
        expect(exported.customHeaders[0].value).toBe('Bearer tok-abc-456');
        expect(exported.customBody.items[0].value).toBe('{"api_key":"sk-nested-999"}');
        expect(exported.tokenCountApiConfig.apiKey).toBe('tok-key-777');
    });

    test('脱敏导出不修改缓存中的原始配置', async () => {
        const { manager, id } = await createManagerWithSensitiveConfig();
        await manager.exportConfig(id);

        const cached = (await manager.getConfig(id)) as any;
        expect(cached).not.toBeNull();
        expect(cached.apiKey).toBe('sk-secret-123');
        expect(cached.customHeaders[0].value).toBe('Bearer tok-abc-456');
        expect(cached.customBody.items[0].value).toBe('{"api_key":"sk-nested-999"}');
    });
});
