/**
 * MCP 存储适配器单测
 *
 * 覆盖：cleanSchema 持久化、InMemory 适配器基本操作
 */
import { InMemoryMcpStorageAdapter } from '../../modules/mcp/storage';
import type { McpServerConfig } from '../../modules/mcp/types';

function makeConfig(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
    return {
        id: 'test_srv',
        name: 'Test Server',
        transport: { type: 'stdio', command: 'echo' },
        enabled: true,
        autoConnect: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        ...overrides,
    };
}

describe('InMemoryMcpStorageAdapter', () => {
    let storage: InMemoryMcpStorageAdapter;

    beforeEach(() => {
        storage = new InMemoryMcpStorageAdapter();
    });

    describe('basic CRUD', () => {
        it('should save and retrieve a config', async () => {
            const config = makeConfig();
            await storage.saveConfig(config);

            const retrieved = await storage.getConfig('test_srv');
            expect(retrieved).not.toBeNull();
            expect(retrieved!.name).toBe('Test Server');
            expect(retrieved!.transport.type).toBe('stdio');
        });

        it('should return null for non-existent config', async () => {
            const result = await storage.getConfig('nope');
            expect(result).toBeNull();
        });

        it('should list all configs', async () => {
            await storage.saveConfig(makeConfig({ id: 'a', name: 'A' }));
            await storage.saveConfig(makeConfig({ id: 'b', name: 'B' }));

            const all = await storage.getAllConfigs();
            expect(all).toHaveLength(2);
            expect(all.map(c => c.name).sort()).toEqual(['A', 'B']);
        });

        it('should update an existing config', async () => {
            await storage.saveConfig(makeConfig({ id: 'x', name: 'Original' }));
            await storage.saveConfig(makeConfig({ id: 'x', name: 'Updated' }));

            const result = await storage.getConfig('x');
            expect(result!.name).toBe('Updated');
        });

        it('should delete a config', async () => {
            await storage.saveConfig(makeConfig({ id: 'to_delete' }));
            await storage.deleteConfig('to_delete');

            const result = await storage.getConfig('to_delete');
            expect(result).toBeNull();
        });
    });

    describe('#7: cleanSchema persistence', () => {
        it('should persist cleanSchema: false', async () => {
            const config = makeConfig({ id: 'cs_test', cleanSchema: false });
            await storage.saveConfig(config);

            const retrieved = await storage.getConfig('cs_test');
            expect(retrieved!.cleanSchema).toBe(false);
        });

        it('should persist cleanSchema: true', async () => {
            const config = makeConfig({ id: 'cs_true', cleanSchema: true });
            await storage.saveConfig(config);

            const retrieved = await storage.getConfig('cs_true');
            expect(retrieved!.cleanSchema).toBe(true);
        });

        it('should treat undefined cleanSchema as undefined (not coerced)', async () => {
            const config = makeConfig({ id: 'cs_undef' });
            delete (config as any).cleanSchema;
            await storage.saveConfig(config);

            const retrieved = await storage.getConfig('cs_undef');
            expect(retrieved!.cleanSchema).toBeUndefined();
        });
    });

    describe('timeout persistence', () => {
        it('should persist timeout', async () => {
            const config = makeConfig({ id: 't_test', timeout: 60000 });
            await storage.saveConfig(config);

            const retrieved = await storage.getConfig('t_test');
            expect(retrieved!.timeout).toBe(60000);
        });

        it('should handle undefined timeout', async () => {
            const config = makeConfig({ id: 't_undef' });
            delete (config as any).timeout;
            await storage.saveConfig(config);

            const retrieved = await storage.getConfig('t_undef');
            expect(retrieved!.timeout).toBeUndefined();
        });
    });
});
