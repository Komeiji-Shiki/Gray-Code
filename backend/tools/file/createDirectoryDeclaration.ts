import type { ToolDeclaration } from '../types';
export interface DeclarationOptions { language: 'zh-CN' | 'en'; workspaces?: readonly { name: string }[]; precreateEmptyFile?: boolean }
/** 原工具声明共用同一工厂，宿主只提供语言与工作区信息。 */
export function createDirectoryDeclaration(options: DeclarationOptions): ToolDeclaration {

    // 获取工作区信息
    const workspaces = options.workspaces ?? [];
    const isMultiRoot = workspaces.length > 1;
    // 模型声明语言：zh-CN → 中文，en/ja → 英文（ja 本阶段映射到英文说明）
    const isZh = options.language === 'zh-CN';
    
    // 根据工作区数量生成描述
    // 数组格式强调说明
    const arrayFormatNote = isZh
        ? '\n\n**重要**：`paths` 参数必须是数组，即使只创建一个目录。示例：`{"paths": ["new-dir"]}`，不要写成 `{"path": "new-dir"}`。'
        : '\n\n**IMPORTANT**: The `paths` parameter MUST be an array, even for a single directory. Example: `{"paths": ["new-dir"]}`, NOT `{"path": "new-dir"}`.';
    
    let description = isZh
        ? '在工作区中创建一个或多个目录（父目录会自动创建）。' + arrayFormatNote
        : 'Create one or more directories in the workspace (parent directories will be created automatically)' + arrayFormatNote;
    let pathsDescription = isZh
        ? '目录路径数组（相对于工作区根目录）。即使只创建一个目录也必须传数组，例如：["new-dir"]'
        : 'Array of directory paths (relative to workspace root). MUST be an array even for single directory, e.g., ["new-dir"]';

    if (isMultiRoot) {
        description += isZh
            ? `\n\n多根工作区：必须使用 "workspace_name/path" 格式。可用工作区：${workspaces.map(w => w.name).join(', ')}`
            : `\n\nMulti-root workspace: Must use "workspace_name/path" format. Available workspaces: ${workspaces.map(w => w.name).join(', ')}`;
        pathsDescription = isZh
            ? '目录路径数组，必须使用 "workspace_name/path" 格式。即使只创建一个目录也必须传数组。'
            : 'Array of directory paths, must use "workspace_name/path" format. MUST be an array even for single directory.';
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
