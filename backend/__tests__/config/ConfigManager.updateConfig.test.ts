/**
 * ConfigManager.updateConfig 渠道类型变更回归测试
 *
 * 渠道类型可更改（feat: 可更改渠道类型）：
 * - type 显式传入且与旧类型不同时，以新类型默认配置为基底重建
 * - 跨类型通用字段（名称/API Key/超时/重试/自定义标头等）保留
 * - 类型特有字段（url、models、model、options、optionsEnabled 等）重置为新类型默认值
 * - 显式传入的 updates 优先级最高
 * - 普通更新（type 未变更）保持旧行为
 */
import { ConfigManager } from '../../modules/config/ConfigManager';
import { MemoryStorageAdapter } from '../../modules/config/storage';

describe('ConfigManager.updateConfig 渠道类型变更', () => {
    async function createGeminiManager(): Promise<{ manager: ConfigManager; id: string }> {
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
            systemInstruction: 'custom system instruction',
            maxContextTokens: 128000,
            retryCount: 5,
            customHeadersEnabled: true,
            customHeaders: [
                { key: 'X-User', value: 'alice', enabled: true },
            ],
            options: {
                temperature: 0.7,
                maxOutputTokens: 8192,
                thinkingConfig: {
                    includeThoughts: true,
                    mode: 'default',
                    thinkingLevel: 'low',
                    thinkingBudget: 1024
                }
            },
            optionsEnabled: {
                temperature: true,
                maxOutputTokens: false,
                maxImages: false,
                thinkingConfig: true
            },
            tokenCountMethod: 'gemini',
        } as any);
        return { manager, id };
    }

    test('所有新渠道默认关闭 OpenCode 会话兼容', () => {
        const manager = new ConfigManager(new MemoryStorageAdapter());
        const channelTypes = ['gemini', 'gemini-interactions', 'openai', 'anthropic', 'openai-responses'] as const;

        for (const type of channelTypes) {
            expect(manager.getDefaultConfig(type).openCodeSessionEnabled).toBe(false);
        }
    });

    test('类型变更成功：type 更新，ID / createdAt 保持不变，updatedAt 更新', async () => {
        const { manager, id } = await createGeminiManager();
        const before = await manager.getConfig(id) as any;

        await manager.updateConfig(id, { type: 'openai' });

        const after = await manager.getConfig(id) as any;
        expect(after.type).toBe('openai');
        expect(after.id).toBe(id);
        expect(after.createdAt).toBe(before.createdAt);
        expect(after.updatedAt).toBeGreaterThanOrEqual(before.updatedAt);
    });

    test('类型变更后类型特有字段重置为新类型默认值，旧类型字段不残留', async () => {
        const { manager, id } = await createGeminiManager();

        await manager.updateConfig(id, { type: 'anthropic' });

        const after = await manager.getConfig(id) as any;
        expect(after.type).toBe('anthropic');
        // 旧类型特有字段（Gemini 思考配置）不再残留
        expect(after.options.thinkingConfig).toBeUndefined();
        expect(after.options.thinkingLevel).toBeUndefined();
        // 旧 url 是旧类型默认端点（未自定义）：跟随新类型默认端点
        expect(after.url).toBe('https://api.anthropic.com/v1');
        expect(after.options.thinking).toEqual(expect.objectContaining({ budget_tokens: 10000 }));
        expect(after.optionsEnabled.thinking).toBe(false);
        // 模型相关字段重置（跨类型不通用）
        expect(after.model).toBe('');
        expect(after.models).toEqual([]);
    });

    test('类型变更后跨类型通用字段保留', async () => {
        const { manager, id } = await createGeminiManager();

        await manager.updateConfig(id, { type: 'openai' });

        const after = await manager.getConfig(id) as any;
        expect(after.name).toBe('我的 Gemini');
        expect(after.enabled).toBe(true);
        expect(after.timeout).toBe(60000);
        expect(after.apiKey).toBe('AIza-test-key');
        expect(after.toolMode).toBe('xml');
        expect(after.systemInstruction).toBe('custom system instruction');
        expect(after.maxContextTokens).toBe(128000);
        expect(after.retryCount).toBe(5);
        expect(after.customHeadersEnabled).toBe(true);
        expect(after.customHeaders).toEqual([
            { key: 'X-User', value: 'alice', enabled: true },
        ]);
        expect(after.tokenCountMethod).toBe('gemini');
    });

    test('类型变更时显式传入的 updates 覆盖新类型默认值', async () => {
        const { manager, id } = await createGeminiManager();

        await manager.updateConfig(id, {
            type: 'openai-responses',
            url: 'https://my-proxy.example.com/v1',
            apiKey: 'sk-proxy-key'
        });

        const after = await manager.getConfig(id) as any;
        expect(after.type).toBe('openai-responses');
        expect(after.url).toBe('https://my-proxy.example.com/v1');
        expect(after.apiKey).toBe('sk-proxy-key');
        // 未显式传入的类型特有字段仍取新类型默认值
        expect(after.options.max_output_tokens).toBe(65535);
    });

    test('类型变更时自定义 URL 与 API Key 保留（无需用户重写端点/密钥）', async () => {
        const { manager, id } = await createGeminiManager();

        // 用户自定义端点（中转站/代理），非 gemini 默认端点
        await manager.updateConfig(id, { url: 'https://my-proxy.example.com/gemini' });

        await manager.updateConfig(id, { type: 'openai' });

        const after = await manager.getConfig(id) as any;
        expect(after.type).toBe('openai');
        // 自定义端点跨类型保留；apiKey 保留
        expect(after.url).toBe('https://my-proxy.example.com/gemini');
        expect(after.apiKey).toBe('AIza-test-key');
        // 类型特有字段仍重置（模型列表/选项不残留）
        expect(after.model).toBe('');
        expect(after.models).toEqual([]);
        expect(after.options.thinkingConfig).toBeUndefined();
    });

    test('openai -> openai-responses 互转：默认 URL 与选项同步切换', async () => {
        const manager = new ConfigManager(new MemoryStorageAdapter());
        const id = await manager.createConfig({
            name: 'OpenAI',
            type: 'openai',
        } as any);

        await manager.updateConfig(id, { type: 'openai-responses' });
        const after = await manager.getConfig(id) as any;
        expect(after.url).toBe('https://api.openai.com/v1');
        expect(after.options.max_output_tokens).toBe(65535);
        expect(after.options.max_tokens).toBeUndefined();
        expect(after.options.reasoning.effort).toBe('medium');
    });

    test('普通更新深合并 options，保留未更新的兄弟字段且 type 不变', async () => {
        const { manager, id } = await createGeminiManager();

        await manager.updateConfig(id, { name: '改名后', options: { stream: false } });

        const after = await manager.getConfig(id) as any;
        expect(after.type).toBe('gemini');
        expect(after.name).toBe('改名后');
        expect(after.options).toMatchObject({
            stream: false,
            temperature: 0.7,
            maxOutputTokens: 8192,
        });
        expect(after.options.thinkingConfig).toBeDefined();
    });

    test('显式传相同 type 不触发重建，类型特有字段保留', async () => {
        const { manager, id } = await createGeminiManager();

        await manager.updateConfig(id, { type: 'gemini', name: '还是 Gemini' });

        const after = await manager.getConfig(id) as any;
        expect(after.type).toBe('gemini');
        expect(after.name).toBe('还是 Gemini');
        // 未触发重建：原 type 特有字段与默认 URL 原样保留
        expect(after.url).toBe('https://generativelanguage.googleapis.com/v1beta');
        expect(after.options.thinkingConfig).toBeDefined();
    });

    test('openai -> anthropic：OpenAI 特有字段重置，通用 OpenCode 会话兼容保留', async () => {
        const manager = new ConfigManager(new MemoryStorageAdapter());
        const id = await manager.createConfig({
            name: 'DeepSeek',
            type: 'openai',
            deepSeekUserIdEnabled: true,
            pdfAttachmentEnabled: true,
            openCodeSessionEnabled: true,
            useAuthorizationHeader: true,
            options: {
                reasoning: { effort: 'high', summaryEnabled: true, summary: 'auto' },
                frequency_penalty: 0.5,
                presence_penalty: 0.5,
            },
            optionsEnabled: {
                frequency_penalty: true,
                presence_penalty: true,
                reasoning: true,
            },
        } as any);

        await manager.updateConfig(id, { type: 'anthropic' });

        const after = await manager.getConfig(id) as any;
        expect(after.type).toBe('anthropic');
        // openai 特有字段不再残留
        expect(after.deepSeekUserIdEnabled).toBeUndefined();
        expect(after.pdfAttachmentEnabled).toBeUndefined();
        expect(after.useAuthorizationHeader).toBeUndefined();
        expect(after.openCodeSessionEnabled).toBe(true);
        expect(after.options.frequency_penalty).toBeUndefined();
        expect(after.options.presence_penalty).toBeUndefined();
        expect(after.optionsEnabled.frequency_penalty).toBeUndefined();
        // anthropic 特有默认值就位
        expect(after.options.thinking).toEqual(expect.objectContaining({ budget_tokens: 10000 }));
        expect(after.optionsEnabled.thinking).toBe(false);
    });

    test('配置不存在时抛错（与类型变更无关）', async () => {
        const manager = new ConfigManager(new MemoryStorageAdapter());
        await expect(manager.updateConfig('non-existent', { type: 'openai' })).rejects.toThrow();
    });

    test('类型变更传非法 type 时拒绝，且原配置保持不变', async () => {
        const { manager, id } = await createGeminiManager();

        await expect(manager.updateConfig(id, { type: 'unknown-type' as any })).rejects.toThrow(
            '不支持的渠道类型'
        );

        const after = await manager.getConfig(id) as any;
        expect(after.type).toBe('gemini');
        expect(after.url).toBe('https://generativelanguage.googleapis.com/v1beta');
    });

    test('createConfig 传非法 type 时拒绝（导入等非 webview 来源）', async () => {
        const manager = new ConfigManager(new MemoryStorageAdapter());
        await expect(manager.createConfig({
            name: 'Bad',
            type: 'not-a-channel' as any,
        } as any)).rejects.toThrow('不支持的渠道类型');
    });
});
