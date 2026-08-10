/**
 * 桌面端背景图处理器（WallpaperHandlers）单元测试
 *
 * 覆盖：
 * - readWallpaperFile：MIME 映射（含大小写）、扩展名白名单（SVG 拒绝）、目录拒绝、大小上限、文件缺失
 * - pickWallpaper：对话框全流程（取消/选中/读取失败）
 * - getWallpaperImage：按已存路径重读 + 空路径/文件丢失静默回退
 * - 处理器注册表
 * - DEFAULT_GLOBAL_SETTINGS 默认值
 */

import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
    readWallpaperFile,
    pickWallpaper,
    getWallpaperImage,
    registerWallpaperHandlers,
    MAX_WALLPAPER_BYTES
} from '../../../webview/handlers/WallpaperHandlers';
import { DEFAULT_GLOBAL_SETTINGS } from '../../../backend/modules/settings/generalTypes';

/** 1x1 透明 PNG（真实魔数，仅用于字节内容，校验不依赖内容） */
const TINY_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
);

function makeCtx() {
    const responses: Array<{ requestId: string; data: any }> = [];
    const errors: Array<{ requestId: string; code: string; message: string }> = [];
    const ctx: any = {
        sendResponse: (requestId: string, data: any) => responses.push({ requestId, data }),
        sendError: (requestId: string, code: string, message: string) => errors.push({ requestId, code, message })
    };
    return { ctx, responses, errors };
}

let tempDir: string;

beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'graycode-wallpaper-test-'));
});

afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
});

