import { createDirectoryDeclaration } from './createDirectoryDeclaration';
/**
 * 创建目录工具
 *
 * 支持创建单个或多个目录
 * 支持多工作区（Multi-root Workspaces）
 */

import * as fs from 'fs';
import type { Tool, ToolResult, ToolContext } from '../types';
import { parseArgs } from '../types';
import { resolveUri, getAllWorkspaces } from '../utils';
import { ensureOutsideWorkspaceAccessApproved } from './outsideWorkspaceAccess';
import { getActualLanguage } from '../../i18n';
import { resolveLocalizationLanguage } from '../localization/types';

/**
 * 单个目录创建结果
 */
interface CreateResult {
    path: string;
    success: boolean;
    error?: string;
}

/**
 * create_directory 的规范化参数形状。
 */
interface CreateDirectoryArgs {
    paths: string[];
}

/**
 * 创建单个目录
 */
async function createSingleDirectory(dirPath: string): Promise<CreateResult> {
    const uri = resolveUri(dirPath);
    if (!uri) {
        return {
            path: dirPath,
            success: false,
            error: 'No workspace folder open'
        };
    }

    try {
        // 递归创建（父目录自动创建，与描述“parent directories will be created automatically”一致）
        await fs.promises.mkdir(uri.fsPath, { recursive: true });
        return {
            path: dirPath,
            success: true
        };
    } catch (error) {
        return {
            path: dirPath,
            success: false,
            error: error instanceof Error ? error.message : String(error)
        };
    }
}

/**
 * 创建创建目录工具
 */
export function createCreateDirectoryTool(): Tool {
return {
        declaration: createDirectoryDeclaration({language: resolveLocalizationLanguage(getActualLanguage()) === 'zh-CN' ? 'zh-CN' : 'en', workspaces: getAllWorkspaces(), precreateEmptyFile: true}),
        handler: async (args, context?: ToolContext): Promise<ToolResult> => {
            const pathList = parseArgs<CreateDirectoryArgs>(args).paths;
            if (!pathList || !Array.isArray(pathList) || pathList.length === 0) {
                return { success: false, error: 'paths is required' };
            }

            // 越权防护：拒绝在工作区之外创建目录（子代理/直调工具链路同样生效）
            const accessError = ensureOutsideWorkspaceAccessApproved('create_directory', args, context);
            if (accessError) {
                return { success: false, error: accessError };
            }

            const results: CreateResult[] = [];
            let successCount = 0;
            let failCount = 0;

            for (const dirPath of pathList) {
                const result = await createSingleDirectory(dirPath);
                results.push(result);
                
                if (result.success) {
                    successCount++;
                } else {
                    failCount++;
                }
            }

            // 简化返回结构：类似 delete_file 的风格
            const allSuccess = failCount === 0;
            const createdPaths = results.filter(r => r.success).map(r => r.path);
            const failedPaths = results.filter(r => !r.success).map(r => `${r.path}: ${r.error}`);
            
            let message: string;
            if (allSuccess) {
                message = `Created: ${createdPaths.join(', ')}`;
            } else if (successCount > 0) {
                message = `Created: ${createdPaths.join(', ')}\nFailed: ${failedPaths.join(', ')}`;
            } else {
                message = `Create failed: ${failedPaths.join(', ')}`;
            }

            return {
                success: allSuccess,
                data: {
                    message,
                    createdPaths,
                    failedPaths: results.filter(r => !r.success).map(r => r.path)
                },
                error: allSuccess ? undefined : `${failCount} directories failed to create`
            };
        }
    };
}

/**
 * 注册创建目录工具
 */
export function registerCreateDirectory(): Tool {
    return createCreateDirectoryTool();
}