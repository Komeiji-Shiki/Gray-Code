import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { StoragePathManager, isSameStoragePath } from '../../modules/settings/StoragePathManager';

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

    test('migrates safely into a subdirectory of the current storage path', async () => {
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

    test('restores a nested custom path back to the default path', async () => {
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

    test('does not overwrite an existing validation marker file', async () => {
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

    test('does not create a missing path while validating it', async () => {
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

    test('keeps the source and configuration when copying fails', async () => {
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

    test('keeps an active custom path when a later migration fails', async () => {
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

    // ===== Windows 大小写不敏感路径（同路径判定） =====

    test('isSameStoragePath: Windows 下大小写变体视为同一路径', () => {
        expect(isSameStoragePath('D:\\GrayCode', 'd:\\graycode', 'win32')).toBe(true);
        expect(isSameStoragePath('d:/graycode', 'D:\\GrayCode', 'win32')).toBe(true);
    });

    test('isSameStoragePath: 忽略非根目录末尾分隔符，但不破坏根目录', () => {
        expect(isSameStoragePath('D:\\GrayCode', 'd:\\graycode\\', 'win32')).toBe(true);
        expect(isSameStoragePath('D:\\', 'd:/', 'win32')).toBe(true);
        expect(isSameStoragePath('/data/graycode', '/data/graycode/', 'linux')).toBe(true);
        expect(isSameStoragePath('/', '/', 'linux')).toBe(true);
    });

    test('isSameStoragePath: 非 Windows 保持大小写敏感', () => {
        expect(isSameStoragePath('/data/GrayCode', '/data/graycode', 'linux')).toBe(false);
        expect(isSameStoragePath('/data/GrayCode', '/data/GrayCode', 'linux')).toBe(true);
    });

    test('migrateData: Windows 大小写变体目标路径直接短路（同路径），不触发迁移', async () => {
        const originalPlatform = process.platform;
        Object.defineProperty(process, 'platform', { value: 'win32' });
        try {
            // 大小写变体与当前存储路径指向同一目录：必须短路返回，
            // 否则 staging 复制到同一目录后 removeStorageData 会清空全部存储子目录（数据全丢）
            const settingsManager = createSettingsManager();
            const manager = new StoragePathManager(
                settingsManager as any,
                { globalStorageUri: { fsPath: defaultPath } } as any
            );
            const caseVariant = path.join(
                path.dirname(defaultPath),
                path.basename(defaultPath).toUpperCase()
            );

            const result = await manager.migrateData(caseVariant);

            expect(result).toEqual({ success: true, copiedFiles: 0 });
            // 短路：未进入任何迁移/标记/清理流程
            expect(settingsManager.markMigrationStarted).not.toHaveBeenCalled();
            expect(settingsManager.updateStoragePathConfig).not.toHaveBeenCalled();
        } finally {
            Object.defineProperty(process, 'platform', { value: originalPlatform });
        }
    });

    test('migrateData: 目标仅多尾分隔符时直接短路，源数据不会被清理', async () => {
        const sourceFile = path.join(defaultPath, 'conversations', 'chat.json');
        await fs.mkdir(path.dirname(sourceFile), { recursive: true });
        await fs.writeFile(sourceFile, 'must survive');
        const settingsManager = createSettingsManager();
        const manager = new StoragePathManager(
            settingsManager as any,
            { globalStorageUri: { fsPath: defaultPath } } as any
        );

        const result = await manager.migrateData(`${defaultPath}${path.sep}`);

        expect(result).toEqual({ success: true, copiedFiles: 0 });
        await expect(fs.readFile(sourceFile, 'utf8')).resolves.toBe('must survive');
        expect(settingsManager.markMigrationStarted).not.toHaveBeenCalled();
        expect(settingsManager.updateStoragePathConfig).not.toHaveBeenCalled();
    });

    test('migrateData: 不同字符串解析到同一物理目录时在复制前二次短路', async () => {
        const sourceFile = path.join(defaultPath, 'conversations', 'chat.json');
        await fs.mkdir(path.dirname(sourceFile), { recursive: true });
        await fs.writeFile(sourceFile, 'must survive canonical alias');
        const settingsManager = createSettingsManager();
        const manager = new StoragePathManager(
            settingsManager as any,
            { globalStorageUri: { fsPath: defaultPath } } as any
        );
        jest.spyOn(manager, 'validatePath').mockResolvedValue({ valid: true });
        jest.spyOn(manager as any, 'resolvePathForComparison').mockResolvedValue(defaultPath);

        const result = await manager.migrateData(path.join(tempRoot, 'alias'));

        expect(result).toEqual({ success: true, copiedFiles: 0 });
        await expect(fs.readFile(sourceFile, 'utf8')).resolves.toBe('must survive canonical alias');
        expect(settingsManager.markMigrationStarted).not.toHaveBeenCalled();
        expect(settingsManager.updateStoragePathConfig).not.toHaveBeenCalled();
    });

    test('resetToDefault: 自定义路径实际就是默认目录时只清配置，不删除数据', async () => {
        const sourceFile = path.join(defaultPath, 'conversations', 'chat.json');
        await fs.mkdir(path.dirname(sourceFile), { recursive: true });
        await fs.writeFile(sourceFile, 'must survive reset');
        const settingsManager = createSettingsManager({
            customDataPath: `${defaultPath}${path.sep}`,
            migrationStatus: 'completed'
        });
        const manager = new StoragePathManager(
            settingsManager as any,
            { globalStorageUri: { fsPath: defaultPath } } as any
        );

        await expect(manager.resetToDefault()).resolves.toEqual({ success: true });
        await expect(fs.readFile(sourceFile, 'utf8')).resolves.toBe('must survive reset');
        expect(settingsManager.getStoragePathConfig()).toMatchObject({
            customDataPath: undefined,
            migrationStatus: 'none'
        });
    });

    test('cleanupOldStorage: 旧配置的自定义路径实际就是默认目录时不删除当前数据', async () => {
        const sourceFile = path.join(defaultPath, 'conversations', 'chat.json');
        await fs.mkdir(path.dirname(sourceFile), { recursive: true });
        await fs.writeFile(sourceFile, 'must survive manual cleanup');
        const settingsManager = createSettingsManager({
            customDataPath: `${defaultPath}${path.sep}`,
            migrationStatus: 'completed'
        });
        const manager = new StoragePathManager(
            settingsManager as any,
            { globalStorageUri: { fsPath: defaultPath } } as any
        );

        await expect(manager.cleanupOldStorage()).resolves.toEqual({ success: true, freedBytes: 0 });
        await expect(fs.readFile(sourceFile, 'utf8')).resolves.toBe('must survive manual cleanup');
    });
});
