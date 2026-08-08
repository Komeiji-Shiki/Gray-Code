/**
 * media 工具公共图片辅助模块
 *
 * 修改原因：generate_image / remove_background / crop_image / resize_image / rotate_image
 * 五个工具各自重复实现 readImageFile / saveImage / 图片尺寸解析，细节存在漂移
 * （如 remove_background 的 readImageFile 漏了 gif 分支）。
 * 修改方式：统一收敛到本模块，五个工具改为 import。
 */

import * as vscode from 'vscode';
import * as path from 'path';
import type { ToolContext } from '../types';
import { resolveFileToolPathWithInfo } from '../utils';
import { ensureOutsideWorkspaceAccessApproved } from '../file/outsideWorkspaceAccess';
import { getSharp } from '../../modules/dependencies';

/**
 * 读取图片文件（含工作区外 read 策略审批）
 *
 * 返回 data/mimeType/ext；失败返回 null。
 */
export async function readImageFile(
    imagePath: string,
    context?: ToolContext
): Promise<{ data: Buffer; mimeType: string; ext: string } | null> {
    const { uri, isOutsideWorkspace } = resolveFileToolPathWithInfo(imagePath);
    if (!uri) {
        return null;
    }

    // 工作区外读取：按 read 策略审批（deny 拒绝 / ask 需确认 / allow 放行）
    if (isOutsideWorkspace) {
        const readAccessError = ensureOutsideWorkspaceAccessApproved('read_file', { path: imagePath }, context);
        if (readAccessError) {
            return null;
        }
    }

    try {
        const content = await vscode.workspace.fs.readFile(uri);
        const ext = path.extname(imagePath).toLowerCase();
        let mimeType = 'image/png';
        if (ext === '.jpg' || ext === '.jpeg') {
            mimeType = 'image/jpeg';
        } else if (ext === '.webp') {
            mimeType = 'image/webp';
        } else if (ext === '.gif') {
            mimeType = 'image/gif';
        }

        return {
            data: Buffer.from(content),
            mimeType,
            ext
        };
    } catch (error) {
        return null;
    }
}

/**
 * 保存图片到文件（含工作区外 write 策略审批 + 自动创建父目录）
 */
export async function saveImage(buffer: Buffer, outputPath: string, context?: ToolContext): Promise<void> {
    const { uri, isOutsideWorkspace } = resolveFileToolPathWithInfo(outputPath);
    if (!uri) {
        throw new Error('No workspace folder open');
    }

    // 工作区外写入：按 write 策略审批（与 write_file 保持一致）
    if (isOutsideWorkspace) {
        const writeAccessError = ensureOutsideWorkspaceAccessApproved('write_file', { path: outputPath }, context);
        if (writeAccessError) {
            throw new Error(writeAccessError);
        }
    }

    // 确保目录存在
    const dirUri = vscode.Uri.joinPath(uri, '..');
    try {
        await vscode.workspace.fs.createDirectory(dirUri);
    } catch {
        // 目录可能已存在
    }

    // 写入文件
    await vscode.workspace.fs.writeFile(uri, buffer);
}

/**
 * 手动解析图片尺寸（PNG / JPEG / WebP 头部）。
 *
 * 合并了 remove_background 与 generate_image 两套实现：
 * JPEG 覆盖 SOF0-SOF3，WebP 覆盖 VP8 / VP8L / VP8X。
 */
export function parseImageDimensions(buffer: Buffer, mimeType: string): { width: number; height: number } | null {
    try {
        if (mimeType === 'image/png') {
            // PNG: 签名 + IHDR 块宽高（偏移 16-23，大端序）
            if (buffer.length >= 24 &&
                buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47 &&
                buffer[4] === 0x0D && buffer[5] === 0x0A && buffer[6] === 0x1A && buffer[7] === 0x0A) {
                const width = buffer.readUInt32BE(16);
                const height = buffer.readUInt32BE(20);
                if (width > 0 && height > 0 && width < 100000 && height < 100000) {
                    return { width, height };
                }
            }
        } else if (mimeType === 'image/jpeg') {
            // JPEG: 扫描 SOF0-SOF3 标记
            if (buffer.length >= 2 && buffer[0] === 0xFF && buffer[1] === 0xD8) {
                let i = 2;
                while (i < buffer.length - 9) {
                    if (buffer[i] === 0xFF) {
                        const marker = buffer[i + 1];
                        if (marker >= 0xC0 && marker <= 0xC3) {
                            const height = buffer.readUInt16BE(i + 5);
                            const width = buffer.readUInt16BE(i + 7);
                            if (width > 0 && height > 0) {
                                return { width, height };
                            }
                        }
                        if (i + 3 < buffer.length) {
                            const segmentLength = buffer.readUInt16BE(i + 2);
                            i += 2 + segmentLength;
                        } else {
                            break;
                        }
                    } else {
                        i++;
                    }
                }
            }
        } else if (mimeType === 'image/webp') {
            if (buffer.length >= 30 && buffer.toString('ascii', 0, 4) === 'RIFF' &&
                buffer.toString('ascii', 8, 12) === 'WEBP') {
                const format = buffer.toString('ascii', 12, 16);
                if (format === 'VP8 ') {
                    // Lossy WebP
                    const width = buffer.readUInt16LE(26) & 0x3FFF;
                    const height = buffer.readUInt16LE(28) & 0x3FFF;
                    if (width > 0 && height > 0) {
                        return { width, height };
                    }
                } else if (format === 'VP8L') {
                    // Lossless WebP
                    const b0 = buffer[21];
                    const b1 = buffer[22];
                    const b2 = buffer[23];
                    const b3 = buffer[24];
                    const width = 1 + (((b1 & 0x3F) << 8) | b0);
                    const height = 1 + (((b3 & 0xF) << 10) | (b2 << 2) | ((b1 & 0xC0) >> 6));
                    if (width > 0 && height > 0) {
                        return { width, height };
                    }
                } else if (format === 'VP8X') {
                    // Extended WebP
                    const width = 1 + (buffer[24] | (buffer[25] << 8) | (buffer[26] << 16));
                    const height = 1 + (buffer[27] | (buffer[28] << 8) | (buffer[29] << 16));
                    if (width > 0 && height > 0) {
                        return { width, height };
                    }
                }
            }
        }
    } catch {
        // 解析失败
    }
    return null;
}

/**
 * 从 base64 图片数据解析尺寸（generate_image 用）
 */
export function parseImageDimensionsFromBase64(base64Data: string, mimeType: string): { width: number; height: number } | null {
    try {
        return parseImageDimensions(Buffer.from(base64Data, 'base64'), mimeType);
    } catch {
        return null;
    }
}

/**
 * 获取图片尺寸（优先 sharp，失败回退手动解析）
 */
export async function getImageDimensions(buffer: Buffer, mimeType: string): Promise<{ width: number; height: number } | null> {
    try {
        const sharp = await getSharp();
        if (sharp) {
            const metadata = await sharp(buffer).metadata();
            if (metadata.width && metadata.height) {
                return { width: metadata.width, height: metadata.height };
            }
        }
    } catch {
        // sharp 不可用或解析失败，继续尝试手动解析
    }
    return parseImageDimensions(buffer, mimeType);
}
