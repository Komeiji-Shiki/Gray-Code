/**
 * DependencyManager 完整依赖树事务测试。
 *
 * 覆盖：同依赖去重、不同依赖全局串行、整树原子回滚、未知卸载拒绝、
 * npm 输出实时上限、临时目录清理、scoped 包与子路径缓存。
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    DependencyManager,
    NPM_OUTPUT_MAX_BYTES
} from '../../modules/dependencies/DependencyManager';

jest.mock('cross-spawn', () => jest.fn());
const spawnMock = require('cross-spawn') as jest.Mock;

function makeEmitter() {
    const listeners: Record<string, ((...args: any[]) => void)[]> = {};
    return {
        on(event: string, cb: (...args: any[]) => void) {
            (listeners[event] ??= []).push(cb);
        },
        emit(event: string, ...args: any[]) {
            for (const cb of listeners[event] ?? []) cb(...args);
        }
    };
}

function emitProcessEvent(proc: { on: jest.Mock }, event: string, ...args: unknown[]): void {
    for (const [registeredEvent, callback] of proc.on.mock.calls as Array<[string, (...values: unknown[]) => void]>) {
        if (registeredEvent === event) callback(...args);
    }
}

/** 根据 staging package.json 创建完整的受管直接依赖集合。 */
function materializeRequestedPackages(tempDir: string): void {
    const pkg = JSON.parse(fs.readFileSync(path.join(tempDir, 'package.json'), 'utf8')) as {
        dependencies?: Record<string, string>;
    };
    for (const name of Object.keys(pkg.dependencies ?? {})) {
        const pkgDir = path.join(tempDir, 'node_modules', name);
        fs.mkdirSync(pkgDir, { recursive: true });
        fs.writeFileSync(
            path.join(pkgDir, 'package.json'),
            JSON.stringify({ name, version: name === 'sharp' ? '0.33.5' : '1.0.0' })
        );
    }
}

function mockNpmSuccess(delayMs = 10, hooks?: { onStart?: () => void; onFinish?: () => void }): void {
    spawnMock.mockImplementation((_file: string, _args: string[], options: any) => {
        const tempDir = options.cwd as string;
        const stdout = makeEmitter();
        const stderr = makeEmitter();
        const proc = { stdout, stderr, on: jest.fn(), kill: jest.fn() };
        hooks?.onStart?.();
        setTimeout(() => {
            materializeRequestedPackages(tempDir);
            hooks?.onFinish?.();
            emitProcessEvent(proc, 'close', 0, null);
        }, delayMs);
        return proc;
    });
}

function mockNpmFailure(): void {
    spawnMock.mockImplementation(() => {
        const stdout = makeEmitter();
        const stderr = makeEmitter();
        const proc = { stdout, stderr, on: jest.fn(), kill: jest.fn() };
        setTimeout(() => {
            stderr.emit('data', Buffer.from('npm error: mock failure detail\n'));
            emitProcessEvent(proc, 'close', 1, null);
        }, 10);
        return proc;
    });
}

