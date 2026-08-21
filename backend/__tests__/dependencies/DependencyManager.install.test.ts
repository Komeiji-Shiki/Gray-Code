/**
 * DependencyManager.install 并发安全回归测试
 *
 * 1. 同依赖并发安装串行化：第二个调用复用第一个的结果（spawn 只执行一次）
 * 2. 安装完成后再调用会重新安装（不缓存结果）
 * 3. 安装失败路径清理临时目录（不留 deps-temp-* 残留）
 * 4. 未知依赖直接返回 { success:false, error }，不触发 spawn
 * 5. scoped 包名（@napi-rs/canvas）临时目录名安全化（不生成子目录路径）
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DependencyManager } from '../../modules/dependencies/DependencyManager';

// 模拟 cross-spawn（生产代码通过它启动 npm，事件流式 API）：
// crossSpawn 返回 ChildProcess 对象，带 stdout/stderr（EventEmitter）与 on('close'/'error')。
// 测试通过 mock 它来模拟 npm 成功/失败，避免测试真实执行 npm install。
jest.mock('cross-spawn', () => jest.fn());
const spawnMock = require('cross-spawn') as jest.Mock;

// EventEmitter 模拟（与 Node 一致的 on/emit 语义）
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

/** 模拟 npm install 成功：在 options.cwd（临时目录）下生成 node_modules/<pkg>，
 *  并按注册顺序触发 on('close', 0) 完成 promise 链
 *  注意：必须异步触发（setTimeout>0），因为生产代码在 crossSpawn 返回后才注册 on('close')，
 *  同步触发会导致回调未注册、Promise 永久挂起 */
function mockNpmSuccess(delayMs = 0, pkgName = 'sharp'): void {
    const settleMs = delayMs > 0 ? delayMs : 10;
    spawnMock.mockImplementation((file: string, args: string[], options: any) => {
        const tempDir = options?.cwd as string;
        const stdout = makeEmitter();
        const stderr = makeEmitter();
        const proc = { stdout, stderr, on: jest.fn(), kill: jest.fn() };
        setTimeout(() => {
            const pkgDir = path.join(tempDir, 'node_modules', pkgName);
            fs.mkdirSync(pkgDir, { recursive: true });
            fs.writeFileSync(
                path.join(pkgDir, 'package.json'),
                JSON.stringify({ name: pkgName, version: '0.33.5' })
            );
            (proc as any).on.mock.calls.forEach(([event, cb]: [string, any]) => {
                if (event === 'close') cb(0);
            });
        }, settleMs);
        return proc;
    });
}

/** 模拟 npm install 失败：先向 stderr 灌入报错文本，再触发 on('close', code!=0) */
function mockNpmFailure(): void {
    spawnMock.mockImplementation((file: string, args: string[], options: any) => {
        const stdout = makeEmitter();
        const stderr = makeEmitter();
        const proc = { stdout, stderr, on: jest.fn(), kill: jest.fn() };
        setTimeout(() => {
            stderr.emit('data', Buffer.from('npm error: mock failure detail\n'));
            (proc as any).on.mock.calls.forEach(([event, cb]: [string, any]) => {
                if (event === 'close') cb(1);
            });
        }, 10);
        return proc;
    });
}

