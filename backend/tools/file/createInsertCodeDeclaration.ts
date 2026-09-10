import type { ToolDeclaration } from '../types';
export interface DeclarationOptions { language: 'zh-CN' | 'en'; workspaces?: readonly { name: string }[]; precreateEmptyFile?: boolean }
/** 原工具声明共用同一工厂，宿主只提供语言与工作区信息。 */
export function createInsertCodeDeclaration(options: DeclarationOptions): ToolDeclaration {

    const workspaces = options.workspaces ?? [];
    const isMultiRoot = workspaces.length > 1;
    // 模型声明语言：zh-CN → 中文，en/ja → 英文（ja 本阶段映射到英文说明）
    const isZh = options.language === 'zh-CN';

    const arrayFormatNote = isZh
        ? '\n\n**重要**：`files` 参数必须是数组，即使只插入一个文件。示例：`{"files": [{"path": "file.ts", "line": 5, "content": "..."}]}`。'
        : '\n\n**IMPORTANT**: The `files` parameter MUST be an array, even for a single file. Example: `{"files": [{"path": "file.ts", "line": 5, "content": "..."}]}`.';

    let description = isZh
        ? '在一个或多个文件的指定行前插入代码。使用 `line = last_line + 1` 在文件末尾追加。执行前会展示 Diff 预览并等待用户确认。' + arrayFormatNote
        : 'Insert code before a specified line in one or more files. Use `line = last_line + 1` to append at the end. A Diff preview will be shown for user confirmation.' + arrayFormatNote;
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
            name: 'insert_code',
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
                                line: {
                                    type: 'integer',
                                    minimum: 1,
                                    description: isZh
                                        ? '要插入到的行号（1-based）。使用 last_line + 1 在文件末尾追加。'
                                        : 'Line number (1-based) to insert before. Use last_line + 1 to append at end of file.'
                                },
                                content: {
                                    type: 'string',
                                    description: isZh ? '要插入的代码内容' : 'The code content to insert'
                                }
                            },
                            required: ['path', 'line', 'content']
                        },
                        description: isZh
                            ? '插入操作数组。每个元素指定一个文件、行号和要插入的内容。即使只插入一个文件也必须传数组。'
                            : 'Array of insert operations. Each element specifies a file, line number, and content to insert. MUST be an array even for a single file.'
                    }
                },
                required: ['files']
            }
        };
}
