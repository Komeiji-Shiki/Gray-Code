import type { ToolDeclaration } from '../types';
export interface DeclarationOptions { language: 'zh-CN' | 'en'; workspaces?: readonly { name: string }[]; precreateEmptyFile?: boolean }
/** 原工具声明共用同一工厂，宿主只提供语言与工作区信息。 */
export function createDeleteCodeDeclaration(options: DeclarationOptions): ToolDeclaration {

    const workspaces = options.workspaces ?? [];
    const isMultiRoot = workspaces.length > 1;
    // 模型声明语言：zh-CN → 中文，en/ja → 英文（ja 本阶段映射到英文说明）
    const isZh = options.language === 'zh-CN';

    // 修复历史拼写问题：parameterMUST → parameter MUST（中英文同时修复）
    const arrayFormatNote = isZh
        ? '\n\n**重要**：`files` 参数必须是数组，即使只删除一个文件。示例：`{"files": [{"path": "file.ts", "start_line": 10, "end_line": 20}]}`。'
        : '\n\n**IMPORTANT**: The `files` parameter MUST be an array, even for a single file. Example: `{"files": [{"path": "file.ts", "start_line": 10, "end_line": 20}]}`.';

    let description = isZh
        ? '从一个或多个文件中删除指定行范围（两端都包含）的代码。执行前会展示 Diff 预览并等待用户确认。' + arrayFormatNote
        : 'Delete a range of lines (inclusive on both ends) from one or more files. A Diff preview will be shown for user confirmation.' + arrayFormatNote;
    let pathDescription = isZh
        ? '文件路径（相对于工作区根目录）'
        : 'File path (relative to workspace root)';

    if (isMultiRoot) {
        description += isZh
            ? `\n\n多根工作区：必须使用 "workspace_name/path" 格式。可用工作区：${workspaces.map(w => w.name).join(', ')}`
            : `\n\nMulti-root workspace: Must use "workspace_name/path" format. Available workspaces: ${workspaces.map(w => w.name).join(', ')}`;
        pathDescription = isZh
            ? '文件路径，必须使用 "workspace_name/path" 格式'
            : 'File path, must use "workspace_name/path" format';
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
                                    description: isZh ? '起始行号（1-based，包含）' : 'Start line number (1-based, inclusive)'
                                },
                                end_line: {
                                    type: 'integer',
                                    minimum: 1,
                                    description: isZh ? '结束行号（1-based，包含）' : 'End line number (1-based, inclusive)'
                                }
                            },
                            required: ['path', 'start_line', 'end_line']
                        },
                        description: isZh
                            ? '删除操作数组。每个元素指定一个文件和要删除的行范围。即使只删除一个文件也必须传数组。'
                            : 'Array of delete operations. Each element specifies a file and line range to delete. MUST be an array even for a single file.'
                    }
                },
                required: ['files']
            }
        };
}
