import type { ToolDeclaration } from '../types';
export interface DeclarationOptions { language: 'zh-CN' | 'en'; workspaces?: readonly { name: string }[]; precreateEmptyFile?: boolean }
/** 原工具声明共用同一工厂，宿主只提供语言与工作区信息。 */
export function createWriteFileDeclaration(options: DeclarationOptions): ToolDeclaration {

    // 获取工作区信息
    const workspaces = options.workspaces ?? [];
    const isMultiRoot = workspaces.length > 1;
    // 模型声明语言：zh-CN → 中文，en/ja → 英文（ja 本阶段映射到英文说明）
    const isZh = options.language === 'zh-CN';
    
    // 根据工作区数量生成描述
    // 修改原因：write_file 和 apply_diff 一样是单文件 schema，模型容易把它误解为“一轮回复只能调用一次”。
    // 修改方式：在 description 中加入批量写入规则，明确多个独立新文件或重写文件应在同一轮连续输出多个 write_file 调用。
    // 修改目的：让工具声明直接引导模型批量完成已明确的多文件写入计划，避免每写一个文件就停下等待下一轮。
    let description = isZh
        ? `写入内容到一个文件。若文件不存在则创建；若文件已存在则用 content 覆盖其完整内容。执行前会展示 Diff 预览并等待用户确认。

${options.precreateEmptyFile === false ? '注意：新文件的 Diff 在内存中预览，接受修改后才创建文件和父目录。' : '注意：目标文件不存在时，为展示 Diff 预览会在确认前预创建空文件。拒绝或取消后会删除该文件，并删除本次新建且仍为空的父目录；若残留清理失败，工具结果会明确报告。'}

适用场景：
- 创建新文件
- 重写一个已有文件的完整内容

批量写入规则：
- 本工具一次调用仍然只写入一个文件；如果计划要创建或重写多个互不依赖的文件，应该在同一轮回复中连续输出多个 write_file 调用。
- 不要在完成第一个文件的 write_file 后停止等待结果，除非后续写入依赖该工具结果或需要先确认上一处写入是否成功。
- 对已经明确、互不依赖的多文件写入，应一次性输出所有 write_file 调用，以减少无意义的工具迭代。
- 错误示例：写入 A 文件后停止，等下一轮再写入 B 文件。
- 正确示例：同一轮依次输出 write_file(A)、write_file(B)、write_file(C)。

注意：path 是相对于工作区根目录的路径；content 必须是文件的完整目标内容。修改大文件时，优先考虑 apply_diff，避免整文件重写带来的误删风险。`
        : `Write content to a file. If the file does not exist, it will be created; if it already exists, its entire content will be overwritten with content. A Diff preview is shown and user confirmation is awaited before applying.

${options.precreateEmptyFile === false ? 'Note: new files are previewed in memory. Files and parent directories are created only when the change is accepted.' : 'Note: when the target does not exist, an empty file is pre-created before confirmation so the Diff preview can be rendered. Rejecting or cancelling removes that file and any still-empty parent directories created for it; cleanup failures are reported in the tool result.'}

Use cases:
- Creating a new file
- Rewriting the full content of an existing file

Batch write rules:
- This tool still writes only one file per call; if you plan to create or rewrite multiple independent files, output multiple write_file calls in a row in the same reply.
- Do not stop and wait for results after the first write_file unless a later write depends on its result or you need to confirm whether the previous write succeeded.
- For clearly specified, independent multi-file writes, emit all write_file calls at once to reduce pointless tool iterations.
- Wrong example: writing file A then stopping and waiting for the next round to write file B.
- Correct example: output write_file(A), write_file(B), write_file(C) in sequence in the same round.

Note: path is relative to the workspace root; content must be the complete target content of the file. When modifying large files, prefer apply_diff to avoid the risk of accidental deletion from full-file rewrites.`;
    let pathDescription = isZh
        ? '文件路径，相对于当前工作区根目录。例如：docs/example.md。'
        : 'File path, relative to the current workspace root. For example: docs/example.md.';
    
    if (isMultiRoot) {
        description += isZh
            ? `\n\n多根工作区：path 必须使用 "workspace_name/path" 格式。可用工作区：${workspaces.map(w => w.name).join(', ')}。`
            : `\n\nMulti-root workspace: path must use the "workspace_name/path" format. Available workspaces: ${workspaces.map(w => w.name).join(', ')}.`;
        pathDescription = isZh
            ? `文件路径。当前是多根工作区，必须使用 "workspace_name/path" 格式。可用工作区：${workspaces.map(w => w.name).join(', ')}。`
            : `File path. This is a multi-root workspace, so it must use the "workspace_name/path" format. Available workspaces: ${workspaces.map(w => w.name).join(', ')}.`;
    }
    
    
return {
            name: 'write_file',
            strict: true,  // API 端强制 schema 校验
            description,
            category: 'file',
            parameters: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: pathDescription
                    },
                    content: {
                        type: 'string',
                        description: isZh
                            ? '要写入文件的完整内容。已有文件会被该内容整体覆盖。'
                            : 'The complete content to write to the file. An existing file is entirely overwritten by this content.'
                    }
                },
                required: ['path', 'content']
            }
        };
}
