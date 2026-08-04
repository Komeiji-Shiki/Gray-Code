/**
 * 删除文件/目录工具
 *
 * 支持删除单个或多个文件和目录（包括非空目录）
 * 支持多工作区（Multi-root Workspaces）
 */

import * as vscode from 'vscode';
import type { Tool, ToolResult } from '../types';
import { resolveUri, getAllWorkspaces, normalizePathForComparison } from '../utils';

/**
 * 删除结果
 */
interface DeleteResult {
    path: string;
    success: boolean;
    error?: string;
}

/**
 * 创建删除文件工具
 */
export function createDeleteFileTool(): Tool {
    // 获取工作区信息
    const workspaces = getAllWorkspaces();
    const isMultiRoot = workspaces.length > 1;
    
    // 数组格式强调说明
    const arrayFormatNote = '\n\n**IMPORTANT**: The `paths` parameter MUST be an array, even for a single file. Example: `{"paths": ["file.txt"]}`, NOT `{"path": "file.txt"}`.';
    
    // 根据工作区数量生成描述
    let description = 'Delete one or more files or directories. Supports deleting non-empty directories.' + arrayFormatNote;
    let pathsDescription = 'Array of file or directory paths to delete (relative to workspace root). MUST be an array even for single file, e.g., ["file.txt"]';

    if (isMultiRoot) {
        description += `\n\nMulti-root workspace: Must use "workspace_name/path" format. Available workspaces: ${workspaces.map(w => w.name).join(', ')}`;
        pathsDescription = `Array of file or directory paths to delete, must use "workspace_name/path" format. MUST be an array even for single file.`;
    }
    
    return {
        declaration: {
            name: 'delete_file',
            description,
            category: 'file',
            parameters: {
                type: 'object',
                properties: {
                    paths: {
                        type: 'array',
                        items: {
                            type: 'string'
                        },
                        description: pathsDescription
                    }
                },
                required: ['paths']
            }
        },
        handler: async (args): Promise<ToolResult> => {
            const pathList = args.paths as string[];
            if (!pathList || !Array.isArray(pathList) || pathList.length === 0) {
                return { success: false, error: 'paths is required' };
            }

            const results: DeleteResult[] = [];
            let successCount = 0;
            let failCount = 0;

            // 所有工作区根（规范化后）的集合，用于拒绝指向根目录自身的删除。
            // 必须在 handler 内实时获取：工具创建时的快照在运行期增删工作区后会过期。
            // 比较必须做路径规范化：Windows 文件系统大小写不敏感，而 outside-workspace
            // 门（utils.isPathInsideOrEqual）在 win32 上统一 toLowerCase——若这里用大小写
            // 敏感的精确比较，模型传入盘符/目录大小写变体（如 C:\Users\Foo\PROJ）时
            // 可绕过防护，递归删除整个工作区。
            const rootFsPaths = getAllWorkspaces().map(w => normalizePathForComparison(w.uri.fsPath));

            for (const filePath of pathList) {
                // 防护：空串、"."、".." 等路径解析后指向工作区根或工作区外，
                // 一旦递归删除将抹掉整个工作区（无回收站、无二次确认），必须拒绝。
                if (!filePath || filePath === '.' || filePath === '..') {
                    results.push({
                        path: filePath,
                        success: false,
                        error: `Refusing to delete "${filePath}": path resolves to the workspace root or outside it. Specify an explicit file or directory.`
                    });
                    failCount++;
                    continue;
                }

                const uri = resolveUri(filePath);
                if (!uri) {
                    results.push({
                        path: filePath,
                        success: false,
                        error: 'No workspace folder open'
                    });
                    failCount++;
                    continue;
                }

                // 防护：解析结果等于任一工作区根 → 递归删除整个工作区，拒绝。
                // （ToolExecutionService 的 outsideWorkspaceAccess 只拦截工作区之外的路径，
                //   拦不住根目录本身，因此这里必须显式校验。）
                const resolvedFs = normalizePathForComparison(uri.fsPath);
                if (rootFsPaths.includes(resolvedFs)) {
                    results.push({
                        path: filePath,
                        success: false,
                        error: `Refusing to delete workspace root: ${uri.fsPath}`
                    });
                    failCount++;
                    continue;
                }

                // 防护：解析结果是任一工作区根的祖先目录（如 '../'、'sub/../../' 会解析到
                // 工作区父目录，'./..' 同样）。递归删除祖先目录会把整个工作区连同其父级
                // 内容一并抹掉，必须拒绝。字符串前缀比较即可：祖先路径是根的严格前缀。
                const isAncestorOfWorkspaceRoot = rootFsPaths.some(root => {
                    const trimmedRoot = root.replace(/\/+$/, '');
                    return trimmedRoot.length > 0 && trimmedRoot.startsWith(resolvedFs.replace(/\/+$/, '') + '/');
                });
                if (isAncestorOfWorkspaceRoot) {
                    results.push({
                        path: filePath,
                        success: false,
                        error: `Refusing to delete a parent directory of the workspace root: ${uri.fsPath}`
                    });
                    failCount++;
                    continue;
                }

                try {
                    // 使用 recursive: true 支持删除非空目录
                    await vscode.workspace.fs.delete(uri, { recursive: true });
                    results.push({
                        path: filePath,
                        success: true
                    });
                    successCount++;
                } catch (error) {
                    results.push({
                        path: filePath,
                        success: false,
                        error: error instanceof Error ? error.message : String(error)
                    });
                    failCount++;
                }
            }

            // 返回简洁的结果消息
            const allSuccess = failCount === 0;
            const deletedPaths = results.filter(r => r.success).map(r => r.path);
            const failedPaths = results.filter(r => !r.success).map(r => `${r.path}: ${r.error}`);
            
            let message: string;
            if (allSuccess) {
                message = `Deleted: ${deletedPaths.join(', ')}`;
            } else if (successCount > 0) {
                message = `Deleted: ${deletedPaths.join(', ')}\nFailed: ${failedPaths.join(', ')}`;
            } else {
                message = `Delete failed: ${failedPaths.join(', ')}`;
            }

            return {
                success: allSuccess,
                data: {
                    message,
                    deletedPaths,
                    failedPaths: results.filter(r => !r.success).map(r => r.path)
                },
                error: allSuccess ? undefined : `${failCount} deletions failed`
            };
        }
    };
}

/**
 * 注册删除文件工具
 */
export function registerDeleteFile(): Tool {
    return createDeleteFileTool();
}