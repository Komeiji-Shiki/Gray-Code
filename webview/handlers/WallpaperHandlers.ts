/**
 * 桌面端背景图消息处理器
 *
 * 仅桌面端 UI 使用（远控端不涉及）：从外观设置选择本地图片作为应用窗口背景，
 * 并把图片内容以 data URL 形式交给渲染层（data: 已在 webview CSP 的 img-src 白名单内）。
 * 持久化只保存图片路径（ui.appearance.wallpaperPath），图片内容不落库，
 * 启动时经 getWallpaperImage 按路径重新读取；文件丢失时自动回退为纯色背景。
 */

import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import type { HandlerContext, MessageHandler } from '../types';

/** 背景图文件大小上限：10MB（base64 膨胀约 1/3，过大文件会拖慢 webview 传输并增加内存压力） */
export const MAX_WALLPAPER_BYTES = 10 * 1024 * 1024;

/**
 * 允许的背景图扩展名 → MIME 类型
 *
 * 刻意排除 SVG：SVG 可内嵌脚本/外部引用，即使 CSS background-image 不执行脚本，
 * 也不值得引入解析面；且位图背景视觉一致性更好。
 */
const WALLPAPER_EXTENSIONS: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp'
};

/** 打开对话框的文件过滤器（VS Code 与 Electron shim 均透传原生对话框） */
export const WALLPAPER_EXTENSION_FILTERS: Record<string, string[]> = {
    'Images': ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'],
    'All Files': ['*']
};

/** 背景图读取结果 */
export interface WallpaperImageResult {
    /** 图片文件绝对路径 */
    path: string;
    /** 文件名（用于展示） */
    name: string;
    /** data:image/*;base64,..（可安全用于 CSS background-image / img src） */
    dataUrl: string;
}

/**
 * 按扩展名校验图片文件头（magic bytes），防「改名换壳」的非图片内容以图片名义进入渲染层
 */
const MAGIC_BYTE_CHECKERS: Record<string, (buf: Buffer) => boolean> = {
    '.png': (b) => b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a,
    '.jpg': (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
    '.jpeg': (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
    '.gif': (b) => b.length >= 6 && (b.toString('latin1', 0, 6) === 'GIF87a' || b.toString('latin1', 0, 6) === 'GIF89a'),
    '.webp': (b) => b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP',
    '.bmp': (b) => b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d
};

/**
 * 校验并读取背景图文件，返回 data URL
 *
 * 独立纯函数（仅依赖 fs/path），供 pickWallpaper / getWallpaperImage 与单元测试复用：
 * - 扩展名必须在白名单内（大小写不敏感）
 * - 必须是常规文件（拒绝目录/特殊文件）
 * - 大小不得超过 MAX_WALLPAPER_BYTES（stat 预检 + 读取后复验，防 TOCTOU 换大文件）
 * - 文件头必须与声明的图片格式匹配（拒绝改名换壳的非图片内容）
 *
 * @throws 校验失败/读取失败时抛出 Error（message 为给用户看的文案）
 */
export async function readWallpaperFile(filePath: string): Promise<WallpaperImageResult> {
    const ext = path.extname(filePath).toLowerCase();
    const mime = WALLPAPER_EXTENSIONS[ext];
    if (!mime) {
        throw new Error(`Unsupported wallpaper image type: ${ext || '(no extension)'}`);
    }

    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
        throw new Error('Wallpaper path is not a file');
    }
    if (stat.size > MAX_WALLPAPER_BYTES) {
        throw new Error(`Wallpaper image is too large (max ${MAX_WALLPAPER_BYTES / 1024 / 1024}MB)`);
    }

    const buffer = await fs.readFile(filePath);
    // 读取后复验：stat 与 readFile 之间文件可能被替换
    if (buffer.length > MAX_WALLPAPER_BYTES) {
        throw new Error(`Wallpaper image is too large (max ${MAX_WALLPAPER_BYTES / 1024 / 1024}MB)`);
    }
    const magicOk = MAGIC_BYTE_CHECKERS[ext]?.(buffer);
    if (!magicOk) {
        throw new Error(`File content does not match image type: ${ext}`);
    }

    return {
        path: filePath,
        name: path.basename(filePath),
        dataUrl: `data:${mime};base64,${buffer.toString('base64')}`
    };
}

/**
 * 从设置页选择背景图：弹出打开对话框 → 校验并读取 → 返回路径 + data URL
 *
 * 响应：
 * - { cancelled: true }：用户取消
 * - { cancelled: false, path, name, dataUrl }：选中成功
 */
export const pickWallpaper: MessageHandler = async (data, requestId, ctx) => {
    try {
        const result = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            filters: WALLPAPER_EXTENSION_FILTERS,
            title: '选择背景图'
        });

        if (!result || result.length === 0) {
            ctx.sendResponse(requestId, { cancelled: true });
            return;
        }

        const image = await readWallpaperFile(result[0].fsPath);
        ctx.sendResponse(requestId, { cancelled: false, ...image });
    } catch (error: any) {
        ctx.sendError(requestId, 'PICK_WALLPAPER_ERROR', error?.message || 'Failed to load wallpaper image');
    }
};

/**
 * 按已保存路径重新读取背景图（启动时/设置变更后由渲染层调用）
 *
 * 安全约束：只允许读取「当前持久化配置中的 ui.appearance.wallpaperPath」，
 * 拒绝渲染层/远控端传入的任意路径（处理器注册在全局 registry，远控端同可调用，
 * 若不加校验会构成任意图片文件的读取面）。路径不一致、文件丢失/格式失效一律
 * 静默回退为空（path/dataUrl 均为空串），不向用户弹错——背景图是装饰性功能，缺了不影响使用。
 */
export const getWallpaperImage: MessageHandler = async (data, requestId, ctx) => {
    try {
        const { path: filePath } = data || {};
        // 仅允许读取当前已持久化的背景图路径（与 SettingsManager 内存态一致）
        const savedPath = ctx.settingsManager?.getSettings()?.ui?.appearance?.wallpaperPath;
        if (typeof filePath !== 'string' || !filePath.trim() || filePath !== savedPath) {
            ctx.sendResponse(requestId, { path: '', name: '', dataUrl: '' });
            return;
        }

        const image = await readWallpaperFile(filePath);
        ctx.sendResponse(requestId, { ...image });
    } catch {
        ctx.sendResponse(requestId, { path: '', name: '', dataUrl: '' });
    }
};

/**
 * 注册背景图处理器
 */
export function registerWallpaperHandlers(registry: Map<string, MessageHandler>): void {
    registry.set('pickWallpaper', pickWallpaper);
    registry.set('getWallpaperImage', getWallpaperImage);
}
