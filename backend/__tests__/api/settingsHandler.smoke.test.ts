/**
 * SettingsHandler smoke 测试（模块化重构回归网）
 *
 * 覆盖点：
 * - 构造：mock settingsManager（getProxySettings 驱动 TokenCountService 代理 URL）
 * - getSettings / updateSettings 基本路径
 * - 错误包装：所有方法把异常统一包装为 { success:false, error:{ code, message } }，
 *   自定义 code 透传、缺失时回退 UNKNOWN_ERROR
 * - 工具列表/配置读写：getToolsList（registry 缺失与正常）、getToolConfig（专用分支与
 *   未知工具）、updateToolConfig（专用方法分发与通用分发）
 *
 * 依赖全部用内联 mock（settingsManager / toolRegistry 均为 jest.fn 对象），
 * 不依赖任何共享 fixture。
 */

import { SettingsHandler } from '../../modules/api/settings/SettingsHandler';
import type { SettingsManager } from '../../modules/settings/SettingsManager';

function createSettingsManagerMock(settings: any = { theme: 'dark', language: 'en' }): SettingsManager {
    return {
        getProxySettings: jest.fn(() => ({ enabled: false })),
        getSettings: jest.fn(() => settings),
        updateSettings: jest.fn(),
        setActiveChannelId: jest.fn(),
        setToolEnabled: jest.fn(),
        setToolsEnabled: jest.fn(),
        setDefaultToolMode: jest.fn(),
        updateUISettings: jest.fn(),
        updateProxySettings: jest.fn(),
        reset: jest.fn(),
        isToolEnabled: jest.fn(() => true),
        getListFilesConfig: jest.fn(() => ({ maxResults: 100 })),
        getToolsConfig: jest.fn(() => ({})),
        updateListFilesConfig: jest.fn(),
        updateFindFilesConfig: jest.fn(),
        updateToolConfig: jest.fn()
    } as any;
}

function createToolRegistryMock() {
    return {
        getAllTools: jest.fn(() => [
            { declaration: { name: 'read_file', description: 'Read files', category: 'files' } },
            { declaration: { name: 'write_file', description: 'Write files', category: 'files' } }
        ]),
        getTool: jest.fn(() => undefined)
    };
}

