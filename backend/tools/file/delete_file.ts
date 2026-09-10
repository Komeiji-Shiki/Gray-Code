import { createDeleteFileDeclaration } from './createDeleteFileDeclaration';
/**
 * 删除文件/目录工具
 *
 * 支持删除单个或多个文件和目录（包括非空目录）
 * 支持多工作区（Multi-root Workspaces）
 */

import * as vscode from 'vscode';
import type { Tool, ToolResult, ToolContext } from '../types';
import { parseArgs } from '../types';
import { resolveUri, getAllWorkspaces, normalizePathForComparison } from '../utils';
import { ensureOutsideWorkspaceAccessApproved } from './outsideWorkspaceAccess';
import { getActualLanguage } from '../../i18n';
import { resolveLocalizationLanguage } from '../localization/types';

/**
 * 删除结果
 */
interface DeleteResult {
    path: string;
    success: boolean;
    error?: string;
}

/**
 * delete_file 的规范化参数形状。
 */
interface DeleteFileArgs {
    paths: string[];
}

/**
 * 创建删除文件工具
 */
export function createDeleteFileTool(): Tool {
return {
        declaration: createDeleteFileDeclaration({language: resolveLocalizationLanguage(getActualLanguage()) === 'zh-CN' ? 'zh-CN' : 'en', workspaces: getAllWorkspaces(), precreateEmptyFile: true}),
        handler: async (args, context?: ToolContext): Promise<ToolResult> => {
            const pathList = parseArgs<DeleteFileArgs>(args).paths;
            if (!pathList || !Array.isArray(pathList) || pathList.length === 0) {
                return { success: false, error: 'paths is required' };
            }

            // 越权防护：拒绝删除工作区之外的文件/目录（子代理/直调工具链路同样生效）
            const accessError = ensureOutsideWorkspaceAccessApproved('delete_file', args, context);
            if (accessError) {
                return { success: false, error: accessError };
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
                if (rootFsPaths.includes(normalizePathForComparison(uri.fsPath))) {
                    results.push({
                        path: filePath,
                        success: false,
                        error: `Refusing to delete workspace root: ${uri.fsPath}`
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