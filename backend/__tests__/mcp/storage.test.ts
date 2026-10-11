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
        test('should save and retrieve a config', async () => {
            const config = makeConfig();
            await storage.saveConfig(config);

            const retrieved = await storage.getConfig('test_srv');
            expect(retrieved).not.toBeNull();
            expect(retrieved!.name).toBe('Test Server');
            expect(retrieved!.transport.type).toBe('stdio');
        });

        test('should return null for non-existent config', async () => {
            const result = await storage.getConfig('nope');
            expect(result).toBeNull();
        });

        test('should list all configs', async () => {
            await storage.saveConfig(makeConfig({ id: 'a', name: 'A' }));
            await storage.saveConfig(makeConfig({ id: 'b', name: 'B' }));

            const all = await storage.getAllConfigs();
            expect(all).toHaveLength(2);
            expect(all.map(c => c.name).sort()).toEqual(['A', 'B']);
        });

        test('should update an existing config', async () => {
            await storage.saveConfig(makeConfig({ id: 'x', name: 'Original' }));
            await storage.saveConfig(makeConfig({ id: 'x', name: 'Updated' }));

            const result = await storage.getConfig('x');
            expect(result!.name).toBe('Updated');
        });

        test('should delete a config', async () => {
            await storage.saveConfig(makeConfig({ id: 'to_delete' }));
            await storage.deleteConfig('to_delete');

            const result = await storage.getConfig('to_delete');
            expect(result).toBeNull();
        });
    });

    describe('#7: cleanSchema persistence', () => {
        test('should persist cleanSchema: false', async () => {
            const config = makeConfig({ id: 'cs_test', cleanSchema: false });
            await storage.saveConfig(config);

            const retrieved = await storage.getConfig('cs_test');
            expect(retrieved!.cleanSchema).toBe(false);
        });

        test('should persist cleanSchema: true', async () => {
            const config = makeConfig({ id: 'cs_true', cleanSchema: true });
            await storage.saveConfig(config);

            const retrieved = await storage.getConfig('cs_true');
            expect(retrieved!.cleanSchema).toBe(true);
        });

        test('should treat undefined cleanSchema as undefined (not coerced)', async () => {
            const config = makeConfig({ id: 'cs_undef' });
            delete (config as any).cleanSchema;
            await storage.saveConfig(config);

            const retrieved = await storage.getConfig('cs_undef');
            expect(retrieved!.cleanSchema).toBeUndefined();
        });
    });

    describe('timeout persistence', () => {
        test('should persist timeout', async () => {
            const config = makeConfig({ id: 't_test', timeout: 60000 });
            await storage.saveConfig(config);

            const retrieved = await storage.getConfig('t_test');
            expect(retrieved!.timeout).toBe(60000);
        });

        test('should handle undefined timeout', async () => {
            const config = makeConfig({ id: 't_undef' });
            delete (config as any).timeout;
            await storage.saveConfig(config);

            const retrieved = await storage.getConfig('t_undef');
            expect(retrieved!.timeout).toBeUndefined();
        });
    });
});


// ============ MCP M3 补测：生产适配器（串行队列 / tmp+rename 原子写 / 损坏抛错） ============
import * as os from 'os';
import * as fs from 'fs/promises';
import * as path from 'path';

import {
    FileSystemMcpStorageAdapter,
} from '../../modules/mcp/storage';
import { TEMP_DIR_REMOVE_OPTIONS } from '../__fixtures__/tempDirectory';


describe('FileSystemMcpStorageAdapter（MCP M3 补测：tmp+rename 原子写 / 损坏抛错）', () => {
    let dir: string;
    let file: string;
    let storage: FileSystemMcpStorageAdapter;

    beforeEach(async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-storage-'));
        file = path.join(dir, 'servers.json');
        storage = new FileSystemMcpStorageAdapter(file, fs, path);
    });

    afterEach(async () => {
        await fs.rm(dir, TEMP_DIR_REMOVE_OPTIONS);
    });

    test('save 后主文件存在且无 .tmp 残留（原子写落盘）', async () => {
        await storage.saveConfig(makeConfig({ id: 's1' }));
        const content = await fs.readFile(file, 'utf-8');
        expect(JSON.parse(content).mcpServers).toHaveLength(1);
        await expect(fs.access(file + '.tmp')).rejects.toMatchObject({ code: 'ENOENT' });
    });

    test('并发 save 同一 id 不丢更新（串行队列）', async () => {
        await Promise.all(['A', 'B', 'C'].map(name => storage.saveConfig(makeConfig({ id: 'dup', name }))));
        const all = await storage.getAllConfigs();
        expect(all).toHaveLength(1);
        expect(all[0].name).toBe('C');
    });

    test('损坏 JSON：getAllConfigs 抛 corrupted，且不被静默覆盖', async () => {
        await fs.writeFile(file, '{ broken json !!', 'utf-8');
        await expect(storage.getAllConfigs()).rejects.toThrow(/corrupted/);
        // 读取失败后磁盘原文保持原样（saveConfig 前先读，读到损坏抛错，不写）
        await expect(storage.saveConfig(makeConfig({ id: 'x' }))).rejects.toThrow(/corrupted/);
        expect(await fs.readFile(file, 'utf-8')).toBe('{ broken json !!');
    });

    test('文件不存在视为无配置（ENOENT 不抛错）', async () => {
        expect(await storage.getAllConfigs()).toEqual([]);
    });

    test('deleteConfig 从 mcpServers 移除目标', async () => {
        await storage.saveConfig(makeConfig({ id: 'k1' }));
        await storage.saveConfig(makeConfig({ id: 'k2' }));
        await storage.deleteConfig('k1');
        const all = await storage.getAllConfigs();
        expect(all.map(c => c.id)).toEqual(['k2']);
    });
});