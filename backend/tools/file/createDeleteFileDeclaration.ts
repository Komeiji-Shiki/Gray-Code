import type { ToolDeclaration } from '../types';
export interface DeclarationOptions { language: 'zh-CN' | 'en'; workspaces?: readonly { name: string }[]; precreateEmptyFile?: boolean }
/** 原工具声明共用同一工厂，宿主只提供语言与工作区信息。 */
export function createDeleteFileDeclaration(options: DeclarationOptions): ToolDeclaration {

    // 获取工作区信息
    const workspaces = options.workspaces ?? [];
    const isMultiRoot = workspaces.length > 1;
    // 模型声明语言：zh-CN → 中文，en/ja → 英文（ja 本阶段映射到英文说明）
    const isZh = options.language === 'zh-CN';
    
    let description = isZh
        ? '删除一个或多个文件或目录，非空目录会连同内容一起删除。'
        : 'Delete one or more files or directories. Non-empty directories are deleted together with their contents.';
    let pathsDescription = isZh
        ? '要删除的文件或目录路径数组，相对于工作区根目录。即使只有一个也要传数组，例如 ["file.txt"]。'
        : 'Array of file or directory paths to delete, relative to the workspace root. Pass an array even for a single path, for example ["file.txt"].';

    if (isMultiRoot) {
        description += isZh
            ? `\n\n当前是多根工作区，路径请使用 "workspace_name/path" 格式。可用工作区：${workspaces.map(w => w.name).join(', ')}。`
            : `\n\nThis is a multi-root workspace, so paths must use the "workspace_name/path" format. Available workspaces: ${workspaces.map(w => w.name).join(', ')}.`;
        pathsDescription = isZh
            ? '要删除的文件或目录路径数组，格式为 "workspace_name/path"。即使只有一个也要传数组。'
            : 'Array of file or directory paths to delete, in the "workspace_name/path" format. Pass an array even for a single path.';
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