describe('SettingsHandler smoke', () => {
    it('构造函数读取 proxy 设置并成功创建实例（含代理 URL 分支）', () => {
        const sm = createSettingsManagerMock();
        (sm.getProxySettings as jest.Mock).mockReturnValue({ enabled: true, url: 'http://127.0.0.1:7890' });
        const handler = new SettingsHandler(sm);
        expect(handler).toBeInstanceOf(SettingsHandler);
        expect(sm.getProxySettings).toHaveBeenCalled();
    });

    it('getSettings 成功返回 settings', async () => {
        const sm = createSettingsManagerMock({ theme: 'dark' });
        const handler = new SettingsHandler(sm);

        const result = await handler.getSettings({});

        expect(result.success).toBe(true);
        expect((result as any).settings).toEqual({ theme: 'dark' });
    });

    it('getSettings 异常包装为 { success:false, error:{ code, message } }，自定义 code 透传', async () => {
        const sm = createSettingsManagerMock();
        (sm.getSettings as jest.Mock).mockImplementation(() => {
            const err: any = new Error('storage broken');
            err.code = 'STORAGE_READ_FAILED';
            throw err;
        });
        const handler = new SettingsHandler(sm);

        const result = await handler.getSettings({});

        expect(result.success).toBe(false);
        expect((result as any).error).toEqual({ code: 'STORAGE_READ_FAILED', message: 'storage broken' });
    });

    it('updateSettings 成功：调用 updateSettings 并返回最新 settings', async () => {
        const sm = createSettingsManagerMock();
        const handler = new SettingsHandler(sm);

        const result = await handler.updateSettings({ settings: { theme: 'light' } } as any);

        expect(sm.updateSettings).toHaveBeenCalledWith({ theme: 'light' });
        expect(result.success).toBe(true);
        expect((result as any).settings).toEqual({ theme: 'dark', language: 'en' });
    });

    it('updateSettings 异常无 code 时回退 UNKNOWN_ERROR', async () => {
        const sm = createSettingsManagerMock();
        (sm.updateSettings as jest.Mock).mockRejectedValue(new Error('boom'));
        const handler = new SettingsHandler(sm);

        const result = await handler.updateSettings({ settings: {} });

        expect(result.success).toBe(false);
        expect((result as any).error.code).toBe('UNKNOWN_ERROR');
        expect((result as any).error.message).toBe('boom');
    });

    it('setActiveChannel 成功且透传 channelId', async () => {
        const sm = createSettingsManagerMock();
        const handler = new SettingsHandler(sm);

        const result = await handler.setActiveChannel({ channelId: 'ch-1' });

        expect(sm.setActiveChannelId).toHaveBeenCalledWith('ch-1');
        expect(result.success).toBe(true);
    });

    it('setToolEnabled 成功且透传参数', async () => {
        const sm = createSettingsManagerMock();
        const handler = new SettingsHandler(sm);

        const result = await handler.setToolEnabled({ toolName: 'read_file', enabled: false });

        expect(sm.setToolEnabled).toHaveBeenCalledWith('read_file', false);
        expect(result.success).toBe(true);
    });

    it('setToolsEnabled / setDefaultToolMode 成功', async () => {
        const sm = createSettingsManagerMock();
        const handler = new SettingsHandler(sm);

        const batch = await handler.setToolsEnabled({ toolsEnabled: { read_file: true } });
        expect(sm.setToolsEnabled).toHaveBeenCalledWith({ read_file: true });
        expect(batch.success).toBe(true);

        const mode = await handler.setDefaultToolMode({ mode: 'function_call' });
        expect(sm.setDefaultToolMode).toHaveBeenCalledWith('function_call');
        expect(mode.success).toBe(true);
    });

    it('updateUISettings 成功并联动语言设置（不抛错）', async () => {
        const sm = createSettingsManagerMock();
        const handler = new SettingsHandler(sm);

        const result = await handler.updateUISettings({ uiSettings: { language: 'zh-CN' } });

        expect(sm.updateUISettings).toHaveBeenCalledWith({ language: 'zh-CN' });
        expect(result.success).toBe(true);
    });

    it('updateProxySettings / resetSettings 成功', async () => {
        const sm = createSettingsManagerMock();
        const handler = new SettingsHandler(sm);

        const proxy = await handler.updateProxySettings({ proxySettings: { enabled: true, url: 'http://p' } });
        expect(sm.updateProxySettings).toHaveBeenCalledWith({ enabled: true, url: 'http://p' });
        expect(proxy.success).toBe(true);

        const reset = await handler.resetSettings({});
        expect(sm.reset).toHaveBeenCalled();
        expect(reset.success).toBe(true);
    });

    it('getToolsList：无 toolRegistry 返回 TOOL_REGISTRY_NOT_AVAILABLE', async () => {
        const sm = createSettingsManagerMock();
        const handler = new SettingsHandler(sm);

        const result = await handler.getToolsList({});

        expect(result.success).toBe(false);
        expect((result as any).error.code).toBe('TOOL_REGISTRY_NOT_AVAILABLE');
    });

    it('getToolsList：有 toolRegistry 时返回工具列表与 enabled 标志', async () => {
        const sm = createSettingsManagerMock();
        const registry = createToolRegistryMock();
        const handler = new SettingsHandler(sm, registry as any);

        const result = await handler.getToolsList({});

        expect(result.success).toBe(true);
        const tools = (result as any).tools as Array<{ name: string; enabled: boolean }>;
        expect(tools).toHaveLength(2);
        expect(tools[0].name).toBe('read_file');
        expect(tools[0].enabled).toBe(true);
        expect(sm.isToolEnabled).toHaveBeenCalledWith('read_file');
    });

    it('getToolConfig：list_files 走专用分支，未知工具返回 TOOL_NOT_FOUND', async () => {
        const sm = createSettingsManagerMock();
        const registry = createToolRegistryMock();
        const handler = new SettingsHandler(sm, registry as any);

        const listFiles = await handler.getToolConfig({ toolName: 'list_files' });
        expect(listFiles.success).toBe(true);
        expect((listFiles as any).config).toEqual({ maxResults: 100 });

        const unknown = await handler.getToolConfig({ toolName: 'no_such_tool' });
        expect(unknown.success).toBe(false);
        expect((unknown as any).error.code).toBe('TOOL_NOT_FOUND');
    });

    it('updateToolConfig：专用方法分发与通用分发，异常统一包装', async () => {
        const sm = createSettingsManagerMock();
        const handler = new SettingsHandler(sm);

        const special = await handler.updateToolConfig({ toolName: 'list_files', config: { maxResults: 50 } });
        expect(sm.updateListFilesConfig).toHaveBeenCalledWith({ maxResults: 50 });
        expect(special.success).toBe(true);

        const generic = await handler.updateToolConfig({ toolName: 'my_tool', config: { a: 1 } });
        expect(sm.updateToolConfig).toHaveBeenCalledWith('my_tool', { a: 1 });
        expect(generic.success).toBe(true);

        (sm.updateToolConfig as jest.Mock).mockRejectedValue(new Error('config invalid'));
        const failed = await handler.updateToolConfig({ toolName: 'my_tool', config: {} });
        expect(failed.success).toBe(false);
        expect((failed as any).error.message).toBe('config invalid');
    });
});
