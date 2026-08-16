/**
 * ModelsHandler 模型列表错误透出策略测试。
 *
 * - ModelListRequestError（上游明确错误，message 已在 modelList 层脱敏/截断）：
 *   透出 message 给 UI，用户能直接看到真实失败原因
 * - 未知错误（网络异常/解析失败等）：打日志 + 返回 i18n 通用文案，不透传内部细节
 * - 成功路径：正常返回模型列表
 *
 * 依赖：ConfigManager / SettingsManager 用内联 jest.fn mock；getModels 走真实实现，
 * 网络层以 global.fetch mock 替换（与 modelList 测试同模式）。
 */

import { ModelsHandler } from '../../modules/api';
import type { ConfigManager } from '../../modules/config/ConfigManager';
import type { SettingsManager } from '../../modules/settings/SettingsManager';
import { t } from '../../i18n';

function createConfigManagerMock(config: any): ConfigManager {
    return {
        getConfig: jest.fn(async () => config),
        updateModels: jest.fn(),
        updateConfig: jest.fn()
    } as unknown as ConfigManager;
}

function createSettingsManagerMock(): SettingsManager {
    return {
        getEffectiveProxyUrl: jest.fn(() => undefined)
    } as unknown as SettingsManager;
}

function createGeminiConfig(overrides: any = {}) {
    return {
        id: 'c1',
        name: 'Gemini',
        type: 'gemini',
        enabled: true,
        createdAt: 0,
        updatedAt: 0,
        timeout: 120000,
        url: 'https://generativelanguage.googleapis.com/v1beta',
        apiKey: 'AIza-secret-9',
        model: 'gemini-2.5-pro',
        ...overrides
    };
}

let consoleErrorSpy: jest.SpyInstance;
beforeEach(() => {
    // ModelsHandler 错误分支的日志属预期输出，测试内静音
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
    consoleErrorSpy.mockRestore();
});

describe('ModelsHandler.getModels 错误透出', () => {
    test('成功路径：返回模型列表', async () => {
        const originalFetch = global.fetch;
        global.fetch = jest.fn(async () => new Response(JSON.stringify({
            models: [{ name: 'models/gemini-2.5-pro', displayName: 'Gemini 2.5 Pro' }]
        }), { status: 200 })) as unknown as typeof fetch;
        try {
            const handler = new ModelsHandler(
                createConfigManagerMock(createGeminiConfig({ apiKey: 'AIza-ok-1' })),
                createSettingsManagerMock()
            );
            const result = await handler.getModels({ configId: 'c1' });
            expect(result.success).toBe(true);
            expect(result.models).toEqual([{ id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' }]);
        } finally {
            global.fetch = originalFetch;
        }
    });

    test('ModelListRequestError：脱敏后的 message 透传给 UI', async () => {
        const originalFetch = global.fetch;
        global.fetch = jest.fn(async () => new Response(JSON.stringify({
            error: { message: 'Your API key AIza-secret-9 was reported as leaked. Please use another API key.' }
        }), { status: 403 })) as unknown as typeof fetch;
        try {
            const handler = new ModelsHandler(
                createConfigManagerMock(createGeminiConfig()),
                createSettingsManagerMock()
            );
            const result = await handler.getModels({ configId: 'c1' });
            expect(result.success).toBe(false);
            expect(result.error?.code).toBe('GET_MODELS_FAILED');
            expect(result.error?.message).toBe(
                'HTTP 403: Your API key *** was reported as leaked. Please use another API key.'
            );
            expect(result.error?.message).not.toContain('AIza-secret-9');
        } finally {
            global.fetch = originalFetch;
        }
    });

    test('未知错误：返回 i18n 通用文案，不透传内部错误详情', async () => {
        const configManager = createConfigManagerMock(undefined);
        (configManager.getConfig as jest.Mock).mockRejectedValue(
            new Error('ECONNREFUSED 127.0.0.1:8080 secret-token-xyz')
        );
        const handler = new ModelsHandler(configManager, createSettingsManagerMock());

        const result = await handler.getModels({ configId: 'c1' });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('GET_MODELS_FAILED');
        expect(result.error?.message).toBe(t('modules.api.models.errors.getModelsFailed'));
        expect(result.error?.message).not.toContain('ECONNREFUSED');
        expect(result.error?.message).not.toContain('secret-token-xyz');
    });

    test('配置不存在：返回 CONFIG_NOT_FOUND（不受错误透出策略影响）', async () => {
        const handler = new ModelsHandler(createConfigManagerMock(undefined), createSettingsManagerMock());
        const result = await handler.getModels({ configId: 'missing' });
        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('CONFIG_NOT_FOUND');
        expect(result.error?.message).toBe(t('modules.api.models.errors.configNotFound'));
    });
});
