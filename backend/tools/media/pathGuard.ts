/**
 * 媒体工具路径与资源护栏
 *
 * 媒体工具（crop/resize/rotate/remove_background/generate_image）不在
 * outsideWorkspaceAccess aware 集合内，历史上可任意读写工作区外路径、
 * 且无输入大小上限。这里统一提供：
 * - 输入/输出路径的工作区包含性校验（符号链接感知）
 * - 输入文件大小上限（防止超大图片全量读入内存造成扩展宿主卡死）
 */

import * as vscode from 'vscode';
import { resolveUri, getAllWorkspaces, isPathInsideOrEqualReal, getWorkspaceByUri } from '../utils';

/** 媒体输入文件大小上限：50MB（超过即拒绝，避免内存 DoS） */
export const MEDIA_MAX_INPUT_BYTES = 50 * 1024 * 1024;

/**
 * 校验媒体工具的输入/输出路径必须位于任一工作区内。
 *
 * @param inputPath 输入路径
 * @param outputPath 输出路径（可选）
 * @param maskPath 掩码路径（可选）
 * @param activeWorkspaceUri 首选工作区 URI（可选，多工作区无前缀时的兜底）
 * @returns 错误信息；安全时返回 null
 */
export function ensureMediaPathsSafe(
    inputPath: string,
    outputPath?: string,
    maskPath?: string,
    activeWorkspaceUri?: string
): string | null {
    const workspaces = getAllWorkspaces();
    // 无打开工作区但对话绑定工作区仍存在（虚拟解析）时允许继续
    if (workspaces.length === 0 && !getWorkspaceByUri(activeWorkspaceUri as string)) {
        return 'No workspace folder open';
    }

    const isInsideAnyWorkspace = (uri: vscode.Uri): boolean => {
        if (workspaces.some(w => isPathInsideOrEqualReal(uri.fsPath, w.uri.fsPath))) {
            return true;
        }
        // 对话绑定工作区（可能已关闭）：命中虚拟工作区同样视为工作区内
        if (activeWorkspaceUri) {
            const bound = getWorkspaceByUri(activeWorkspaceUri);
            if (bound && isPathInsideOrEqualReal(uri.fsPath, bound.fsPath)) {
                return true;
            }
        }
        return false;
    };

    const inputUri = resolveUri(inputPath, activeWorkspaceUri);
    if (!inputUri) {
        return `Cannot resolve input path: ${inputPath}`;
    }
    if (!isInsideAnyWorkspace(inputUri)) {
        return `Input path is outside the workspace: ${inputPath}`;
    }

    if (outputPath) {
        const outputUri = resolveUri(outputPath, activeWorkspaceUri);
        if (!outputUri) {
            return `Cannot resolve output path: ${outputPath}`;
        }
        if (!isInsideAnyWorkspace(outputUri)) {
            return `Output path is outside the workspace: ${outputPath}`;
        }
    }

    if (maskPath) {
        const maskUri = resolveUri(maskPath, activeWorkspaceUri);
        if (!maskUri) {
            return `Cannot resolve mask path: ${maskPath}`;
        }
        if (!isInsideAnyWorkspace(maskUri)) {
            return `Mask path is outside the workspace: ${maskPath}`;
        }
    }

    return null;
}
