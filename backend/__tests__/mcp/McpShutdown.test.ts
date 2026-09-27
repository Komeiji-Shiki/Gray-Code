import { McpManager } from '../../modules/mcp/McpManager';
import { McpClient } from '../../modules/mcp/McpClient';
import { InMemoryMcpStorageAdapter } from '../../modules/mcp/storage';

let storage: InMemoryMcpStorageAdapter;
let manager: McpManager;
beforeEach(async () => {
    storage = new InMemoryMcpStorageAdapter(); manager = new McpManager(storage); await manager.initialize();
    await manager.createServer({ name: 'fixture', transport: { type: 'stdio', command: 'fixture-only' }, enabled: true, autoConnect: false }, 'fixture');
});
afterEach(async () => { jest.restoreAllMocks(); await manager.dispose(); });

test('断开失败保持错误状态和原客户端，释放失败可再次释放同一对象', async () => {
    const disconnect = jest.fn().mockRejectedValueOnce(new Error('fixture stop failure')).mockResolvedValue(undefined);
    const client = { disconnect };
    (manager as any).clients.set('fixture', client);
    (manager as any).servers.get('fixture').status = 'connected';
    await expect(manager.dispose()).rejects.toThrow('fixture stop failure');
    expect(manager.getServerStatus('fixture')).toBe('error');
    expect((manager as any).clients.get('fixture')).toBe(client);
    await expect(manager.initialize()).rejects.toThrow('closing');
    await expect(manager.connect('fixture')).rejects.toThrow('closing');
    await manager.dispose();
    expect(disconnect).toHaveBeenCalledTimes(2);
    expect((manager as any).clients.size).toBe(0);
    await manager.initialize();
    expect(manager.getServerStatus('fixture')).toBe('disconnected');
});

test('删除连接失败的配置仍要先关闭实际客户端，不能遗失进程归属', async () => {
    const disconnect = jest.fn().mockRejectedValueOnce(new Error('fixture stop failure')).mockResolvedValue(undefined);
    (manager as any).clients.set('fixture', { disconnect });
    (manager as any).servers.get('fixture').status = 'error';
    await expect(manager.deleteServer('fixture')).rejects.toThrow('fixture stop failure');
    expect(await storage.getConfig('fixture')).not.toBeNull();
    await manager.deleteServer('fixture');
    expect(await storage.getConfig('fixture')).toBeNull();
    expect(disconnect).toHaveBeenCalledTimes(2);
});

test('连接错误后的后台清理失败不提前丢弃客户端', async () => {
    jest.spyOn(McpClient.prototype, 'connect').mockResolvedValue(undefined);
    await manager.connect('fixture');
    const client = (manager as any).clients.get('fixture') as McpClient;
    const disconnect = jest.spyOn(client, 'disconnect').mockRejectedValueOnce(new Error('fixture stop failure')).mockResolvedValue(undefined);
    jest.spyOn(console, 'error').mockImplementation(() => {});
    client.emit('error', new Error('fixture connection failure'));
    await new Promise(resolve => setImmediate(resolve));
    expect((manager as any).clients.get('fixture')).toBe(client);
    await manager.dispose();
    expect(disconnect).toHaveBeenCalledTimes(2);
});
