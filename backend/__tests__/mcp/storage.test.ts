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
    MementoMcpStorageAdapter,
    FileSystemMcpStorageAdapter,
    VSCodeFileSystemMcpStorageAdapter,
} from '../../modules/mcp/storage';

function makeMemento(initial: Record<string, unknown> = {}) {
    const store = new Map<string, unknown>(Object.entries(initial));
    return {
        store,
        get: jest.fn(<T,>(key: string, defaultValue: T): T => (store.has(key) ? (store.get(key) as T) : defaultValue)),
        update: jest.fn(async (key: string, value: unknown) => {
            store.set(key, value);
        }),
    };
}

describe('MementoMcpStorageAdapter（MCP M3 补测：串行队列）', () => {
    test('并发 save 同一 id：read-modify-write 不交错，最终为最后一次写入', async () => {
        const memento = makeMemento();
        const storage = new MementoMcpStorageAdapter(memento as any);

        // 同时发起 5 次同 id 保存（不同 name）：若无串行队列，read-modify-write 交错会丢更新
        await Promise.all([
            storage.saveConfig(makeConfig({ id: 'race', name: 'N1' })),
            storage.saveConfig(makeConfig({ id: 'race', name: 'N2' })),
            storage.saveConfig(makeConfig({ id: 'race', name: 'N3' })),
            storage.saveConfig(makeConfig({ id: 'race', name: 'N4' })),
            storage.saveConfig(makeConfig({ id: 'race', name: 'N5' })),
        ]);

        const all = await storage.getAllConfigs();
        expect(all).toHaveLength(1);
        expect(all[0].name).toBe('N5');
    });

    test('并发 save 不同 id：全部保留', async () => {
        const storage = new MementoMcpStorageAdapter(makeMemento() as any);
        await Promise.all(['a', 'b', 'c'].map(id => storage.saveConfig(makeConfig({ id }))));
        const all = await storage.getAllConfigs();
        expect(all.map(c => c.id).sort()).toEqual(['a', 'b', 'c']);
    });

    test('save + delete 并发交错不复活已删配置', async () => {
        const storage = new MementoMcpStorageAdapter(makeMemento() as any);
        await storage.saveConfig(makeConfig({ id: 'd' }));
        await Promise.all([
            storage.deleteConfig('d'),
            storage.saveConfig(makeConfig({ id: 'e' })),
        ]);
        expect(await storage.getConfig('d')).toBeNull();
        expect(await storage.getConfig('e')).not.toBeNull();
    });
});

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
        await fs.rm(dir, { recursive: true, force: true });
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

describe('VSCodeFileSystemMcpStorageAdapter（MCP M3 补测：tmp+rename / EPERM 回退 / 损坏抛错）', () => {
    function makeUri(fsPath: string) {
        return {
            fsPath,
            scheme: 'file',
            path: fsPath.replace(/\\/g, '/'),
            with: (change: { path?: string }) => makeUri(change.path ?? fsPath),
        };
    }

    function makeVscodeFs(overrides: Partial<Record<string, jest.Mock>> = {}) {
        const store = new Map<string, string>();
        return {
            readFile: jest.fn(async (uri: { fsPath: string }) => {
                const raw = store.get(uri.fsPath);
                if (raw === undefined) {
                    const err = new Error('EntryNotFound') as NodeJS.ErrnoException;
                    err.code = 'EntryNotFound';
                    throw err;
                }
                return Buffer.from(raw, 'utf-8');
            }),
            writeFile: jest.fn(async (uri: { fsPath: string }, data: Uint8Array) => {
                store.set(uri.fsPath, Buffer.from(data).toString('utf-8'));
            }),
            rename: jest.fn(async (from: { fsPath: string }, to: { fsPath: string }) => {
                if (overrides.rename) {
                    await overrides.rename(from, to);
                    return;
                }
                const raw = store.get(from.fsPath);
                if (raw === undefined) throw new Error('EntryNotFound');
                store.set(to.fsPath, raw);
                store.delete(from.fsPath);
            }),
            store,
        };
    }

    test('save 走 tmp 写入 → rename(tmp, file, { overwrite: true })', async () => {
        const vfs = makeVscodeFs();
        const uri = makeUri(path.join(os.tmpdir(), 'vs-servers.json'));
        const storage = new VSCodeFileSystemMcpStorageAdapter(uri as any, vfs as any);

        await storage.saveConfig(makeConfig({ id: 'v1' }));

        // 先写 tmp、再 rename 到主文件（原子替换序列）——uri.with() 每次返回新对象，
        // 用 objectContaining 按 fsPath 断言而非整对象引用比较
        const tmpUri = uri.with({ path: uri.path + '.tmp' });
        expect(vfs.writeFile).toHaveBeenCalledWith(
            expect.objectContaining({ fsPath: tmpUri.fsPath }),
            expect.any(Uint8Array)
        );
        expect(vfs.rename).toHaveBeenCalledWith(
            expect.objectContaining({ fsPath: tmpUri.fsPath }),
            expect.objectContaining({ fsPath: uri.fsPath }),
            { overwrite: true }
        );
        expect(vfs.store.has(uri.fsPath)).toBe(true);
        expect(vfs.store.has(tmpUri.fsPath)).toBe(false);
    });

    test('rename EPERM（Windows 占用）时回退直接写主文件', async () => {
        const vfs = makeVscodeFs({
            rename: jest.fn(async () => {
                const err = new Error('EPERM') as NodeJS.ErrnoException;
                err.code = 'EPERM';
                throw err;
            }),
        });
        const uri = makeUri(path.join(os.tmpdir(), 'vs-servers-eperm.json'));
        const storage = new VSCodeFileSystemMcpStorageAdapter(uri as any, vfs as any);

        await expect(storage.saveConfig(makeConfig({ id: 'v2' }))).resolves.toBeUndefined();
        // 回退直写主文件（非原子但至少成功）
        expect(vfs.writeFile).toHaveBeenCalledWith(uri, expect.any(Uint8Array));
    });

    test('损坏 JSON：抛 corrupted 且不覆盖原内容', async () => {
        const vfs = makeVscodeFs();
        const uri = makeUri(path.join(os.tmpdir(), 'vs-servers-broken.json'));
        vfs.store.set(uri.fsPath, '{ nope }');
        const storage = new VSCodeFileSystemMcpStorageAdapter(uri as any, vfs as any);

        await expect(storage.getAllConfigs()).rejects.toThrow(/corrupted/);
        expect(vfs.store.get(uri.fsPath)).toBe('{ nope }');
    });

    test('文件不存在（EntryNotFound）视为无配置', async () => {
        const vfs = makeVscodeFs();
        const uri = makeUri(path.join(os.tmpdir(), 'vs-servers-missing.json'));
        const storage = new VSCodeFileSystemMcpStorageAdapter(uri as any, vfs as any);
        expect(await storage.getAllConfigs()).toEqual([]);
    });
});