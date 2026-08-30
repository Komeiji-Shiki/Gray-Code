/**
 * 设置导入后的刷新通知回归测试
 *
 * 背景：渠道 / MCP / VSCode 设置导入写入的是后端数据，而 webview 侧这些视图是挂载时
 * 拉取的快照（渠道列表还有模块级预加载缓存），导入完成后没有任何机制让它们重拉——
 * 用户必须重启插件才能看到刚导入的渠道配置。
 * 修复：importSettings handler 在导入成功后按「实际变更的域」广播刷新命令
 * （channels.configChanged / mcp.configChanged / settings.imported），
 * 渠道用不带 configId 的载荷区分「外部批量变更」，让设置页渠道列表也敢重拉。
 * 本测试锁住「按计数选择广播域、无变更与取消时不广播」的行为，防止回归。
 */

import { importSettings } from '../../../webview/handlers/SettingsTransferHandlers';
import { PUSH_MESSAGE_NAMES } from '../../../shared/protocol';
import type { HandlerContext } from '../../../webview/types';
import { importSettingsFromFile } from '../../../webview/utils/settingsTransfer';

jest.mock('../../../webview/utils/settingsTransfer', () => ({
    toSettingsTransferSource: jest.fn((ctx: unknown) => ctx),
    importSettingsFromFile: jest.fn(),
    exportSettingsToFile: jest.fn(),
}));

const mockedImport = importSettingsFromFile as jest.MockedFunction<typeof importSettingsFromFile>;

function createHandlerContext() {
    const postMessage = jest.fn(() => true);
    const sendResponse = jest.fn();
    const sendError = jest.fn();

    const ctx = {
        postMessage,
        sendResponse,
        sendError,
    } as unknown as HandlerContext;

    return { ctx, postMessage, sendResponse, sendError };
}

/** 构造一次导入结果（默认所有域均未变更） */
function importOutcome(imported: {
    vscodeSettings?: boolean;
    channelConfigs?: number;
    mcpServers?: number;
    skills?: number;
}) {
    return {
        cancelled: false as const,
        result: {
            success: true,
            imported: {
                vscodeSettings: imported.vscodeSettings ?? false,
                channelConfigs: imported.channelConfigs ?? 0,
                mcpServers: imported.mcpServers ?? 0,
                skills: imported.skills ?? 0,
            },
            errors: [],
        },
    };
}

function command(name: string) {
    return { type: PUSH_MESSAGE_NAMES.command, command: name, data: {} };
}

beforeEach(() => {
    mockedImport.mockReset();
});

describe('importSettings 按域广播刷新通知', () => {
    test('导入渠道配置 >0：推送不带 configId 的 channels.configChanged', async () => {
        mockedImport.mockResolvedValue(importOutcome({ channelConfigs: 2 }));
        const { ctx, postMessage } = createHandlerContext();

        await importSettings({ overwrite: true }, 'req-1', ctx);

        // 不带 configId = 「外部批量变更」语义：设置页据此区分自身单次编辑，避免重复全量重拉
        expect(postMessage).toHaveBeenCalledWith(
            command(PUSH_MESSAGE_NAMES['channels.configChanged'])
        );
    });

    test('导入 MCP 服务器 >0：推送 mcp.configChanged', async () => {
        mockedImport.mockResolvedValue(importOutcome({ mcpServers: 1 }));
        const { ctx, postMessage } = createHandlerContext();

        await importSettings({}, 'req-1', ctx);

        expect(postMessage).toHaveBeenCalledWith(
            command(PUSH_MESSAGE_NAMES['mcp.configChanged'])
        );
    });

    test('导入 VSCode 设置：推送 settings.imported', async () => {
        mockedImport.mockResolvedValue(importOutcome({ vscodeSettings: true }));
        const { ctx, postMessage } = createHandlerContext();

        await importSettings({}, 'req-1', ctx);

        expect(postMessage).toHaveBeenCalledWith(
            command(PUSH_MESSAGE_NAMES['settings.imported'])
        );
    });

    test('三类同时变更：三条命令都推送，且响应先于推送送达', async () => {
        mockedImport.mockResolvedValue(
            importOutcome({ channelConfigs: 1, mcpServers: 1, vscodeSettings: true })
        );
        const { ctx, postMessage, sendResponse } = createHandlerContext();

        await importSettings({ overwrite: true }, 'req-1', ctx);

        expect(postMessage).toHaveBeenCalledTimes(3);
        expect(postMessage).toHaveBeenCalledWith(
            command(PUSH_MESSAGE_NAMES['channels.configChanged'])
        );
        expect(postMessage).toHaveBeenCalledWith(
            command(PUSH_MESSAGE_NAMES['mcp.configChanged'])
        );
        expect(postMessage).toHaveBeenCalledWith(
            command(PUSH_MESSAGE_NAMES['settings.imported'])
        );
        // 响应必须是第一条消息：前端结果提示不被重拉请求抢占
        expect(sendResponse).toHaveBeenCalledTimes(1);
    });

    test('只导入 Skills：不广播任何渠道/MCP/设置刷新命令', async () => {
        mockedImport.mockResolvedValue(importOutcome({ skills: 3 }));
        const { ctx, postMessage } = createHandlerContext();

        await importSettings({}, 'req-1', ctx);

        expect(postMessage).not.toHaveBeenCalled();
    });

    test('所有域均无变更（跳过已存在项）：不广播，避免无谓全量重拉', async () => {
        mockedImport.mockResolvedValue(importOutcome({}));
        const { ctx, postMessage, sendResponse } = createHandlerContext();

        await importSettings({}, 'req-1', ctx);

        expect(postMessage).not.toHaveBeenCalled();
        expect(sendResponse).toHaveBeenCalledWith(
            'req-1',
            expect.objectContaining({ success: true })
        );
    });

    test('用户取消选择文件：不广播', async () => {
        mockedImport.mockResolvedValue({ cancelled: true });
        const { ctx, postMessage, sendResponse } = createHandlerContext();

        await importSettings({}, 'req-1', ctx);

        expect(postMessage).not.toHaveBeenCalled();
        expect(sendResponse).toHaveBeenCalledWith('req-1', {
            success: false,
            cancelled: true,
        });
    });

    test('导入抛错：不广播刷新命令', async () => {
        mockedImport.mockRejectedValue(new Error('parse failed'));
        const { ctx, postMessage, sendError } = createHandlerContext();

        await importSettings({}, 'req-1', ctx);

        expect(postMessage).not.toHaveBeenCalled();
        expect(sendError).toHaveBeenCalledWith('req-1', 'IMPORT_ERROR', 'parse failed');
    });
});
