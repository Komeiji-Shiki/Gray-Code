import type { ToolDeclaration } from '../types';
export interface DeclarationOptions { language: 'zh-CN' | 'en'; workspaces?: readonly { name: string }[]; precreateEmptyFile?: boolean }
/** 原工具声明共用同一工厂，宿主只提供语言与工作区信息。 */
export function createDirectoryDeclaration(options: DeclarationOptions): ToolDeclaration {

    // 获取工作区信息
    const workspaces = options.workspaces ?? [];
    const isMultiRoot = workspaces.length > 1;
    // 模型声明语言：zh-CN → 中文，en/ja → 英文（ja 本阶段映射到英文说明）
    const isZh = options.language === 'zh-CN';
    
    let description = isZh
        ? '在工作区中创建一个或多个目录，缺少的父目录会自动创建。'
        : 'Create one or more directories in the workspace. Missing parent directories are created automatically.';
    let pathsDescription = isZh
        ? '目录路径数组，相对于工作区根目录。即使只有一个也要传数组，例如 ["new-dir"]。'
        : 'Array of directory paths relative to the workspace root. Pass an array even for a single directory, for example ["new-dir"].';

    if (isMultiRoot) {
        description += isZh
            ? `\n\n当前是多根工作区，路径请使用 "workspace_name/path" 格式。可用工作区：${workspaces.map(w => w.name).join(', ')}。`
            : `\n\nThis is a multi-root workspace, so paths must use the "workspace_name/path" format. Available workspaces: ${workspaces.map(w => w.name).join(', ')}.`;
        pathsDescription = isZh
            ? '目录路径数组，格式为 "workspace_name/path"。即使只有一个也要传数组。'
            : 'Array of directory paths in the "workspace_name/path" format. Pass an array even for a single directory.';
    }
    
    
return {
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
        };
}
