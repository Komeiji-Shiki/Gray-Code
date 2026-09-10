export { parseImageDimensions } from '../shared/imageDimensions';
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
import * as fs from 'fs';
import type { ToolContext } from '../types';
import { resolveFileToolPathWithInfo } from '../utils';
import { ensureOutsideWorkspaceAccessApproved } from '../file/outsideWorkspaceAccess';

/**
 * 读取图片文件（含工作区外 read 策略审批）
 *
 * 返回 data/mimeType/ext；失败返回 null。
 */
export async function readImageFile(
    imagePath: string,
    context?: ToolContext,
    displayName?: string
): Promise<{ data: Buffer; mimeType: string; ext: string } | null> {
    const { uri, isOutsideWorkspace } = resolveFileToolPathWithInfo(imagePath);
    if (!uri) {
        return null;
    }

    // 工作区外读取：按 read 策略审批（deny 拒绝 / ask 需确认 / allow 放行）。
    // 借用 read_file 策略是设计决定，但错误文案通过 displayName 展示真实工具名。
    if (isOutsideWorkspace) {
        const readAccessError = ensureOutsideWorkspaceAccessApproved('read_file', { path: imagePath }, context, displayName);
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
export async function saveImage(buffer: Buffer, outputPath: string, context?: ToolContext, displayName?: string): Promise<void> {
    const { uri, isOutsideWorkspace } = resolveFileToolPathWithInfo(outputPath);
    if (!uri) {
        throw new Error('No workspace folder open');
    }

    // 工作区外写入：按 write 策略审批（与 write_file 保持一致）；
    // 借用 write_file 策略是设计决定，但错误文案通过 displayName 展示真实工具名。
    if (isOutsideWorkspace) {
        const writeAccessError = ensureOutsideWorkspaceAccessApproved('write_file', { path: outputPath }, context, displayName);
        if (writeAccessError) {
            throw new Error(writeAccessError);
        }
    }

    // 确保目录存在（递归创建父目录）
    try {
        await fs.promises.mkdir(path.dirname(uri.fsPath), { recursive: true });
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


/**
 * 从 base64 图片数据解析尺寸（generate_image 用）
 */
export { parseImageDimensionsFromBase64, getImageDimensions, createFetchSignal } from './imageData';
