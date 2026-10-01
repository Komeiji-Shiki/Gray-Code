import type { ToolDeclaration } from '../types';
export interface DeclarationOptions { language: 'zh-CN' | 'en'; workspaces?: readonly { name: string }[]; precreateEmptyFile?: boolean }
/** 原工具声明共用同一工厂，宿主只提供语言与工作区信息。 */
export function createInsertCodeDeclaration(options: DeclarationOptions): ToolDeclaration {

    const workspaces = options.workspaces ?? [];
    const isMultiRoot = workspaces.length > 1;
    // 模型声明语言：zh-CN → 中文，en/ja → 英文（ja 本阶段映射到英文说明）
    const isZh = options.language === 'zh-CN';

    let description = isZh
        ? '在一个或多个文件的指定行之前插入代码。执行前会展示 Diff 预览，用户确认后才生效。调用示例：{"files": [{"path": "file.ts", "line": 5, "content": "..."}]}。'
        : 'Insert code before a given line in one or more files. A Diff preview is shown first, and the change takes effect only after the user confirms it. Example call: {"files": [{"path": "file.ts", "line": 5, "content": "..."}]}.';
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
                                        ? '在这一行之前插入，行号从 1 开始。传文件总行数 + 1 可追加到文件末尾。'
                                        : 'Insert before this line (1-based). Pass the last line number + 1 to append at the end of the file.'
                                },
                                content: {
                                    type: 'string',
                                    description: isZh ? '要插入的代码。' : 'The code to insert.'
                                }
                            },
                            required: ['path', 'line', 'content']
                        },
                        description: isZh
                            ? '插入操作数组，每一项指定一个文件、行号和要插入的内容。即使只有一个文件也要传数组。'
                            : 'Array of insert operations, each naming a file, a line number and the content to insert. Pass an array even for a single file.'
                    }
                },
                required: ['files']
            }
        };
}
