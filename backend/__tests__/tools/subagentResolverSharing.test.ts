/**
 * H-1 回归测试：子代理路径 ToolDeclarationResolver 共享与监听器释放。
 *
 * 背景：resolveSubAgentAvailableTools 过去每次 run 都 new ToolDeclarationResolver，
 * 构造函数向 McpManager 单例注册 3 个事件监听器且从不释放 → 监听器随 run 数无界累积。
 * 修复后改为按依赖引用共享实例（getSharedToolResolver），并支持 dispose() 释放。
 *
 * 覆盖：
 * - 相同依赖组合多次调用只注册一次监听器（addEventListener 恒为 3 次）；
 * - clearSharedToolResolvers 释放全部监听器（removeEventListener 各调用一次）；
 * - 不同依赖组合（不同 mcpManager 实例）各自创建实例，超容量时淘汰并 dispose 最旧。
 */

import { resolveSubAgentAvailableTools, clearSharedToolResolvers } from '../../tools/subagents/executor';
import type { SubAgentConfig, SubAgentExecutorContext } from '../../tools/subagents';
import { createSubAgentConfig } from '../__fixtures__/subagentFixtures';

/** 最小 MCP 事件宿主：只记录 add/remove 调用，模拟 McpManager 事件系统 */
function createMcpManagerMock(): {
    addEventListener: jest.Mock;
    removeEventListener: jest.Mock;
    getAllTools: jest.Mock;
} {
    return {
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
        getAllTools: jest.fn(() => [])
    };
}


function createContext(mcpManager: ReturnType<typeof createMcpManagerMock>): SubAgentExecutorContext {
    return {
        channelManager: {} as any,
        toolRegistry: { getAllDeclarations: () => [] } as any,
        configManager: {
            getConfig: async () => ({
                id: 'channel_1',
                name: 'Test Channel',
                type: 'custom',
                toolMode: 'function_call',
                multimodalToolsEnabled: false
            })
        } as any,
        mcpManager: mcpManager as any
    };
}

describe('子代理路径 ToolDeclarationResolver 共享（监听器不泄漏）', () => {
    beforeEach(() => {
        clearSharedToolReserversSafe();
    });

    // 模块级缓存可能已被其他测试用例填充；重置后从干净状态开始
    function clearSharedToolReserversSafe(): void {
        clearSharedToolResolvers();
    }

    test('相同依赖组合多次调用：MCP 监听器只注册一次（3 个），不随调用次数增长', async () => {
        const mcpManager = createMcpManagerMock();
        const context = createContext(mcpManager);

        await resolveSubAgentAvailableTools(createSubAgentConfig(), context);
        await resolveSubAgentAvailableTools(createSubAgentConfig(), context);
        await resolveSubAgentAvailableTools(createSubAgentConfig(), context);

        // 3 次调用共享同一实例：addEventListener 只被调用 3 次（每个事件类型一次）
        expect(mcpManager.addEventListener).toHaveBeenCalledTimes(3);
        const eventTypes = mcpManager.addEventListener.mock.calls.map(call => call[0]);
        expect(eventTypes.sort()).toEqual(['server:capabilities_updated', 'server:connected', 'server:disconnected']);
        // 没有任何 removeEventListener 被调用（实例仍被共享缓存持有）
        expect(mcpManager.removeEventListener).not.toHaveBeenCalled();
    });

    test('clearSharedToolResolvers 释放全部监听器（dispose 移除）', async () => {
        const mcpManager = createMcpManagerMock();
        const context = createContext(mcpManager);

        await resolveSubAgentAvailableTools(createSubAgentConfig(), context);
        expect(mcpManager.addEventListener).toHaveBeenCalledTimes(3);

        clearSharedToolResolvers();

        // dispose 应为每个已注册事件调用一次 removeEventListener
        expect(mcpManager.removeEventListener).toHaveBeenCalledTimes(3);
        const removedTypes = mcpManager.removeEventListener.mock.calls.map(call => call[0]);
        expect(removedTypes.sort()).toEqual(['server:capabilities_updated', 'server:connected', 'server:disconnected']);
    });

    test('不同依赖组合各自创建实例；超容量时淘汰最旧并 dispose', async () => {
        const mcpA = createMcpManagerMock();
        const mcpB = createMcpManagerMock();
        const mcpC = createMcpManagerMock();
        const mcpD = createMcpManagerMock();
        const mcpE = createMcpManagerMock();

        await resolveSubAgentAvailableTools(createSubAgentConfig(), createContext(mcpA));
        await resolveSubAgentAvailableTools(createSubAgentConfig(), createContext(mcpB));
        await resolveSubAgentAvailableTools(createSubAgentConfig(), createContext(mcpC));
        await resolveSubAgentAvailableTools(createSubAgentConfig(), createContext(mcpD));
        // 第 5 个实例：容量 4 超限 → 最旧的 mcpA 对应实例被 dispose
        await resolveSubAgentAvailableTools(createSubAgentConfig(), createContext(mcpE));

        expect(mcpA.removeEventListener).toHaveBeenCalledTimes(3);
        expect(mcpB.removeEventListener).not.toHaveBeenCalled();
        expect(mcpC.removeEventListener).not.toHaveBeenCalled();
        expect(mcpD.removeEventListener).not.toHaveBeenCalled();
        expect(mcpE.removeEventListener).not.toHaveBeenCalled();

        clearSharedToolResolvers();
        expect(mcpB.removeEventListener).toHaveBeenCalledTimes(3);
        expect(mcpC.removeEventListener).toHaveBeenCalledTimes(3);
        expect(mcpD.removeEventListener).toHaveBeenCalledTimes(3);
        expect(mcpE.removeEventListener).toHaveBeenCalledTimes(3);
    });
});