describe('readWallpaperFile', () => {
    it('读取 PNG 并返回正确 MIME 的 data URL', async () => {
        const file = path.join(tempDir, 'bg.png');
        await fs.writeFile(file, TINY_PNG);

        const result = await readWallpaperFile(file);

        expect(result.path).toBe(file);
        expect(result.name).toBe('bg.png');
        expect(result.dataUrl).toMatch(/^data:image\/png;base64,/);
        expect(Buffer.from(result.dataUrl.split(',')[1], 'base64')).toEqual(TINY_PNG);
    });

    it('JPG/JPEG/WebP/GIF/BMP 扩展名映射正确（各格式合法文件头）', async () => {
        // 各格式的最小合法文件头（magic bytes 校验只需头部）
        const headers: Array<[string, string, Buffer]> = [
            ['.jpg', 'image/jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])],
            ['.jpeg', 'image/jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])],
            ['.webp', 'image/webp', Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')])],
            ['.gif', 'image/gif', Buffer.from('GIF89a')],
            ['.bmp', 'image/bmp', Buffer.from([0x42, 0x4d, 0x00, 0x00, 0x00, 0x00])]
        ];
        for (const [ext, mime, header] of headers) {
            const file = path.join(tempDir, `bg${ext}`);
            await fs.writeFile(file, header);
            const result = await readWallpaperFile(file);
            expect(result.dataUrl).toMatch(new RegExp(`^data:${mime};base64,`));
        }
    });

    it('扩展名大小写不敏感（.PNG 同样识别）', async () => {
        const file = path.join(tempDir, 'bg.PNG');
        await fs.writeFile(file, TINY_PNG);
        const result = await readWallpaperFile(file);
        expect(result.dataUrl).toMatch(/^data:image\/png;base64,/);
    });

    it('拒绝 SVG（脚本面防御）', async () => {
        const file = path.join(tempDir, 'bg.svg');
        await fs.writeFile(file, '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
        await expect(readWallpaperFile(file)).rejects.toThrow(/Unsupported wallpaper image type/);
    });

    it('拒绝无扩展名文件', async () => {
        const file = path.join(tempDir, 'bg-no-ext');
        await fs.writeFile(file, TINY_PNG);
        await expect(readWallpaperFile(file)).rejects.toThrow(/Unsupported wallpaper image type/);
    });

    it('拒绝改名换壳的非图片内容（magic bytes 校验）', async () => {
        const file = path.join(tempDir, 'fake.png');
        await fs.writeFile(file, Buffer.from('this is not a png at all!'));
        await expect(readWallpaperFile(file)).rejects.toThrow(/content does not match/);
    });

    it('大小恰好等于上限的文件通过校验', async () => {
        const file = path.join(tempDir, 'exact-limit.png');
        await fs.writeFile(file, TINY_PNG);
        await fs.truncate(file, MAX_WALLPAPER_BYTES);
        // 截断后头部已破坏（PNG 魔数在 8 字节内仍在，其余为空洞），重建合法头部：
        await fs.writeFile(file, Buffer.concat([TINY_PNG, Buffer.alloc(MAX_WALLPAPER_BYTES - TINY_PNG.length)]));
        const result = await readWallpaperFile(file);
        expect(result.dataUrl).toMatch(/^data:image\/png;base64,/);
    });

    it('拒绝目录（带合法扩展名的目录同样拒绝）', async () => {
        const dir = path.join(tempDir, 'subdir.png');
        await fs.mkdir(dir);
        await expect(readWallpaperFile(dir)).rejects.toThrow(/not a file/);
    });

    it('拒绝超过大小上限的文件', async () => {
        const file = path.join(tempDir, 'too-large.png');
        // truncate 创建稀疏文件：逻辑大小超限，磁盘开销可忽略
        await fs.writeFile(file, TINY_PNG);
        await fs.truncate(file, MAX_WALLPAPER_BYTES + 1);
        await expect(readWallpaperFile(file)).rejects.toThrow(/too large/);
    });

    it('文件不存在时抛错', async () => {
        const missing = path.join(tempDir, 'missing.png');
        await expect(readWallpaperFile(missing)).rejects.toThrow();
    });
});

describe('pickWallpaper', () => {
    it('对话框取消 → 返回 cancelled:true 且不报错', async () => {
        (vscode.window.showOpenDialog as jest.Mock).mockResolvedValueOnce(undefined);
        const { ctx, responses, errors } = makeCtx();

        await pickWallpaper({}, 'req-1', ctx);

        expect(errors).toHaveLength(0);
        expect(responses).toHaveLength(1);
        expect(responses[0]).toEqual({ requestId: 'req-1', data: { cancelled: true } });
    });

    it('选中合法图片 → 返回路径 + data URL', async () => {
        const file = path.join(tempDir, 'picked.png');
        await fs.writeFile(file, TINY_PNG);
        (vscode.window.showOpenDialog as jest.Mock).mockResolvedValueOnce([{ fsPath: file }]);
        const { ctx, responses, errors } = makeCtx();

        await pickWallpaper({}, 'req-2', ctx);

        expect(errors).toHaveLength(0);
        expect(responses).toHaveLength(1);
        const data = responses[0].data;
        expect(data.cancelled).toBe(false);
        expect(data.path).toBe(file);
        expect(data.name).toBe('picked.png');
        expect(data.dataUrl).toMatch(/^data:image\/png;base64,/);
    });

    it('选中非法文件（如 SVG）→ 发送 PICK_WALLPAPER_ERROR', async () => {
        const file = path.join(tempDir, 'picked.svg');
        await fs.writeFile(file, '<svg/>');
        (vscode.window.showOpenDialog as jest.Mock).mockResolvedValueOnce([{ fsPath: file }]);
        const { ctx, responses, errors } = makeCtx();

        await pickWallpaper({}, 'req-3', ctx);

        expect(responses).toHaveLength(0);
        expect(errors).toHaveLength(1);
        expect(errors[0].requestId).toBe('req-3');
        expect(errors[0].code).toBe('PICK_WALLPAPER_ERROR');
        expect(errors[0].message).toMatch(/Unsupported wallpaper image type/);
    });

    it('对话框本身抛错 → 发送 PICK_WALLPAPER_ERROR', async () => {
        (vscode.window.showOpenDialog as jest.Mock).mockRejectedValueOnce(new Error('dialog exploded'));
        const { ctx, responses, errors } = makeCtx();

        await pickWallpaper({}, 'req-3b', ctx);

        expect(responses).toHaveLength(0);
        expect(errors).toHaveLength(1);
        expect(errors[0].code).toBe('PICK_WALLPAPER_ERROR');
        expect(errors[0].message).toMatch(/dialog exploded/);
    });
});

describe('getWallpaperImage', () => {
    /** 构造携带 settingsManager（持久化背景图路径）的 ctx */
    function makeSettingsCtx(savedPath?: string) {
        const base = makeCtx();
        base.ctx.settingsManager = {
            getSettings: () => ({ ui: { appearance: { wallpaperPath: savedPath ?? '' } } })
        };
        return base;
    }

    it('按已存路径重读 → 返回 data URL', async () => {
        const file = path.join(tempDir, 'saved.png');
        await fs.writeFile(file, TINY_PNG);
        const { ctx, responses } = makeSettingsCtx(file);

        await getWallpaperImage({ path: file }, 'req-4', ctx);

        expect(responses).toHaveLength(1);
        expect(responses[0].data.dataUrl).toMatch(/^data:image\/png;base64,/);
        expect(responses[0].data.path).toBe(file);
    });

    it('空路径/未传路径 → 静默返回空（不报错）', async () => {
        for (const payload of [{}, { path: '' }, { path: '   ' }]) {
            const { ctx, responses, errors } = makeSettingsCtx();
            await getWallpaperImage(payload, 'req-empty', ctx);
            expect(errors).toHaveLength(0);
            expect(responses).toHaveLength(1);
            expect(responses[0].data).toEqual({ path: '', name: '', dataUrl: '' });
        }
    });

    it('请求路径与持久化路径不一致 → 拒绝读取，静默返回空（任意路径读取面阻断）', async () => {
        const persisted = path.join(tempDir, 'persisted.png');
        const attackerFile = path.join(tempDir, 'secret.png');
        await fs.writeFile(persisted, TINY_PNG);
        await fs.writeFile(attackerFile, TINY_PNG);
        const { ctx, responses, errors } = makeSettingsCtx(persisted);

        await getWallpaperImage({ path: attackerFile }, 'req-6', ctx);

        expect(errors).toHaveLength(0);
        expect(responses).toHaveLength(1);
        expect(responses[0].data).toEqual({ path: '', name: '', dataUrl: '' });
    });

    it('文件已被删除 → 静默回退为空（不向用户报错）', async () => {
        const file = path.join(tempDir, 'deleted.png');
        await fs.writeFile(file, TINY_PNG);
        await fs.unlink(file);
        const { ctx, responses, errors } = makeSettingsCtx(file);

        await getWallpaperImage({ path: file }, 'req-5', ctx);

        expect(errors).toHaveLength(0);
        expect(responses).toHaveLength(1);
        expect(responses[0].data).toEqual({ path: '', name: '', dataUrl: '' });
    });

    it('持久化路径指向目录 → 静默回退为空', async () => {
        const dir = path.join(tempDir, 'dir.png');
        await fs.mkdir(dir);
        const { ctx, responses, errors } = makeSettingsCtx(dir);

        await getWallpaperImage({ path: dir }, 'req-7', ctx);

        expect(errors).toHaveLength(0);
        expect(responses).toHaveLength(1);
        expect(responses[0].data).toEqual({ path: '', name: '', dataUrl: '' });
    });
});

describe('registerWallpaperHandlers', () => {
    it('注册 pickWallpaper / getWallpaperImage 两个处理器', () => {
        const registry = new Map<string, any>();
        registerWallpaperHandlers(registry);
        expect(registry.has('pickWallpaper')).toBe(true);
        expect(registry.has('getWallpaperImage')).toBe(true);
        expect(registry.size).toBe(2);
    });
});

describe('DEFAULT_GLOBAL_SETTINGS 背景图默认值', () => {
    it('wallpaperPath 为空字符串、wallpaperOpacity 为 30', () => {
        const appearance = DEFAULT_GLOBAL_SETTINGS.ui?.appearance;
        expect(appearance?.wallpaperPath).toBe('');
        expect(appearance?.wallpaperOpacity).toBe(30);
    });
});
