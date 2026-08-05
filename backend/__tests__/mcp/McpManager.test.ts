/**
 * McpManager 单测
 *
 * 覆盖：server ID 校验、connect 失败清理、eager registration、cleanSchema 默认值
 */
import { McpManager } from '../../modules/mcp/McpManager';
import { StdioMcpClient } from '../../modules/mcp/StdioClient';
import { InMemoryMcpStorageAdapter } from '../../modules/mcp/storage';

function makeTestInput(overrides: Record<string, any> = {}) {
    return {
        name: 'Test Server',
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

describe('McpManager', () => {
    let storage: InMemoryMcpStorageAdapter;
    let manager: McpManager;

    beforeEach(() => {
        storage = new InMemoryMcpStorageAdapter();
        manager = new McpManager(storage);
    });

    // ==================== #6: validateServerId 禁止双下划线 ====================

    describe('validateServerId', () => {
        it('should accept valid IDs', async () => {
            const result = await manager.validateServerId('my_server');
            expect(result.valid).toBe(true);
        });

        it('should accept IDs with hyphens', async () => {
            const result = await manager.validateServerId('my-server');
            expect(result.valid).toBe(true);
        });

        it('should reject IDs with double underscore', async () => {
            const result = await manager.validateServerId('bad__id');
            expect(result.valid).toBe(false);
        });

        it('should reject duplicate IDs', async () => {
            await manager.validateServerId('test'); // prime
            await storage.saveConfig({
                id: 'test',
                name: 'Existing',
                transport: { type: 'stdio', command: 'echo' },
                enabled: true,
                autoConnect: false,
                createdAt: Date.now(),
                updatedAt: Date.now(),
            });
            // The server is now in storage, need to also register in manager
            await manager.initialize();

            const result = await manager.validateServerId('test');
            expect(result.valid).toBe(false);
        });
    });

    // ==================== #7: cleanSchema 默认值 ====================

    describe('cleanSchema default', () => {
        it('should default cleanSchema to true (undefined means clean)', async () => {
            await manager.initialize();
            const config = {
                id: 'test_cs',
                name: 'CS Test',
                transport: { type: 'stdio' as const, command: 'echo' },
                enabled: true,
                autoConnect: false,
                createdAt: Date.now(),
                updatedAt: Date.now(),
                // cleanSchema 未设置
            };
            await storage.saveConfig(config);

            // 通过重新加载来模拟
            const servers = await manager.listServers();
            const info = servers.find(s => s.config.id === 'test_cs');
            expect(info).toBeDefined();
            // cleanSchema 默认应为 true（undefined !== false）
            expect(info!.config.cleanSchema !== false).toBe(true);
        });

        it('should respect explicit cleanSchema: false', async () => {
            await manager.initialize();
            const config = {
                id: 'test_cs_false',
                name: 'CS False',
                transport: { type: 'stdio' as const, command: 'echo' },
                enabled: true,
                autoConnect: false,
                cleanSchema: false,
                createdAt: Date.now(),
                updatedAt: Date.now(),
            };
            await storage.saveConfig(config);

            const servers = await manager.listServers();
            const info = servers.find(s => s.config.id === 'test_cs_false');
            expect(info).toBeDefined();
            expect(info!.config.cleanSchema).toBe(false);
        });
    });

    // ==================== #3: createServer 与 eager registration ====================

    describe('createServer', () => {
        it('should create a server with disconnected status', async () => {
            await manager.initialize();
            const id = await manager.createServer(makeTestInput({ name: 'My Server' }), 'mysrv');
            expect(id).toBe('mysrv');

            const info = await manager.getServerInfo('mysrv');
            expect(info).not.toBeNull();
            expect(info!.status).toBe('disconnected');
            expect(info!.config.name).toBe('My Server');
        });

        it('should reject serverId with double underscore on creation', async () => {
            await manager.initialize();
            await expect(
                manager.createServer(makeTestInput({ name: 'Bad' }), 'bad__id')
            ).rejects.toThrow();
        });

        it('should generate readable ID from name when customId is omitted', async () => {
            await manager.initialize();
            const id = await manager.createServer(makeTestInput({ name: 'My Server' }));
            expect(id).toBe('my_server');

            const info = await manager.getServerInfo(id);
            expect(info).not.toBeNull();
            expect(info!.config.name).toBe('My Server');
        });

        it('should sanitize name into a valid slug (whitespace, special chars, double underscore)', async () => {
            await manager.initialize();
            const id = await manager.createServer(makeTestInput({ name: '  Foo  Bar!!  ' }));
            expect(id).toBe('foo_bar');
        });

        it('should append numeric suffix when slug is already taken', async () => {
            await manager.initialize();
            const first = await manager.createServer(makeTestInput({ name: 'My Server' }));
            expect(first).toBe('my_server');

            const second = await manager.createServer(makeTestInput({ name: 'My Server' }));
            expect(second).toBe('my_server_2');
        });

        it('should fall back to random ID when name cannot be slugified', async () => {
            await manager.initialize();
            const id = await manager.createServer(makeTestInput({ name: '我的服务器' }));
            expect(id).toMatch(/^mcp_\d+_[a-z0-9]+$/);
        });
    });

    // ==================== #1/#3: connect failure cleanup ====================

    describe('connect failure', () => {
        it('should clean up after stdio connect failure', async () => {
            await manager.initialize();
            // 使用一个不存在的命令来触发 connect 失败
            const id = await manager.createServer(
                makeTestInput({
                    name: 'Fail Server',
                    transport: {
                        type: 'stdio',
                        command: 'nonexistent_command_xyz_123',
                        args: [],
                    },
                }),
                'fail_srv'
            );

            await expect(manager.connect('fail_srv')).rejects.toThrow();

            // 连接失败后状态应为 error（由 connect 方法 catch 块设置）
            const status = manager.getServerStatus('fail_srv');
            expect(status).toBe('error');

            // 客户端不应在 clients map 中（已被 performConnect 的 catch 移除）
            const info = await manager.getServerInfo('fail_srv');
            expect(info!.lastError).toBeDefined();
        });
    });

    // ==================== disconnect ====================

    describe('disconnect', () => {
        it('should no-op on already disconnected server', async () => {
            await manager.initialize();
            const id = await manager.createServer(makeTestInput(), 'disc_srv');

            // 第一次 disconnect 应成功
            await manager.disconnect('disc_srv');
            // 第二次 disconnect 应不报错
            await expect(manager.disconnect('disc_srv')).resolves.toBeUndefined();
        });

        it('should throw on unknown server', async () => {
            await manager.initialize();
            await expect(manager.disconnect('nonexistent')).rejects.toThrow();
        });
    });

    // ==================== deleteServer ====================

    describe('deleteServer', () => {
        it('should remove server from storage and memory', async () => {
            await manager.initialize();
            await manager.createServer(makeTestInput(), 'del_srv');

            await manager.deleteServer('del_srv');

            const info = await manager.getServerInfo('del_srv');
            expect(info).toBeNull();
        });
    });

    // ==================== listServers ====================

    describe('listServers', () => {
        it('should return all servers with their status', async () => {
            await manager.initialize();
            await manager.createServer(makeTestInput({ name: 'A' }), 'srv_a');
            await manager.createServer(makeTestInput({ name: 'B' }), 'srv_b');

            const servers = await manager.listServers();
            expect(servers).toHaveLength(2);
            expect(servers.map(s => s.config.name).sort()).toEqual(['A', 'B']);
            expect(servers.every(s => s.status === 'disconnected')).toBe(true);
        });
    });

    // ==================== setServerEnabled ====================

    describe('setServerEnabled', () => {
        it('should update enabled status', async () => {
            await manager.initialize();
            await manager.createServer(makeTestInput({ enabled: true }), 'en_srv');

            await manager.setServerEnabled('en_srv', false);

            const info = await manager.getServerInfo('en_srv');
            expect(info!.config.enabled).toBe(false);
        });
    });

    // ==================== signal 透传 ====================

    describe('callTool signal passthrough', () => {
        it('should pass the request signal to the underlying client callTool/readResource', async () => {
            const connectSpy = jest.spyOn(StdioMcpClient.prototype, 'connect').mockResolvedValue(undefined);
            const disconnectSpy = jest.spyOn(StdioMcpClient.prototype, 'disconnect').mockResolvedValue(undefined);
            const callToolSpy = jest.spyOn(StdioMcpClient.prototype, 'callTool').mockResolvedValue({
                content: [{ type: 'text', text: 'ok' }],
            });
            const readResourceSpy = jest.spyOn(StdioMcpClient.prototype, 'readResource').mockResolvedValue({
                contents: [{ uri: 'u', text: 'data' }],
            });

            try {
                await manager.initialize();
                const id = await manager.createServer(makeTestInput(), 'sig_srv');
                await manager.connect('sig_srv');

                const controller = new AbortController();
                const result = await manager.callTool({
                    serverId: id,
                    toolName: 't',
                    arguments: { a: 1 },
                    signal: controller.signal,
                });

                expect(result.success).toBe(true);
                expect(callToolSpy).toHaveBeenCalledWith('t', { a: 1 }, controller.signal);

                const content = await manager.readResource({
                    serverId: id,
                    uri: 'u',
                    signal: controller.signal,
                });
                expect(content?.text).toBe('data');
                expect(readResourceSpy).toHaveBeenCalledWith('u', controller.signal);
            } finally {
                connectSpy.mockRestore();
                disconnectSpy.mockRestore();
                callToolSpy.mockRestore();
                readResourceSpy.mockRestore();
            }
        });

        it('should surface an aborted client rejection as an MCP failure result', async () => {
            const connectSpy = jest.spyOn(StdioMcpClient.prototype, 'connect').mockResolvedValue(undefined);
            const disconnectSpy = jest.spyOn(StdioMcpClient.prototype, 'disconnect').mockResolvedValue(undefined);
            const callToolSpy = jest.spyOn(StdioMcpClient.prototype, 'callTool')
                .mockRejectedValue(new Error('MCP tool call aborted'));

            try {
                await manager.initialize();
                const id = await manager.createServer(makeTestInput(), 'sig_srv2');
                await manager.connect('sig_srv2');

                const controller = new AbortController();
                controller.abort();
                const result = await manager.callTool({
                    serverId: id,
                    toolName: 't',
                    arguments: {},
                    signal: controller.signal,
                });

                expect(result.success).toBe(false);
                expect(result.error).toContain('aborted');
            } finally {
                connectSpy.mockRestore();
                disconnectSpy.mockRestore();
                callToolSpy.mockRestore();
            }
        });
    });
});
