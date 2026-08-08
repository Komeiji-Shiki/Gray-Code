import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { StoragePathManager } from '../../modules/settings/StoragePathManager';

interface TestStorageConfig {
    customDataPath?: string;
    migrationStatus?: string;
    lastMigrationAt?: number;
    migrationError?: string;
}

function createSettingsManager(initialConfig: TestStorageConfig = { migrationStatus: 'none' }) {
    let config: TestStorageConfig = initialConfig;

    return {
        getStoragePathConfig: jest.fn(() => config),
        updateStoragePathConfig: jest.fn(async (update: Partial<TestStorageConfig>) => {
            config = { ...config, ...update };
        }),
        markMigrationStarted: jest.fn(async () => {
            config = { ...config, migrationStatus: 'in_progress' };
        }),
        markMigrationFailed: jest.fn(async (error: string) => {
            config = { ...config, migrationStatus: 'failed', migrationError: error };
        })
    };
}

describe('StoragePathManager', () => {
    let tempRoot: string;
    let defaultPath: string;

    beforeEach(async () => {
        tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'graycode-storage-test-'));
        defaultPath = path.join(tempRoot, 'default');
        await fs.mkdir(defaultPath, { recursive: true });
    });

    afterEach(async () => {
        await fs.rm(tempRoot, { recursive: true, force: true });
        jest.restoreAllMocks();
    });

    it('migrates safely into a subdirectory of the current storage path', async () => {
        await fs.mkdir(path.join(defaultPath, 'conversations'), { recursive: true });
        await fs.mkdir(path.join(defaultPath, 'mcp'), { recursive: true });
        await fs.writeFile(path.join(defaultPath, 'conversations', 'chat.json'), 'chat');
        await fs.writeFile(path.join(defaultPath, 'mcp', 'servers.json'), '{}');

        const settingsManager = createSettingsManager();
        const manager = new StoragePathManager(
            settingsManager as any,
            { globalStorageUri: { fsPath: defaultPath } } as any
        );
        const targetPath = path.join(defaultPath, 'mcp');

        const result = await manager.migrateData(targetPath);

        expect(result.success).toBe(true);
        await expect(fs.readFile(path.join(targetPath, 'conversations', 'chat.json'), 'utf8')).resolves.toBe('chat');
        await expect(fs.readFile(path.join(targetPath, 'mcp', 'servers.json'), 'utf8')).resolves.toBe('{}');
        await expect(fs.access(path.join(defaultPath, 'conversations'))).rejects.toMatchObject({ code: 'ENOENT' });
        expect(settingsManager.getStoragePathConfig()).toMatchObject({
            customDataPath: targetPath,
            migrationStatus: 'completed'
        });
    });

    it('restores a nested custom path back to the default path', async () => {
        await fs.mkdir(path.join(defaultPath, 'conversations'), { recursive: true });
        await fs.mkdir(path.join(defaultPath, 'mcp'), { recursive: true });
        await fs.writeFile(path.join(defaultPath, 'conversations', 'chat.json'), 'chat');
        await fs.writeFile(path.join(defaultPath, 'mcp', 'servers.json'), '{}');

        const settingsManager = createSettingsManager();
        const manager = new StoragePathManager(
            settingsManager as any,
            { globalStorageUri: { fsPath: defaultPath } } as any
        );
        const targetPath = path.join(defaultPath, 'mcp');
        await manager.migrateData(targetPath);

        const result = await manager.resetToDefault();

        expect(result.success).toBe(true);
        await expect(fs.readFile(path.join(defaultPath, 'conversations', 'chat.json'), 'utf8')).resolves.toBe('chat');
        await expect(fs.readFile(path.join(defaultPath, 'mcp', 'servers.json'), 'utf8')).resolves.toBe('{}');
        expect(settingsManager.getStoragePathConfig()).toMatchObject({
            customDataPath: undefined,
            migrationStatus: 'none'
        });
    });

    it('does not overwrite an existing validation marker file', async () => {
        const marker = path.join(defaultPath, '.limcode-test');
        await fs.writeFile(marker, 'keep me');

        const settingsManager = createSettingsManager();
        const manager = new StoragePathManager(
            settingsManager as any,
            { globalStorageUri: { fsPath: defaultPath } } as any
        );

        const result = await manager.validatePath(defaultPath);

        expect(result.valid).toBe(true);
        await expect(fs.readFile(marker, 'utf8')).resolves.toBe('keep me');
    });

    it('does not create a missing path while validating it', async () => {
        const targetPath = path.join(tempRoot, 'missing', 'nested');
        const settingsManager = createSettingsManager();
        const manager = new StoragePathManager(
            settingsManager as any,
            { globalStorageUri: { fsPath: defaultPath } } as any
        );

        const result = await manager.validatePath(targetPath);

        expect(result.valid).toBe(true);
        await expect(fs.access(path.join(tempRoot, 'missing'))).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('keeps the source and configuration when copying fails', async () => {
        await fs.mkdir(path.join(defaultPath, 'conversations'), { recursive: true });
        const sourceFile = path.join(defaultPath, 'conversations', 'chat.json');
        await fs.writeFile(sourceFile, 'chat');

        const settingsManager = createSettingsManager();
        const manager = new StoragePathManager(
            settingsManager as any,
            { globalStorageUri: { fsPath: defaultPath } } as any
        );
        jest.spyOn(manager as any, 'copyDirectory').mockRejectedValueOnce(new Error('copy failed'));

        const result = await manager.migrateData(path.join(tempRoot, 'target'));

        expect(result).toMatchObject({ success: false, copiedFiles: 0 });
        await expect(fs.readFile(sourceFile, 'utf8')).resolves.toBe('chat');
        expect(settingsManager.getStoragePathConfig().customDataPath).toBeUndefined();
        expect(settingsManager.getStoragePathConfig().migrationStatus).toBe('failed');
        expect(settingsManager.getStoragePathConfig().migrationError).toBe('copy failed');
    });

    it('keeps an active custom path when a later migration fails', async () => {
        const customPath = path.join(tempRoot, 'custom');
        await fs.mkdir(path.join(customPath, 'conversations'), { recursive: true });
        const sourceFile = path.join(customPath, 'conversations', 'chat.json');
        await fs.writeFile(sourceFile, 'chat');

        const settingsManager = createSettingsManager({
            customDataPath: customPath,
            migrationStatus: 'completed',
            lastMigrationAt: 123
        });
        const manager = new StoragePathManager(
            settingsManager as any,
            { globalStorageUri: { fsPath: defaultPath } } as any
        );
        jest.spyOn(manager as any, 'copyDirectory').mockRejectedValueOnce(new Error('copy failed'));

        const result = await manager.migrateData(path.join(tempRoot, 'target'));

        expect(result.success).toBe(false);
        await expect(fs.readFile(sourceFile, 'utf8')).resolves.toBe('chat');
        expect(manager.getEffectiveDataPath()).toBe(customPath);
        expect(settingsManager.getStoragePathConfig()).toMatchObject({
            customDataPath: customPath,
            migrationStatus: 'failed',
            lastMigrationAt: 123,
            migrationError: 'copy failed'
        });
    });
});