describe('DependencyManager.install', () => {
    let limcodeDir: string;

    beforeEach(() => {
        limcodeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-deps-'));
        (DependencyManager as any).instance = undefined;
        spawnMock.mockReset();
    });

    afterEach(() => {
        (DependencyManager as any).instance = undefined;
        fs.rmSync(limcodeDir, { recursive: true, force: true });
    });

    function createManager(): DependencyManager {
        return DependencyManager.getInstance({} as any, limcodeDir);
    }

    test('并发安装同一依赖：第二个调用复用第一个，spawn 只执行一次', async () => {
        mockNpmSuccess(100);
        const mgr = createManager();

        const [r1, r2] = await Promise.all([mgr.install('sharp'), mgr.install('sharp')]);

        expect(r1).toEqual({ success: true });
        expect(r2).toEqual({ success: true });
        // 串行化：同一依赖的两次并发请求只触发一次真实安装
        expect(spawnMock).toHaveBeenCalledTimes(1);
        // 安装结果可用
        expect(await mgr.isInstalled('sharp')).toBe(true);
        expect(await mgr.getInstalledVersion('sharp')).toBe('0.33.5');
        // 临时目录无残留
        const leftovers = fs.readdirSync(limcodeDir).filter((e) => e.startsWith('deps-temp-'));
        expect(leftovers).toEqual([]);
    });

    test('安装完成后再调用会触发新的安装（不缓存结果）', async () => {
        mockNpmSuccess(0);
        const mgr = createManager();

        expect(await mgr.install('sharp')).toEqual({ success: true });
        expect(await mgr.install('sharp')).toEqual({ success: true });
        expect(spawnMock).toHaveBeenCalledTimes(2);
        expect(await mgr.isInstalled('sharp')).toBe(true);
    });

    test('安装失败：返回 { success:false, error }（含 stderr）、不标记已安装、清理临时目录', async () => {
        mockNpmFailure();
        const mgr = createManager();

        const result = await mgr.install('sharp');
        expect(result.success).toBe(false);
        expect(result.error).toContain('mock failure detail');
        expect(await mgr.isInstalled('sharp')).toBe(false);
        const leftovers = fs.readdirSync(limcodeDir).filter((e) => e.startsWith('deps-temp-'));
        expect(leftovers).toEqual([]);
    });

    test('未知依赖直接返回 { success:false, error }，不触发 spawn', async () => {
        mockNpmSuccess(0);
        const mgr = createManager();

        const result = await mgr.install('nonexistent-dep');
        expect(result.success).toBe(false);
        expect(result.error).toBeTruthy();
        expect(spawnMock).not.toHaveBeenCalled();
    });

    test('scoped 包名（@napi-rs/canvas）：临时目录名不含子目录路径且安装成功', async () => {
        mockNpmSuccess(0, '@napi-rs/canvas');
        const mgr = createManager();

        const result = await mgr.install('@napi-rs/canvas');
        expect(result.success).toBe(true);
        // 临时目录名就是单段目录（无 / 分隔符），不会生成 deps-temp-@napi-rs/canvas 子目录
        const tempDirs = fs.readdirSync(limcodeDir).filter((e) => e.startsWith('deps-temp-'));
        for (const dir of tempDirs) {
            expect(dir).not.toContain('/');
            expect(dir).not.toContain('\\');
        }
        expect(await mgr.isInstalled('@napi-rs/canvas')).toBe(true);
    });

    test('load 支持子路径入口（pdfjs-dist 的 legacy/build/pdf.mjs）且缓存键独立', async () => {
        mockNpmSuccess(0, 'pdfjs-dist');
        const mgr = createManager();
        await mgr.install('pdfjs-dist');

        // 构造带 legacy build 的包结构（使用 CommonJS 格式，jest 的 require 才能解析）
        const pkgDir = path.join(limcodeDir, 'node_modules', 'pdfjs-dist');
        const legacyDir = path.join(pkgDir, 'legacy', 'build');
        fs.mkdirSync(legacyDir, { recursive: true });
        fs.writeFileSync(path.join(legacyDir, 'pdf.js'), 'module.exports = { legacyValue: 42 };');

        const legacyMod = await mgr.load('pdfjs-dist', 'legacy/build/pdf.js');
        expect((legacyMod as any)?.legacyValue).toBe(42);

        // 两次加载走缓存（不重复 require）
        const legacyMod2 = await mgr.load('pdfjs-dist', 'legacy/build/pdf.js');
        expect(legacyMod2).toBe(legacyMod);

        // 卸载后子路径缓存一并清除
        await mgr.uninstall('pdfjs-dist');
        const legacyMod3 = await mgr.load('pdfjs-dist', 'legacy/build/pdf.js');
        expect(legacyMod3).toBeNull();
    });
});
