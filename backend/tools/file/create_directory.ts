/**
 * 创建目录工具
 *
 * 支持创建单个或多个目录
 * 支持多工作区（Multi-root Workspaces）
 */

import * as vscode from 'vscode';
import type { Tool, ToolResult, ToolContext } from '../types';
import { resolveUri, getAllWorkspaces } from '../utils';
import { ensureOutsideWorkspaceAccessApproved } from './outsideWorkspaceAccess';

/**
 * 单个目录创建结果
 */
interface CreateResult {
    path: string;
    success: boolean;
    error?: string;
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
        await vscode.workspace.fs.createDirectory(uri);
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
    // 获取工作区信息
    const workspaces = getAllWorkspaces();
    const isMultiRoot = workspaces.length > 1;
    
    // 根据工作区数量生成描述
    // 数组格式强调说明
    const arrayFormatNote = '\n\n**IMPORTANT**: The `paths` parameter MUST be an array, even for a single directory. Example: `{"paths": ["new-dir"]}`, NOT `{"path": "new-dir"}`.';
    
    let description = 'Create one or more directories in the workspace (parent directories will be created automatically)' + arrayFormatNote;
    let pathsDescription = 'Array of directory paths (relative to workspace root). MUST be an array even for single directory, e.g., ["new-dir"]';

    if (isMultiRoot) {
        description += `\n\nMulti-root workspace: Must use "workspace_name/path" format. Available workspaces: ${workspaces.map(w => w.name).join(', ')}`;
        pathsDescription = `Array of directory paths, must use "workspace_name/path" format. MUST be an array even for single directory.`;
    }
    
    return {
        declaration: {
            name: 'create_directory',
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
        handler: async (args, context?: ToolContext): Promise<ToolResult> => {
            const pathList = args.paths as string[];
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