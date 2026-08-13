/**
 * ConfigHandlers 渠道/模型变更推送回归测试
 *
 * 背景：设置面板添加模型后，输入区/任务卡/工具面板的渠道与模型下拉框不刷新，
 * 必须重启 VSCode（webview 重新挂载）才能看到新模型。
 * 修复：webview 层在渠道/模型写操作成功后向主聊天视图推送
 * `channels.configChanged` 命令，前端据此重新拉取渠道配置。
 * 本测试锁住「写操作成功 → 推送；失败/只读 → 不推送」的行为，防止回归。
 */

import {
    addModels,
    updateConfig,
    createConfig,
    deleteConfig,
    getModels,
    removeModel,
    setActiveModel,
} from '../../../webview/handlers/ConfigHandlers';
import { PUSH_MESSAGE_NAMES } from '../../../shared/protocol';
import type { HandlerContext } from '../../../webview/types';

function createHandlerContext(overrides: Record<string, unknown> = {}) {
    const postMessage = jest.fn(() => true);
    const sendResponse = jest.fn();
    const sendError = jest.fn();

    const ctx: HandlerContext = {
        configManager: {
            getConfig: jest.fn().mockResolvedValue({ id: 'cfg-1', models: [] }),
            updateConfig: jest.fn().mockResolvedValue({ success: true }),
            createConfig: jest.fn().mockResolvedValue('cfg-new'),
            deleteConfig: jest.fn().mockResolvedValue({ success: true }),
            updateModels: jest.fn().mockResolvedValue({ success: true }),
        },
        modelsHandler: {
            getModels: jest.fn().mockResolvedValue({ success: true, models: [] }),
            addModels: jest.fn().mockResolvedValue({ success: true }),
            removeModel: jest.fn().mockResolvedValue({ success: true }),
            setActiveModel: jest.fn().mockResolvedValue({ success: true }),
        },
        postMessage,
        sendResponse,
        sendError,
        ...overrides,
    } as any;

    return { ctx, postMessage, sendResponse, sendError };
}

function changedCommand(configId?: string) {
    return {
        type: PUSH_MESSAGE_NAMES.command,
        command: PUSH_MESSAGE_NAMES['channels.configChanged'],
        data: configId ? { configId } : {},
    };
}

describe('ConfigHandlers 渠道/模型变更推送', () => {
    test('addModels 成功后推送 channels.configChanged（携带 configId）', async () => {
        const { ctx, postMessage } = createHandlerContext();

        await addModels({ configId: 'cfg-1', models: [{ id: 'gpt-x' }] }, 'req-1', ctx);

        expect(postMessage).toHaveBeenCalledWith(changedCommand('cfg-1'));
        expect(ctx.sendResponse).toHaveBeenCalledWith('req-1', { success: true });
    });

    test('updateConfig 成功后推送 channels.configChanged', async () => {
        const { ctx, postMessage } = createHandlerContext();

        await updateConfig({ configId: 'cfg-1', updates: { baseUrl: 'https://x' } }, 'req-1', ctx);

        expect(postMessage).toHaveBeenCalledWith(changedCommand('cfg-1'));
        expect(ctx.sendResponse).toHaveBeenCalledWith('req-1', { success: true });
    });

    test('createConfig 成功后推送 channels.configChanged（configId 为新渠道 ID）', async () => {
        const { ctx, postMessage } = createHandlerContext();

        await createConfig({ name: 'new channel', type: 'openai' }, 'req-1', ctx);

        expect(postMessage).toHaveBeenCalledWith(changedCommand('cfg-new'));
        expect(ctx.sendResponse).toHaveBeenCalledWith('req-1', 'cfg-new');
    });

    test('deleteConfig 成功后推送 channels.configChanged', async () => {
        const { ctx, postMessage } = createHandlerContext();

        await deleteConfig({ configId: 'cfg-1' }, 'req-1', ctx);

        expect(postMessage).toHaveBeenCalledWith(changedCommand('cfg-1'));
        expect(ctx.sendResponse).toHaveBeenCalledWith('req-1', { success: true });
    });

    test('removeModel / setActiveModel 成功后均推送', async () => {
        const { ctx, postMessage } = createHandlerContext();

        await removeModel({ configId: 'cfg-1', modelId: 'gpt-x' }, 'req-1', ctx);
        await setActiveModel({ configId: 'cfg-1', modelId: 'gpt-y' }, 'req-2', ctx);

        expect(postMessage).toHaveBeenCalledTimes(2);
        expect(postMessage).toHaveBeenNthCalledWith(1, changedCommand('cfg-1'));
        expect(postMessage).toHaveBeenNthCalledWith(2, changedCommand('cfg-1'));
    });

    test('写操作失败（success: false）时不推送', async () => {
        const { ctx, postMessage } = createHandlerContext({
            modelsHandler: {
                addModels: jest.fn().mockResolvedValue({
                    success: false,
                    error: { code: 'X', message: 'boom' },
                }),
            },
        });

        await addModels({ configId: 'cfg-1', models: [{ id: 'gpt-x' }] }, 'req-1', ctx);

        expect(postMessage).not.toHaveBeenCalled();
        expect(ctx.sendError).toHaveBeenCalled();
    });

    test('只读操作 getModels 不推送', async () => {
        const { ctx, postMessage } = createHandlerContext();

        await getModels({ configId: 'cfg-1' }, 'req-1', ctx);

        expect(postMessage).not.toHaveBeenCalled();
        expect(ctx.sendResponse).toHaveBeenCalledWith('req-1', []);
    });

    test('非路由上下文（无 postMessage）回退 ctx.view 直投且不抛错', async () => {
        const view = { webview: { postMessage: jest.fn() } };
        const { ctx } = createHandlerContext({
            postMessage: undefined,
            view,
        });

        await addModels({ configId: 'cfg-1', models: [{ id: 'gpt-x' }] }, 'req-1', ctx);

        expect(view.webview.postMessage).toHaveBeenCalledWith(changedCommand('cfg-1'));
        expect(ctx.sendResponse).toHaveBeenCalledWith('req-1', { success: true });
    });
});
