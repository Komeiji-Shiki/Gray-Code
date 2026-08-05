/**
 * McpManager 工具列表变更通知测试
 *
 * 覆盖：
 * - 收到 notifications/tools/list_changed 后刷新工具缓存并更新 capabilities
 * - 收到 notifications/resources/list_changed / prompts/list_changed 后刷新对应列表
 * - 刷新失败仅记日志，不重连、不广播事件
 * - 无关通知方法不触发刷新
 */
import { McpManager } from '../../modules/mcp/McpManager';
import { StdioMcpClient } from '../../modules/mcp/StdioClient';
import { InMemoryMcpStorageAdapter } from '../../modules/mcp/storage';

function makeTestInput(overrides: Record<string, any> = {}) {
    return {
        name: 'List Server',
        transport: {
            type: 'stdio' as const,
            command: 'echo',
            args: ['hello'],
        },
        enabled: true,
        autoConnect: false,
        ...overrides,
    };
}

/** 让微任务队列排空（通知处理是异步的，需要等它完成） */
const flushMicrotasks = () => new Promise<void>(resolve => setTimeout(resolve, 0));

describe('McpManager tools list changed notification', () => {
    let storage: InMemoryMcpStorageAdapter;
    let manager: McpManager;

    beforeEach(() => {
        storage = new InMemoryMcpStorageAdapter();
        manager = new McpManager(storage);
    });

    afterEach(async () => {
        jest.restoreAllMocks();
        try {
            await manager.dispose();
        } catch {
            // 忽略清理失败
        }
    });

    /** 建立连接并返回被管理的 client 实例（用于触发 notification 事件） */
    async function connectAndGetClient(id: string): Promise<StdioMcpClient> {
        jest.spyOn(StdioMcpClient.prototype, 'connect').mockResolvedValue(undefined);
        jest.spyOn(StdioMcpClient.prototype, 'disconnect').mockResolvedValue(undefined);

        await manager.initialize();
        await manager.createServer(makeTestInput(), id);
        await manager.connect(id);

        const client = (manager as any).clients.get(id) as StdioMcpClient;
        expect(client).toBeDefined();
        return client;
    }

    it('should refresh tools and update capabilities on tools/list_changed', async () => {
        const initialTools = [{ name: 'old_tool', description: 'old', inputSchema: { type: 'object' as const } }];
        const refreshedTools = [
            { name: 'old_tool', description: 'old', inputSchema: { type: 'object' as const } },
            { name: 'new_tool', description: 'new', inputSchema: { type: 'object' as const } },
        ];
        let current = initialTools;
        jest.spyOn(StdioMcpClient.prototype, 'getTools').mockImplementation(() => current);
        jest.spyOn(StdioMcpClient.prototype, 'getResources').mockReturnValue([]);
        jest.spyOn(StdioMcpClient.prototype, 'getPrompts').mockReturnValue([]);
        const refreshListsSpy = jest.spyOn(StdioMcpClient.prototype, 'refreshLists')
            .mockImplementation(async () => { current = refreshedTools; });

        const client = await connectAndGetClient('list_srv');

        // 初始工具列表
        expect(manager.getAllTools()[0].tools!.map(t => t.name)).toEqual(['old_tool']);

        // 订阅 capabilities 更新事件
        const updatedEvents: any[] = [];
        manager.addEventListener('server:capabilities_updated', (e) => updatedEvents.push(e));

        // 模拟服务器推送 tools/list_changed
        client.emit('notification', 'notifications/tools/list_changed', {});
        await flushMicrotasks();

        expect(refreshListsSpy).toHaveBeenCalledTimes(1);
        // 缓存已刷新：ToolDeclarationResolver 下一次 resolve 将使用新数据
        expect(manager.getAllTools()[0].tools!.map(t => t.name)).toEqual(['old_tool', 'new_tool']);
        expect(updatedEvents).toHaveLength(1);
        expect(updatedEvents[0]).toMatchObject({
            type: 'server:capabilities_updated',
            serverId: 'list_srv',
            data: { method: 'notifications/tools/list_changed' }
        });
    });

    it('should refresh resources and prompts on their list_changed notifications', async () => {
        const initialResources = [{ uri: 'file:///a.txt', name: 'a' }];
        const initialPrompts = [{ name: 'p1', description: 'd1' }];
        let currentResources = initialResources;
        let currentPrompts = initialPrompts;
        jest.spyOn(StdioMcpClient.prototype, 'getTools').mockReturnValue([]);
        jest.spyOn(StdioMcpClient.prototype, 'getResources').mockImplementation(() => currentResources);
        jest.spyOn(StdioMcpClient.prototype, 'getPrompts').mockImplementation(() => currentPrompts);
        jest.spyOn(StdioMcpClient.prototype, 'refreshLists')
            .mockImplementation(async () => {
                currentResources = [{ uri: 'file:///a.txt', name: 'a' }, { uri: 'file:///b.txt', name: 'b' }];
                currentPrompts = [{ name: 'p1', description: 'd1' }, { name: 'p2', description: 'd2' }];
            });

        const client = await connectAndGetClient('res_srv');

        const updatedEvents: any[] = [];
        manager.addEventListener('server:capabilities_updated', (e) => updatedEvents.push(e));

        client.emit('notification', 'notifications/resources/list_changed', {});
        await flushMicrotasks();
        expect(manager.getAllResources()[0].resources!.map(r => r.uri)).toEqual(['file:///a.txt', 'file:///b.txt']);

        client.emit('notification', 'notifications/prompts/list_changed', {});
        await flushMicrotasks();
        expect(manager.getAllPrompts()[0].prompts!.map(p => p.name)).toEqual(['p1', 'p2']);

        expect(updatedEvents).toHaveLength(2);
    });

    it('should not reconnect and only log when refresh fails', async () => {
        jest.spyOn(StdioMcpClient.prototype, 'getTools').mockReturnValue([
            { name: 'stale_tool', description: 'stale', inputSchema: { type: 'object' as const } },
        ]);
        jest.spyOn(StdioMcpClient.prototype, 'getResources').mockReturnValue([]);
        jest.spyOn(StdioMcpClient.prototype, 'getPrompts').mockReturnValue([]);
        const refreshListsSpy = jest.spyOn(StdioMcpClient.prototype, 'refreshLists')
            .mockRejectedValue(new Error('server unreachable'));

        // 刷新失败时应打印日志
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

        const client = await connectAndGetClient('fail_srv');
        // connect 在 connectAndGetClient 中已被 mock 并调用过，需清空历史再断言"未再被调用"
        const connectSpy = jest.spyOn(StdioMcpClient.prototype, 'connect').mockClear();

        const updatedEvents: any[] = [];
        manager.addEventListener('server:capabilities_updated', (e) => updatedEvents.push(e));

        client.emit('notification', 'notifications/tools/list_changed', {});
        await flushMicrotasks();

        expect(refreshListsSpy).toHaveBeenCalledTimes(1);
        // 不重连（connect 未被再次调用）
        expect(connectSpy).not.toHaveBeenCalled();
        // 不广播能力更新事件
        expect(updatedEvents).toHaveLength(0);
        // 旧缓存保留
        expect(manager.getAllTools()[0].tools!.map(t => t.name)).toEqual(['stale_tool']);
        // 失败仅记日志
        expect(errorSpy).toHaveBeenCalled();
        expect(String(errorSpy.mock.calls[0][1])).toContain('server unreachable');

        errorSpy.mockRestore();
    });

    it('should ignore unrelated notification methods', async () => {
        jest.spyOn(StdioMcpClient.prototype, 'getTools').mockReturnValue([
            { name: 't1', description: 'd', inputSchema: { type: 'object' as const } },
        ]);
        jest.spyOn(StdioMcpClient.prototype, 'getResources').mockReturnValue([]);
        jest.spyOn(StdioMcpClient.prototype, 'getPrompts').mockReturnValue([]);
        const refreshListsSpy = jest.spyOn(StdioMcpClient.prototype, 'refreshLists')
            .mockResolvedValue(undefined);

        const client = await connectAndGetClient('other_srv');

        const updatedEvents: any[] = [];
        manager.addEventListener('server:capabilities_updated', (e) => updatedEvents.push(e));

        client.emit('notification', 'notifications/message', {});
        await flushMicrotasks();

        expect(refreshListsSpy).not.toHaveBeenCalled();
        expect(updatedEvents).toHaveLength(0);
    });
});
