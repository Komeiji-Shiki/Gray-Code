/**
 * DependencyManager.install 并发安全回归测试
 *
 * 1. 同依赖并发安装串行化：第二个调用复用第一个的结果（execFile 只执行一次）
 * 2. 安装完成后再调用会重新安装（不缓存结果）
 * 3. 安装失败路径清理临时目录（不留 deps-temp-* 残留）
 * 4. 未知依赖直接返回 false，不触发 execFile
 */
import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DependencyManager } from '../../modules/dependencies/DependencyManager';

// 模拟 child_process.execFile：
// DependencyManager 使用 promisify(childProcess.execFile)，promisify 依据 fn.length
// 决定传给回调前的参数个数，真实 execFile.length === 4 (file, args, options, callback)，这里保持一致。
// fork 刻意使用 execFile（参数数组直传、不经 shell 解析）而非 exec，见 DependencyManager.ts。
jest.mock('child_process', () => {
    const actual = jest.requireActual('child_process');
    const execFile = jest.fn();
    Object.defineProperty(execFile, 'length', { value: 4 });
    return { ...actual, execFile };
});

const execFileMock = childProcess.execFile as unknown as jest.Mock;

describe('DependencyManager.install', () => {
    let limcodeDir: string;

    beforeEach(() => {
        limcodeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-deps-'));
        (DependencyManager as any).instance = undefined;
        execFileMock.mockReset();
    });

    afterEach(() => {
        (DependencyManager as any).instance = undefined;
        fs.rmSync(limcodeDir, { recursive: true, force: true });
    });

    function createManager(): DependencyManager {
        return DependencyManager.getInstance({} as any, limcodeDir);
    }

    /** 模拟 npm install 成功：在 options.cwd（临时目录）下生成 node_modules/sharp */
    function mockNpmSuccess(delayMs = 0): void {
        execFileMock.mockImplementation((file: string, args: string[], options: any, callback: any) => {
            const tempDir = options?.cwd as string;
            const done = () => {
                const pkgDir = path.join(tempDir, 'node_modules', 'sharp');
                fs.mkdirSync(pkgDir, { recursive: true });
                fs.writeFileSync(
                    path.join(pkgDir, 'package.json'),
                    JSON.stringify({ name: 'sharp', version: '0.33.5' })
                );
                callback(null, 'added 1 package', '');
            };
            if (delayMs > 0) {
                setTimeout(done, delayMs);
            } else {
                done();
            }
        });
    }

    it('并发安装同一依赖：第二个调用复用第一个，exec 只执行一次', async () => {
        mockNpmSuccess(100);
        const mgr = createManager();

        const [r1, r2] = await Promise.all([mgr.install('sharp'), mgr.install('sharp')]);

        expect(r1).toBe(true);
        expect(r2).toBe(true);
        // 串行化：同一依赖的两次并发请求只触发一次真实安装
        expect(execFileMock).toHaveBeenCalledTimes(1);
        // 安装结果可用
        expect(await mgr.isInstalled('sharp')).toBe(true);
        expect(await mgr.getInstalledVersion('sharp')).toBe('0.33.5');
        // 临时目录无残留
        const leftovers = fs.readdirSync(limcodeDir).filter((e) => e.startsWith('deps-temp-'));
        expect(leftovers).toEqual([]);
    });

    it('安装完成后再调用会触发新的安装（不缓存结果）', async () => {
        mockNpmSuccess(0);
        const mgr = createManager();

        expect(await mgr.install('sharp')).toBe(true);
        expect(await mgr.install('sharp')).toBe(true);
        expect(execFileMock).toHaveBeenCalledTimes(2);
        expect(await mgr.isInstalled('sharp')).toBe(true);
    });

    it('安装失败：返回 false、不标记已安装、清理临时目录', async () => {
        execFileMock.mockImplementation((file: string, args: string[], options: any, callback: any) => {
            callback(new Error('npm install failed (mock)'), '', '');
        });
        const mgr = createManager();

        expect(await mgr.install('sharp')).toBe(false);
        expect(await mgr.isInstalled('sharp')).toBe(false);
        const leftovers = fs.readdirSync(limcodeDir).filter((e) => e.startsWith('deps-temp-'));
        expect(leftovers).toEqual([]);
    });

    it('未知依赖直接返回 false，不触发 exec', async () => {
        mockNpmSuccess(0);
        const mgr = createManager();

        expect(await mgr.install('nonexistent-dep')).toBe(false);
        expect(execFileMock).not.toHaveBeenCalled();
    });
});
