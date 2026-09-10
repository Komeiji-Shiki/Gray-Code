import type { ToolDeclaration } from '../types';
export interface DeclarationOptions { language: 'zh-CN' | 'en'; workspaces?: readonly { name: string }[]; precreateEmptyFile?: boolean }
/** 原工具声明共用同一工厂，宿主只提供语言与工作区信息。 */
export function createDeleteFileDeclaration(options: DeclarationOptions): ToolDeclaration {

    // 获取工作区信息
    const workspaces = options.workspaces ?? [];
    const isMultiRoot = workspaces.length > 1;
    // 模型声明语言：zh-CN → 中文，en/ja → 英文（ja 本阶段映射到英文说明）
    const isZh = options.language === 'zh-CN';
    
    // 数组格式强调说明
    const arrayFormatNote = isZh
        ? '\n\n**重要**：`paths` 参数必须是数组，即使只删一个文件。示例：`{"paths": ["file.txt"]}`，不要写成 `{"path": "file.txt"}`。'
        : '\n\n**IMPORTANT**: The `paths` parameter MUST be an array, even for a single file. Example: `{"paths": ["file.txt"]}`, NOT `{"path": "file.txt"}`.';
    
    // 根据工作区数量生成描述
    let description = isZh
        ? '删除一个或多个文件/目录。支持删除非空目录。' + arrayFormatNote
        : 'Delete one or more files or directories. Supports deleting non-empty directories.' + arrayFormatNote;
    let pathsDescription = isZh
        ? '要删除的文件或目录路径数组（相对于工作区根目录）。即使只删一个文件也必须传数组，例如：["file.txt"]'
        : 'Array of file or directory paths to delete (relative to workspace root). MUST be an array even for single file, e.g., ["file.txt"]';

    if (isMultiRoot) {
        description += isZh
            ? `\n\n多根工作区：必须使用 "workspace_name/path" 格式。可用工作区：${workspaces.map(w => w.name).join(', ')}`
            : `\n\nMulti-root workspace: Must use "workspace_name/path" format. Available workspaces: ${workspaces.map(w => w.name).join(', ')}`;
        pathsDescription = isZh
            ? '要删除的文件或目录路径数组，必须使用 "workspace_name/path" 格式。即使只删一个文件也必须传数组。'
            : 'Array of file or directory paths to delete, must use "workspace_name/path" format. MUST be an array even for single file.';
    }
    
    
return {
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
        };
}
