import type { ToolDeclaration } from '../types';
export interface DeclarationOptions { language: 'zh-CN' | 'en'; workspaces?: readonly { name: string }[]; precreateEmptyFile?: boolean }
/** 原工具声明共用同一工厂，宿主只提供语言与工作区信息。 */
export function createDeleteCodeDeclaration(options: DeclarationOptions): ToolDeclaration {

    const workspaces = options.workspaces ?? [];
    const isMultiRoot = workspaces.length > 1;
    // 模型声明语言：zh-CN → 中文，en/ja → 英文（ja 本阶段映射到英文说明）
    const isZh = options.language === 'zh-CN';

    let description = isZh
        ? '从一个或多个文件中删除指定的行范围，起止行都会被删除。执行前会展示 Diff 预览，用户确认后才生效。调用示例：{"files": [{"path": "file.ts", "start_line": 10, "end_line": 20}]}。'
        : 'Delete a range of lines from one or more files; both the start and end lines are removed. A Diff preview is shown first, and the change takes effect only after the user confirms it. Example call: {"files": [{"path": "file.ts", "start_line": 10, "end_line": 20}]}.';
    let pathDescription = isZh
        ? '文件路径，相对于工作区根目录。'
        : 'File path relative to the workspace root.';

    if (isMultiRoot) {
        description += isZh
            ? `\n\n当前是多根工作区，path 请使用 "workspace_name/path" 格式。可用工作区：${workspaces.map(w => w.name).join(', ')}。`
            : `\n\nThis is a multi-root workspace, so path must use the "workspace_name/path" format. Available workspaces: ${workspaces.map(w => w.name).join(', ')}.`;
        pathDescription = isZh
            ? '文件路径，格式为 "workspace_name/path"。'
            : 'File path in the "workspace_name/path" format.';
    }

    
return {
            name: 'delete_code',
            description,
            category: 'file',
            parameters: {
                type: 'object',
                properties: {
                    files: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                path: {
                                    type: 'string',
                                    description: pathDescription
                                },
                                start_line: {
                                    type: 'integer',
                                    minimum: 1,
                                    description: isZh ? '起始行号，从 1 开始，包含这一行。' : 'First line to delete, 1-based and inclusive.'
                                },
                                end_line: {
                                    type: 'integer',
                                    minimum: 1,
                                    description: isZh ? '结束行号，从 1 开始，包含这一行。' : 'Last line to delete, 1-based and inclusive.'
                                }
                            },
                            required: ['path', 'start_line', 'end_line']
                        },
                        description: isZh
                            ? '删除操作数组，每一项指定一个文件和要删除的行范围。即使只有一个文件也要传数组。'
                            : 'Array of delete operations, each naming a file and the line range to delete. Pass an array even for a single file.'
                    }
                },
                required: ['files']
            }
        };
}
