import type { ToolDeclaration } from '../../types';
import { toolBatchingGuidance } from '../../shared/batchingGuidance';
export interface ApplyDiffDeclarationOptions { language: 'zh-CN' | 'en'; workspaces?: readonly { name: string }[]; format: 'unified' | 'search_replace' }
/** 两个宿主共用原始参数与描述。 */
export function createApplyDiffDeclaration(options: ApplyDiffDeclarationOptions): ToolDeclaration {
        // 获取工作区信息
        const workspaces = options.workspaces ?? [];
        const isMultiRoot = workspaces.length > 1;
        // 模型声明语言：zh-CN → 中文，en/ja → 英文（ja 本阶段映射到英文说明）
        const isZh = options.language === 'zh-CN';

        // 多根工作区的格式和可用名称只写在 path 参数里，主说明不重复。
        let pathDescription: string;
        if (isZh) {
            pathDescription = isMultiRoot
                ? `文件路径。当前是多根工作区，请使用 "workspace_name/path" 格式。可用工作区：${workspaces.map(w => w.name).join(', ')}。`
                : '文件路径，相对于工作区根目录，例如 src/example.ts。';
        } else {
            pathDescription = isMultiRoot
                ? `File path. This is a multi-root workspace, so use the "workspace_name/path" format. Available workspaces: ${workspaces.map(w => w.name).join(', ')}.`
                : 'File path relative to the workspace root, for example src/example.ts.';
        }

        // 单文件 schema 容易被误读成“一轮只能调用一次”，同批规则统一由 toolBatchingGuidance 追加。
        const batchingSuffix = toolBatchingGuidance(options.language);
        const format = options.format;

        if (format === 'search_replace') {
            const description = isZh
                ? `用旧版 search/replace 方式修改一个文件，并打开待确认的 diff 预览。

每个 diff 用 search 指定要找的原文，用 replace 指定替换后的内容。search 必须与文件内容完全一致，包括空格、缩进和换行；同一段内容在文件中出现多次时，用 start_line 指明位置。diffs 按数组顺序依次应用，某一项匹配失败时只有这一项不生效。${batchingSuffix}`
                : `Edit one file with legacy search/replace diffs and open a diff preview for confirmation.

Each diff names the original text in search and the new text in replace. search must match the file exactly, including spaces, indentation and newlines; when the same text appears more than once, use start_line to say which occurrence you mean. diffs are applied in array order, and if one fails to match, only that diff is skipped.${batchingSuffix}`;

            return {
                name: 'apply_diff',
                category: 'file',
                strict: true,  // API 端强制 schema 校验
                description,

                parameters: {
                    type: 'object',
                    properties: {
                        path: {
                            type: 'string',
                            description: pathDescription
                        },
                        diffs: {
                            type: 'array',
                            description: isZh
                                ? '旧版 diff 对象数组。即使只有一个 diff 也要传数组。'
                                : 'Array of legacy diff objects. Pass an array even for a single diff.',
                            items: {
                                type: 'object',
                                properties: {
                                    search: {
                                        type: 'string',
                                        description: isZh
                                            ? '要查找的原文。'
                                            : 'The original text to find.'
                                    },
                                    replace: {
                                        type: 'string',
                                        description: isZh ? '替换后的内容。' : 'The replacement text.'
                                    },
                                    start_line: {
                                        type: 'number',
                                        description: isZh
                                            ? '可选，search 所在的起始行号，从 1 开始。'
                                            : 'Optional 1-based line where search starts.'
                                    }
                                },
                                required: ['search', 'replace']
                            }
                        }
                    },
                    required: ['path', 'diffs']
                }
            };
        }

        // 默认声明主推结构化 hunks：newContent 像 write_file.content 一样表示最终内容，避免 patch 字符串的转义错误。
        const description = isZh
            ? `对一个文件应用 hunks，并打开待确认的 Diff。

每项替换连续原文：oldContent 必须完全匹配空格、缩进和换行；newContent 填最终内容，使用普通 JSON 字符串，不加 + 前缀或额外 diff 转义。hunks 按原文件顺序排列、不得重叠，同一块修改合并为一项；行号偏移由工具处理。原文重复时用 startLine 或增加上下文定位；原文唯一时忽略 startLine。新调用用 hunks；patch 仅兼容旧 unified diff。

示例：{"path": "src/example.ts","hunks": [{"oldContent": "content: old;","newContent": "content: \\"\\";","startLine": 12}]}${batchingSuffix}`
            : `Apply hunks to one file and open a diff preview for confirmation.

Each hunk replaces a contiguous block: oldContent must exactly match spaces, indentation and newlines; newContent is the final text as an ordinary JSON string, with no + prefix or extra diff escaping. Order hunks by their position in the original file without overlap; merge edits to the same block. Line shifts are handled automatically. For repeated oldContent, specify startLine or add context to make it unique; unique oldContent ignores startLine. Use hunks for new calls; patch only supports legacy unified diff.

Example: {"path": "src/example.ts","hunks": [{"oldContent": "content: old;","newContent": "content: \\"\\";","startLine": 12}]}${batchingSuffix}`;

        return {
            name: 'apply_diff',
            category: 'file',
            strict: true,  // API 端强制 schema 校验
            description,

            parameters: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: pathDescription
                    },
                    hunks: {
                        type: 'array',
                        description: isZh
                            ? '推荐使用的修改数组，每个 hunk 表示一段连续内容的替换。'
                            : 'Recommended array of edits; each hunk replaces one contiguous block.',
                        items: {
                            type: 'object',
                            properties: {
                                oldContent: {
                                    type: 'string',
                                    description: isZh
                                        ? '文件中要被替换的原文。'
                                        : 'The existing text to replace.'
                                },
                                newContent: {
                                    type: 'string',
                                    description: isZh
                                        ? '替换后的最终内容。'
                                        : 'The final replacement text.'
                                },
                                startLine: {
                                    type: 'number',
                                    description: isZh
                                        ? '可选，oldContent 在修改前原文件中的起始行号，从 1 开始。'
                                        : 'Optional 1-based line where oldContent starts in the original file.'
                                }
                            },
                            required: ['oldContent', 'newContent']
                        }
                    },
                    patch: {
                        type: 'string',
                        description: isZh
                            ? '兼容字段，旧版 unified diff 的 hunk 文本。'
                            : 'Compatibility field holding legacy unified diff hunk text.'
                    }
                },
                required: ['path']
            }
        };
    }