describe('DependencyManager managed dependency tree', () => {
    let graycodeDir: string;

    beforeEach(() => {
        graycodeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-deps-'));
        (DependencyManager as any).instance = undefined;
        spawnMock.mockReset();
    });

    afterEach(() => {
        jest.restoreAllMocks();
        (DependencyManager as any).instance = undefined;
        fs.rmSync(graycodeDir, { recursive: true, force: true });
    });

    function createManager(): DependencyManager {
        return DependencyManager.getInstance({} as any, graycodeDir);
    }

    test('并发安装同一依赖复用同一事务，npm 只执行一次', async () => {
        mockNpmSuccess(80);
        const manager = createManager();

        const [first, second] = await Promise.all([
            manager.install('sharp'),
            manager.install('sharp')
        ]);

        expect(first).toEqual({ success: true });
        expect(second).toEqual({ success: true });
        expect(spawnMock).toHaveBeenCalledTimes(1);
        expect(await manager.isInstalled('sharp')).toBe(true);
        expect(await manager.getInstalledVersion('sharp')).toBe('0.33.5');
        expect(fs.readdirSync(graycodeDir).filter(name => name.startsWith('deps-tree-temp-'))).toEqual([]);
    });

    test('不同依赖的完整树变更全局串行，后一次保留前一次已安装包', async () => {
        let active = 0;
        let maxActive = 0;
        mockNpmSuccess(30, {
            onStart: () => {
                active += 1;
                maxActive = Math.max(maxActive, active);
            },
            onFinish: () => {
                active -= 1;
            }
        });
        const manager = createManager();

        const [sharpResult, pdfResult] = await Promise.all([
            manager.install('sharp'),
            manager.install('pdfjs-dist')
        ]);

        expect(sharpResult.success).toBe(true);
        expect(pdfResult.success).toBe(true);
        expect(maxActive).toBe(1);
        expect(spawnMock).toHaveBeenCalledTimes(2);
        expect(await manager.isInstalled('sharp')).toBe(true);
        expect(await manager.isInstalled('pdfjs-dist')).toBe(true);
    });

    test('安装完成后再次安装会重建完整树，但不丢失其它受管依赖', async () => {
        mockNpmSuccess();
        const manager = createManager();

        expect((await manager.install('sharp')).success).toBe(true);
        expect((await manager.install('pdfjs-dist')).success).toBe(true);
        expect((await manager.install('sharp')).success).toBe(true);

        expect(spawnMock).toHaveBeenCalledTimes(3);
        expect(await manager.isInstalled('sharp')).toBe(true);
        expect(await manager.isInstalled('pdfjs-dist')).toBe(true);
    });

    test('npm 失败保留旧依赖树并清理 staging', async () => {
        mockNpmSuccess();
        const manager = createManager();
        expect((await manager.install('sharp')).success).toBe(true);

        mockNpmFailure();
        const result = await manager.install('pdfjs-dist');

        expect(result.success).toBe(false);
        expect(result.error).toContain('mock failure detail');
        expect(await manager.isInstalled('sharp')).toBe(true);
        expect(await manager.isInstalled('pdfjs-dist')).toBe(false);
        expect(fs.readdirSync(graycodeDir).filter(name => name.startsWith('deps-tree-temp-'))).toEqual([]);
    });

    test('整树提交第二次 rename 失败时恢复旧 node_modules', async () => {
        mockNpmSuccess();
        const manager = createManager();
        expect((await manager.install('sharp')).success).toBe(true);

        const originalRename = fs.promises.rename.bind(fs.promises);
        let rejectedCommit = false;
        jest.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
            const source = String(from);
            const target = String(to);
            if (!rejectedCommit && source.includes('deps-tree-temp-') && target === path.join(graycodeDir, 'node_modules')) {
                rejectedCommit = true;
                throw Object.assign(new Error('commit rename failed'), { code: 'EIO' });
            }
            return originalRename(from, to);
        });

        const result = await manager.install('pdfjs-dist');

        expect(result.success).toBe(false);
        expect(result.error).toContain('commit rename failed');
        expect(await manager.isInstalled('sharp')).toBe(true);
        expect(await manager.isInstalled('pdfjs-dist')).toBe(false);
    });

    test('未知安装和卸载均在路径操作前拒绝，不能用 .. 删除依赖根', async () => {
        mockNpmSuccess();
        const manager = createManager();
        const sentinel = path.join(graycodeDir, 'sentinel.txt');
        fs.writeFileSync(sentinel, 'keep');

        const installResult = await manager.install('nonexistent-dep');
        const uninstallResult = await manager.uninstall('..');

        expect(installResult.success).toBe(false);
        expect(uninstallResult.success).toBe(false);
        expect(fs.readFileSync(sentinel, 'utf8')).toBe('keep');
        expect(spawnMock).not.toHaveBeenCalled();
    });

    test('npm 输出在 data 到达时实时限流并终止子进程', async () => {
        let processRef: { kill: jest.Mock } | undefined;
        spawnMock.mockImplementation(() => {
            const stdout = makeEmitter();
            const stderr = makeEmitter();
            const proc = { stdout, stderr, on: jest.fn(), kill: jest.fn() };
            processRef = proc;
            setTimeout(() => {
                stdout.emit('data', Buffer.alloc(NPM_OUTPUT_MAX_BYTES + 1));
            }, 0);
            return proc;
        });
        const manager = createManager();

        const result = await manager.install('sharp');

        expect(result.success).toBe(false);
        expect(result.error).toContain('npm stdout exceeded');
        expect(processRef?.kill).toHaveBeenCalled();
    });

    test('scoped 包参与完整树构建，路径保持正确', async () => {
        mockNpmSuccess();
        const manager = createManager();

        const result = await manager.install('@napi-rs/canvas');

        expect(result.success).toBe(true);
        expect(await manager.isInstalled('@napi-rs/canvas')).toBe(true);
        expect(fs.existsSync(path.join(graycodeDir, 'node_modules', '@napi-rs', 'canvas', 'package.json'))).toBe(true);
    });

    test('load 支持子路径入口，卸载通过整树换代清除模块', async () => {
        mockNpmSuccess();
        const manager = createManager();
        await manager.install('pdfjs-dist');

        const packageDir = path.join(graycodeDir, 'node_modules', 'pdfjs-dist');
        const legacyDir = path.join(packageDir, 'legacy', 'build');
        fs.mkdirSync(legacyDir, { recursive: true });
        fs.writeFileSync(path.join(legacyDir, 'pdf.js'), 'module.exports = { legacyValue: 42 };');

        const first = await manager.load('pdfjs-dist', 'legacy/build/pdf.js');
        const second = await manager.load('pdfjs-dist', 'legacy/build/pdf.js');
        expect((first as any)?.legacyValue).toBe(42);
        expect(second).toBe(first);

        expect((await manager.uninstall('pdfjs-dist')).success).toBe(true);
        expect(await manager.load('pdfjs-dist', 'legacy/build/pdf.js')).toBeNull();
    });
});
