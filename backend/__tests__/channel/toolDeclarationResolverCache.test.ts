/**
 * M-1 回归测试：ToolDeclarationResolver 声明缓存的行为契约。
 *
 * 覆盖：
 * - 相同解析输入（options + 设置指纹 + MCP 版本）命中缓存，不重复构建声明；
 * - options 变化（channelType/allowlist/denylist 等）→ 缓存键变化 → 重建；
 * - 设置指纹变化（toolsEnabled 等）→ 重建；
 * - MCP 工具列表版本事件（server:connected/disconnected/capabilities_updated）→ 失效重建；
 * - dispose() 移除全部 MCP 监听器（配合 executor 共享实例的生命周期管理）。
 */

import { ToolDeclarationResolver } from '../../modules/channel/ToolDeclarationResolver';
import type { ToolDeclaration } from '../../tools/types';

const DECLARATIONS: ToolDeclaration[] = [
    { name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: {} } },
    { name: 'write_file', description: 'Write a file', parameters: { type: 'object', properties: {} } },
    { name: 'search_in_files', description: 'Search files', parameters: { type: 'object', properties: {} } }
];

/** 可触发事件的最小 MCP 管理器 mock */
function createMcpManagerMock() {
    const listeners = new Map<string, Set<(e?: unknown) => void>>();
    return {
        addEventListener: jest.fn((type: string, listener: () => void) => {
            if (!listeners.has(type)) listeners.set(type, new Set());
            listeners.get(type)!.add(listener);
        }),
        removeEventListener: jest.fn((type: string, listener: () => void) => {
            listeners.get(type)?.delete(listener);
        }),
        emit(type: string) {
            for (const listener of listeners.get(type) ?? []) listener();
        },
        getAllTools: jest.fn(() => []),
        listeners
    };
}

function createHarness() {
    const toolRegistry = {
        getDeclarationsBy: jest.fn((_predicate: (name: string) => boolean) => DECLARATIONS.map(d => ({ ...d })))
    };
    const settingsManager = {
        getSettings: jest.fn(() => ({ toolsEnabled: {}, toolAutoExec: {}, toolsConfig: {} })),
        isToolEnabled: jest.fn(() => true),
        getGenerateImageConfig: jest.fn(() => ({}))
    };
    const mcpManager = createMcpManagerMock();
    const resolver = new ToolDeclarationResolver(toolRegistry as any, settingsManager as any, mcpManager as any);
    return { resolver, toolRegistry, settingsManager, mcpManager };
}

const BASE_OPTIONS = {
    channelType: 'openai' as const,
    toolMode: 'function_call' as const,
    multimodalEnabled: false
};

describe('M-1: ToolDeclarationResolver 声明缓存', () => {
    it('相同输入命中缓存：第二次 resolve 不重复构建（getDeclarationsBy 只调用一次）', () => {
        const { resolver, toolRegistry } = createHarness();
        const first = resolver.resolve(BASE_OPTIONS);
        const second = resolver.resolve(BASE_OPTIONS);
        expect(first?.length).toBe(3);
        expect(second?.length).toBe(3);
        expect(toolRegistry.getDeclarationsBy).toHaveBeenCalledTimes(1);
    });

    it('options 变化（channelType / allowlist）→ 缓存键变化 → 重建', () => {
        const { resolver, toolRegistry } = createHarness();
        resolver.resolve(BASE_OPTIONS);
        resolver.resolve({ ...BASE_OPTIONS, channelType: 'anthropic' });
        resolver.resolve({ ...BASE_OPTIONS, allowlist: ['read_file'] });
        expect(toolRegistry.getDeclarationsBy).toHaveBeenCalledTimes(3);
    });

    it('设置指纹变化（toolsEnabled）→ 重建', () => {
        const { resolver, toolRegistry, settingsManager } = createHarness();
        resolver.resolve(BASE_OPTIONS);
        settingsManager.getSettings.mockReturnValue({ toolsEnabled: { read_file: true }, toolAutoExec: {}, toolsConfig: {} });
        resolver.resolve(BASE_OPTIONS);
        expect(toolRegistry.getDeclarationsBy).toHaveBeenCalledTimes(2);
    });

    it('MCP 工具列表版本事件（connected/disconnected/capabilities_updated）→ 失效重建', () => {
        const { resolver, toolRegistry, mcpManager } = createHarness();
        resolver.resolve(BASE_OPTIONS);
        resolver.resolve(BASE_OPTIONS);
        expect(toolRegistry.getDeclarationsBy).toHaveBeenCalledTimes(1);

        mcpManager.emit('server:connected');
        resolver.resolve(BASE_OPTIONS);
        mcpManager.emit('server:capabilities_updated');
        resolver.resolve(BASE_OPTIONS);
        mcpManager.emit('server:disconnected');
        resolver.resolve(BASE_OPTIONS);

        // 初始 1 次 + 3 次事件后各重建 1 次
        expect(toolRegistry.getDeclarationsBy).toHaveBeenCalledTimes(4);
    });

    it('dispose() 移除全部 MCP 监听器（3 个事件类型各一次）', () => {
        const { resolver, mcpManager } = createHarness();
        resolver.dispose();
        expect(mcpManager.removeEventListener).toHaveBeenCalledTimes(3);
        const removedTypes = mcpManager.removeEventListener.mock.calls.map(call => call[0]).sort();
        expect(removedTypes).toEqual(['server:capabilities_updated', 'server:connected', 'server:disconnected']);
        // 事件派发不再触发版本递增（监听器已移除）
        const callsBefore = (mcpManager.listeners.get('server:connected')?.size ?? 0);
        expect(callsBefore).toBe(0);
    });
});
