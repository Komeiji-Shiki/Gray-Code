import type { ToolDeclaration } from '../types';
import { toolBatchingGuidance } from '../shared/batchingGuidance';
export interface DeclarationOptions { language: 'zh-CN' | 'en'; workspaces?: readonly { name: string }[]; precreateEmptyFile?: boolean }
/** 原工具声明共用同一工厂，宿主只提供语言与工作区信息。 */
export function createWriteFileDeclaration(options: DeclarationOptions): ToolDeclaration {

    // 获取工作区信息
    const workspaces = options.workspaces ?? [];
    const isMultiRoot = workspaces.length > 1;
    // 模型声明语言：zh-CN → 中文，en/ja → 英文（ja 本阶段映射到英文说明）
    const isZh = options.language === 'zh-CN';
    
    // 单文件 schema 容易被误读成“一轮只能调用一次”，同批规则统一由 toolBatchingGuidance 追加。
    let description = isZh
        ? `创建新文件，或用 content 整体覆盖一个已有文件。写入前会展示 Diff 预览，用户确认后才生效。${options.precreateEmptyFile === false
            ? '新文件只在内存中预览，用户接受后才创建文件和所需的父目录。'
            : '目标文件不存在时，为了展示预览，会在确认前先创建一个空文件；用户拒绝或取消后，这个文件以及本次新建且仍为空的父目录会被删除，清理失败时工具结果会说明。'}

content 必须是文件的完整目标内容。只改大文件的一部分时，请优先用 apply_diff，避免整文件重写时误删内容。`
        : `Create a new file, or overwrite an existing file entirely with content. A Diff preview is shown first, and the write takes effect only after the user confirms it. ${options.precreateEmptyFile === false
            ? 'New files are previewed in memory; the file and any needed parent directories are created only when the change is accepted.'
            : 'If the target does not exist, an empty file is created before confirmation so the preview can be shown; rejecting or cancelling removes that file and any still-empty parent directories created for it, and the tool result reports any cleanup failure.'}

content must be the complete target content of the file. To change only part of a large file, prefer apply_diff so a full rewrite does not drop content by accident.`;
    description += toolBatchingGuidance(options.language);
    let pathDescription = isZh
        ? '文件路径，相对于工作区根目录，例如 docs/example.md。'
        : 'File path relative to the workspace root, for example docs/example.md.';
    
    if (isMultiRoot) {
        pathDescription = isZh
            ? `文件路径。当前是多根工作区，请使用 "workspace_name/path" 格式。可用工作区：${workspaces.map(w => w.name).join(', ')}。`
            : `File path. This is a multi-root workspace, so use the "workspace_name/path" format. Available workspaces: ${workspaces.map(w => w.name).join(', ')}.`;
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
                            ? '要写入的完整文件内容。'
                            : 'The complete file content to write.'
                    }
                },
                required: ['path', 'content']
            }
        };
}
