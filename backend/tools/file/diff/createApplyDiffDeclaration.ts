import type { ToolDeclaration } from '../../types';
export interface ApplyDiffDeclarationOptions { language: 'zh-CN' | 'en'; workspaces?: readonly { name: string }[]; format: 'unified' | 'search_replace' }
/** 两个宿主共用原始参数与描述。 */
export function createApplyDiffDeclaration(options: ApplyDiffDeclarationOptions): ToolDeclaration {
        // 获取工作区信息
        const workspaces = options.workspaces ?? [];
        const isMultiRoot = workspaces.length > 1;
        // 模型声明语言：zh-CN → 中文，en/ja → 英文（ja 本阶段映射到英文说明）
        const isZh = options.language === 'zh-CN';

        // 根据工作区数量生成描述
        let pathDescription: string;
        let descriptionSuffix = '';
        if (isZh) {
            pathDescription = '文件路径，相对于当前工作区根目录。例如：src/example.ts。';
            if (isMultiRoot) {
                pathDescription = `文件路径，必须使用 "workspace_name/path" 格式。可用工作区：${workspaces.map(w => w.name).join(', ')}`;
                descriptionSuffix = `\n\n多根工作区：必须使用 "workspace_name/path" 格式。可用工作区：${workspaces.map(w => w.name).join(', ')}`;
            }
        } else {
            pathDescription = 'File path, relative to the current workspace root. For example: src/example.ts.';
            if (isMultiRoot) {
                pathDescription = `File path, must use the "workspace_name/path" format. Available workspaces: ${workspaces.map(w => w.name).join(', ')}`;
                descriptionSuffix = `\n\nMulti-root workspace: Must use the "workspace_name/path" format. Available workspaces: ${workspaces.map(w => w.name).join(', ')}`;
            }
        }

        const format = options.format;

        if (format === 'search_replace') {
            // 修改原因：旧版 search/replace 声明只强调“单次调用单文件”，容易让模型误以为每改一个文件后必须停止等待。
            // 修改方式：在工具 description 中加入批量修改规则，明确“一个工具调用单文件”和“一轮回复多个工具调用”并不冲突。
            // 修改目的：鼓励模型在多文件修改计划已经明确且互不依赖时，同一轮连续输出多个 apply_diff 调用，减少无意义的工具迭代。
            const description = isZh
                ? `对单个文件应用旧版 search/replace 差异，并打开待确认 diff 预览。

参数：
- path：目标文件路径。
- diffs：要应用的旧版差异数组。

每个 diff 对象包含：
- search：要查找的原始内容，必须和文件内容完全一致。
- replace：替换后的目标内容。
- start_line：可选，1-based 起始行号，用于重复内容定位。

规则：
- search 必须精确匹配，包括空格、缩进和换行。
- diffs 会按数组顺序应用。
- 某个 diff 失败时，该 diff 不会生效。

批量修改规则：
- 本工具一次调用仍然只修改一个文件；如果计划要修改多个互不依赖的文件，应该在同一轮回复中连续输出多个 apply_diff 调用。
- 不要在完成第一个文件的 apply_diff 后停止等待结果，除非后续修改依赖该工具结果或需要先确认上一处修改是否成功。
- 对已经明确、互不依赖的多文件修改，应一次性输出所有 apply_diff 调用，以减少无意义的工具迭代。
- 错误示例：修改 A 文件后停止，等下一轮再修改 B 文件。
- 正确示例：同一轮依次输出 apply_diff(A)、apply_diff(B)、apply_diff(C)。

${descriptionSuffix}`
                : `Apply a legacy search/replace diff to a single file and open a diff preview for confirmation.

Parameters:
- path: target file path.
- diffs: array of legacy diff objects to apply.

Each diff object contains:
- search: the original content to find; it must match the file content exactly.
- replace: the replacement content.
- start_line: optional, 1-based start line number, used to locate repeated content.

Rules:
- search must match exactly, including spaces, indentation, and newlines.
- diffs are applied in array order.
- If a diff fails, that diff is not applied.

Batch modification rules:
- This tool still modifies only one file per call; if you plan to modify multiple independent files, output multiple apply_diff calls in a row in the same reply.
- Do not stop and wait for results after the first apply_diff unless a later modification depends on its result or you need to confirm whether the previous modification succeeded.
- For clearly specified, independent multi-file modifications, emit all apply_diff calls at once to reduce pointless tool iterations.
- Wrong example: modifying file A then stopping and waiting for the next round to modify file B.
- Correct example: output apply_diff(A), apply_diff(B), apply_diff(C) in sequence in the same round.

${descriptionSuffix}`;

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
                                ? '旧版 diff 对象数组。即使只有一个 diff，也必须使用数组。'
                                : 'Array of legacy diff objects. Even a single diff must be passed as an array.',
                            items: {
                                type: 'object',
                                properties: {
                                    search: {
                                        type: 'string',
                                        description: isZh
                                            ? '要查找的原始内容，必须精确匹配。'
                                            : 'The original content to find; it must match exactly.'
                                    },
                                    replace: {
                                        type: 'string',
                                        description: isZh ? '替换后的目标内容。' : 'The replacement content.'
                                    },
                                    start_line: {
                                        type: 'number',
                                        description: isZh
                                            ? '可选，1-based 起始行号，用于重复内容定位。'
                                            : 'Optional, 1-based start line number, used to locate repeated content.'
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

        // 为什么要把默认声明改为结构化 hunks：旧 patch 字符串让模型混淆 JSON 转义和 unified diff 文本，双引号、反斜杠等内容容易写错。
        // 怎么改：主推 hunks[{oldContent,newContent,startLine?}]，同时保留 patch 字符串作为历史兼容字段。
        // 目的：让 newContent 像 write_file.content 一样表示最终内容，并保留一次调用处理多个连续片段的能力。
        // 修改原因：模型会把“apply_diff 一次调用只处理一个文件”误读成“一轮只能调用一次 apply_diff”。
        // 修改方式：在默认结构化 hunk 声明中补充批量修改规则，明确多文件计划应在同一轮连续输出多个 apply_diff 调用。
        // 修改目的：让工具说明本身承担行为引导，减少用户反复用自然语言纠正模型每次只改一个文件的问题。
        const description = isZh
            ? `对单个文件应用一个或多个结构化内容替换，并打开待确认 diff 预览。

推荐输入格式：
- path：目标文件路径。
- hunks：结构化修改数组。每个 hunk 表示一个连续片段替换。
- hunks[].oldContent：文件中要被替换的原始内容，必须和文件内容完全一致。
- hunks[].newContent：替换后的目标内容。按 JSON 字符串规则填写；工具收到后会作为最终文件内容使用，不要加 + 前缀，也不要为了 diff 再额外转义双引号。
- hunks[].startLine：可选，1-based，基于修改前原文件的行号。只有 oldContent 在当前文件中重复出现时才会用于定位；oldContent 唯一匹配时会忽略 startLine，避免陈旧行号导致失败。

规则：
- 一次调用只修改一个文件；多个不连续片段放在 hunks 数组中。
- hunks 应按原文件中的出现顺序排列，这样前面修改造成的行号偏移可以被工具正确维护。
- 不能让两个 hunk 修改同一段或互相覆盖的文本；如果要改同一个区块，应该合并成一个 hunk。
- oldContent 必须能匹配；如果 oldContent 重复出现，请提供 startLine 或增加上下文让它唯一。
- patch 字段仅作为兼容旧 unified diff hunk 字符串的 fallback；新调用优先使用 hunks。

批量修改规则：
- 本工具一次调用仍然只修改一个文件；如果计划要修改多个互不依赖的文件，应该在同一轮回复中连续输出多个 apply_diff 调用。
- 不要在完成第一个文件的 apply_diff 后停止等待结果，除非后续修改依赖该工具结果或需要先确认上一处修改是否成功。
- 对已经明确、互不依赖的多文件修改，应一次性输出所有 apply_diff 调用，以减少无意义的工具迭代。
- 错误示例：修改 A 文件后停止，等下一轮再修改 B 文件。
- 正确示例：同一轮依次输出 apply_diff(A)、apply_diff(B)、apply_diff(C)。

示例：
{
  "path": "src/example.ts",
  "hunks": [
    {
      "oldContent": "content: old;",
      "newContent": "content: \"\";",
      "startLine": 12
    }
  ]
}
${descriptionSuffix}`
            : `Apply one or more structured content replacements to a single file and open a diff preview for confirmation.

Recommended input format:
- path: target file path.
- hunks: array of structured modifications. Each hunk represents one contiguous replacement.
- hunks[].oldContent: the original content in the file to be replaced; it must match the file content exactly.
- hunks[].newContent: the replacement content. Fill it in per JSON string rules; the tool uses it as the final file content — do not add a + prefix, and do not escape double quotes for diff purposes.
- hunks[].startLine: optional, 1-based, line number in the original (pre-edit) file. It is only used to locate oldContent when oldContent appears multiple times in the file; when oldContent is unique, startLine is ignored to avoid failures from stale line numbers.

Rules:
- One call modifies only one file; put multiple non-contiguous replacements in the hunks array.
- hunks must be ordered by their appearance in the original file so line-number offsets from earlier replacements are maintained correctly.
- Two hunks must not modify the same section or overlapping text; if you need to change the same block, merge it into a single hunk.
- oldContent must match; if oldContent appears multiple times, provide startLine or more context to make it unique.
- The patch field remains only as a fallback for legacy unified diff hunk strings; prefer hunks for new calls.

Batch modification rules:
- This tool still modifies only one file per call; if you plan to modify multiple independent files, output multiple apply_diff calls in a row in the same reply.
- Do not stop and wait for results after the first apply_diff unless a later modification depends on its result or you need to confirm whether the previous modification succeeded.
- For clearly specified, independent multi-file modifications, emit all apply_diff calls at once to reduce pointless tool iterations.
- Wrong example: modifying file A then stopping and waiting for the next round to modify file B.
- Correct example: output apply_diff(A), apply_diff(B), apply_diff(C) in sequence in the same round.

Example:
{
  "path": "src/example.ts",
  "hunks": [
    {
      "oldContent": "content: old;",
      "newContent": "content: \"\";",
      "startLine": 12
    }
  ]
}
${descriptionSuffix}`;

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
                            ? '推荐格式。结构化 hunk 数组；每个 hunk 使用 oldContent/newContent 表示一次连续内容替换。'
                            : 'Recommended format. Array of structured hunks; each hunk uses oldContent/newContent to express one contiguous content replacement.',
                        items: {
                            type: 'object',
                            properties: {
                                oldContent: {
                                    type: 'string',
                                    description: isZh
                                        ? '文件中要被替换的原始内容，必须精确匹配。'
                                        : 'The original content in the file to be replaced; it must match exactly.'
                                },
                                newContent: {
                                    type: 'string',
                                    description: isZh
                                        ? '替换后的目标内容。按 JSON 字符串规则填写；工具收到后作为最终文件内容使用。'
                                        : 'The replacement content. Fill it in per JSON string rules; the tool uses it as the final file content.'
                                },
                                startLine: {
                                    type: 'number',
                                    description: isZh
                                        ? '可选，1-based，基于修改前原文件的行号。仅当 oldContent 重复出现时用于定位。'
                                        : 'Optional, 1-based, line number in the original (pre-edit) file. Used for locating only when oldContent appears multiple times.'
                                }
                            },
                            required: ['oldContent', 'newContent']
                        }
                    },
                    patch: {
                        type: 'string',
                        description: isZh
                            ? '兼容字段。旧 unified diff hunks 文本；新调用请优先使用 hunks。'
                            : 'Compatibility field. Legacy unified diff hunks text; prefer hunks for new calls.'
                    }
                },
                required: ['path']
            }
        };
    }
