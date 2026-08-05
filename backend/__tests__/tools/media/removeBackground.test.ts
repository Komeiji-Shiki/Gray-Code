/**
 * remove_background 工具测试
 *
 * 覆盖：
 * - mask 缩放使用显式 fit: 'fill'：遮罩无裁切拉伸到原图尺寸，
 *   宽高比不一致时不再因默认 fit: 'cover' 裁切导致主体缺失/错位
 */
import * as vscode from 'vscode';
import { createRemoveBackgroundTool } from '../../../tools/media/remove_background';
import { createProxyFetch } from '../../../modules/channel/proxyFetch';
import { getSharp } from '../../../modules/dependencies';
import { setGlobalSettingsManager } from '../../../core/settingsContext';
import { SettingsManager, MemorySettingsStorage } from '../../../modules/settings';

jest.mock('../../../modules/channel/proxyFetch', () => ({
    createProxyFetch: jest.fn()
}));
jest.mock('../../../modules/dependencies', () => ({
    getSharp: jest.fn()
}));

const mockCreateProxyFetch = createProxyFetch as jest.Mock;
const mockGetSharp = getSharp as jest.Mock;

/**
 * sharp 链式 mock：记录所有 resize 调用参数，metadata 返回 10x20，
 * toBuffer 返回足够大的缓冲区让后续像素循环可以执行
 */
function createSharpMock() {
    const resizeCalls: Array<Array<number | undefined | Record<string, unknown>>> = [];
    const makeInstance = () => {
        const chain: any = {
            resize: (...args: any[]) => {
                resizeCalls.push(args);
                return chain;
            },
            greyscale: () => chain,
            raw: () => chain,
            ensureAlpha: () => chain,
            png: () => chain,
            metadata: async () => ({ width: 10, height: 20 }),
            toBuffer: async () => Buffer.alloc(10 * 20 * 4)
        };
        return chain;
    };
    const factory = jest.fn(() => makeInstance());
    return { factory, resizeCalls };
}

function mockMaskApiResponse() {
    mockCreateProxyFetch.mockReturnValue(async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: {},
        text: async () => '',
        json: async () => ({
            candidates: [{
                content: {
                    parts: [{
                        inlineData: {
                            mimeType: 'image/png',
                            data: Buffer.from('mask-bytes').toString('base64')
                        }
                    }]
                }
            }]
        }),
        body: null
    }));
}

beforeEach(() => {
    mockCreateProxyFetch.mockReset();
    mockGetSharp.mockReset();
    // 单工作区：相对路径解析到工作区内，无需 outside-workspace 审批
    (vscode.workspace as any).workspaceFolders = [
        { uri: vscode.Uri.file('C:/workspace'), name: 'ws', index: 0 }
    ];
    (vscode.workspace.fs.stat as jest.Mock).mockReset();
    (vscode.workspace.fs.stat as jest.Mock).mockResolvedValue({ size: 1024 });
    (vscode.workspace.fs.readFile as jest.Mock).mockReset();
    (vscode.workspace.fs.writeFile as jest.Mock).mockReset();
    (vscode.workspace.fs.createDirectory as jest.Mock).mockReset();
    (vscode.workspace.fs.readFile as jest.Mock).mockResolvedValue(Buffer.from('fake-image-bytes'));
    (vscode.workspace.fs.writeFile as jest.Mock).mockResolvedValue(undefined);
    (vscode.workspace.fs.createDirectory as jest.Mock).mockResolvedValue(undefined);
});

describe('remove_background mask 缩放', () => {
    it('mask resize 显式传入 fit: fill（不被 cover 裁切）', async () => {
        const { factory, resizeCalls } = createSharpMock();
        mockGetSharp.mockResolvedValue(factory);
        mockMaskApiResponse();

        const tool = createRemoveBackgroundTool();
        const result = await tool.handler(
            { image_path: 'in/cat.png', output_path: 'out/cat.png' },
            { config: { apiKey: 'test-key' }, toolId: 't-rmbg' } as any
        );

        expect(result.success).toBe(true);
        // 找到 mask 缩放调用：resize(原图宽, 原图高, 选项)
        expect(resizeCalls.length).toBeGreaterThan(0);
        const maskResize = resizeCalls.find(args => args[0] === 10 && args[1] === 20);
        expect(maskResize).toBeDefined();
        expect(maskResize![2]).toEqual({ fit: 'fill' });
    });
});

describe('remove_background mask_path 写策略', () => {
    it('read=allow / write=deny 时禁止把遮罩写入工作区外路径', async () => {
        const settingsManager = new SettingsManager(new MemorySettingsStorage());
        await settingsManager.initialize();
        // 读策略放行（用户常为浏览外部文件开启），写策略保持默认 deny：
        // mask_path 是写入目标，必须受写策略管控，不能被读策略放行绕过。
        await settingsManager.updateToolConfig('read_file', { outsideWorkspaceAccess: 'allow' });
        await settingsManager.updateToolConfig('write_file', { outsideWorkspaceAccess: 'deny' });
        setGlobalSettingsManager(settingsManager);

        const { factory } = createSharpMock();
        mockGetSharp.mockResolvedValue(factory);
        mockMaskApiResponse();

        const tool = createRemoveBackgroundTool();
        const outsideMask = 'C:/secret/mask.png';
        const result = await tool.handler(
            { image_path: 'in/cat.png', output_path: 'out/cat.png', mask_path: outsideMask },
            { config: { apiKey: 'test-key' }, toolId: 't-rmbg-mask' } as any
        );

        expect(result.success).toBe(true);
        // 工作区内的输出仍正常写入；工作区外遮罩写入必须被写策略拒绝
        const maskWrites = (vscode.workspace.fs.writeFile as jest.Mock).mock.calls.filter(
            (call: any[]) => typeof call[0]?.fsPath === 'string' && call[0].fsPath.toLowerCase().includes('secret')
        );
        expect(maskWrites.length).toBe(0);
    });
});
