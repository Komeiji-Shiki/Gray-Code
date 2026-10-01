/**
 * GrayCode - 中文工具说明：TODO / Design / Plan / Progress / Review 工作流文档
 *
 * 覆盖工具：
 * - todo_write / todo_update
 * - create_design / update_design
 * - create_plan / update_plan
 * - create_progress / update_progress / record_progress_milestone / validate_progress_document
 * - create_review / record_review_milestone / finalize_review / validate_review_document /
 *   reopen_review / compare_review_documents
 *
 * 高价值语义：
 * - todo_update 明确各操作所需字段：
 *   add → id、content（status 默认 pending）；set_status → id、status；set_content → id、content；
 *   cancel → id；remove → id；
 * - update_plan 保留 revision 与 progress_sync 的边界：progress_sync 禁传字段只在主说明写一次，
 *   updateMode / sourceArtifact 参数各用一句话提及；
 * - review 系列保留「一次审查对应一份文档、同一会话只有一个进行中的审查、finalize 后需 reopen」。
 */

import type { ToolDescriptionLocalization } from '../../types';

export const workflow: Record<string, ToolDescriptionLocalization> = {
    todo_write: {
        description:
            '创建或整体替换当前会话的 TODO 列表。用于第一次建立列表，或需要整体重写列表时；传入的 todos 会替换原有列表。' +
            '只想修改个别条目的状态或内容时，请使用 todo_update。结果只返回条目数量统计，不返回完整列表。',
        parameters: {
            todos: '完整的 TODO 条目数组。',
            'todos[].id': '条目的唯一 ID。',
            'todos[].content': '条目内容。',
            'todos[].status': '条目状态：pending、in_progress、completed 或 cancelled。'
        }
    },

    todo_update: {
        description:
            '修改当前会话 TODO 列表中的个别条目，不需要重写整个列表。操作按顺序执行。' +
            'add 需要 id 和 content，status 默认为 pending；set_status 需要 id 和 status；set_content 需要 id 和 content；cancel 和 remove 只需要 id。' +
            '结果只返回统计数字、无效操作数和未找到的 id，不返回完整列表。',
        parameters: {
            ops: '要依次应用到当前 TODO 列表的操作数组。',
            'ops[].op': '操作类型。add 新建条目，id 已存在时覆盖该条目；cancel 把状态设为 cancelled；remove 删除条目。',
            'ops[].id': '目标条目的 ID。',
            'ops[].content': '条目内容，供 add 和 set_content 使用。',
            'ops[].status': '条目状态，供 add 和 set_status 使用：pending、in_progress、completed 或 cancelled。'
        }
    },

    create_design: {
        description:
            '在 .graycode/design/**.md 下创建一份新的 Markdown 设计文档。本工具只写设计，不创建计划，也不修改代码。' +
            '目标文件已存在时调用会失败；修改已有设计请使用 update_design。',
        parameters: {
            title: '可选的设计标题，也用于生成默认文件名。',
            overview: '可选的一行概述。',
            design: '设计内容，使用 Markdown。',
            path: '可选的输出路径，必须位于 .graycode/design/**.md 下（多根工作区为 workspace/.graycode/design/**.md）。不传时根据标题生成。'
        }
    },

    update_design: {
        description:
            '修改 .graycode/design/**.md 下已有的 Markdown 设计文档。用户想改动当前设计、而不是另起一份时使用。' +
            '传入的内容会替换整份文档，目标文件必须已经存在。',
        parameters: {
            path: '已有设计文档的路径，位于 .graycode/design/**.md 下（多根工作区为 workspace/.graycode/design/**.md）。',
            title: '可选的新标题。',
            overview: '可选的新的一行概述。',
            design: '修改后的完整设计内容，使用 Markdown。',
            changeSummary: '可选的本次修改摘要。'
        }
    },

    create_plan: {
        description:
            '在 .graycode/plans/**.md 下创建一份带 TODO 清单的新 Markdown 计划文档。本工具只写计划，不负责执行。' +
            '目标文件已存在时调用会失败；修改已有计划请使用 update_plan。' +
            '如果计划基于一份已确认的设计或审查文档，请通过 sourceArtifact 传入，之后就能检查计划是否仍与来源文档一致。',
        parameters: {
            title: '可选的计划标题，也用于生成默认文件名。',
            overview: '可选的一行概述。',
            plan: '计划内容，使用 Markdown。',
            todos: '计划的 TODO 清单，必填；每项包含 id、content 和 status。',
            'todos[].id': '条目 ID。',
            'todos[].content': '条目内容。',
            'todos[].status': '条目状态：pending、in_progress、completed 或 cancelled。',
            sourceArtifact: '可选，计划所依据的已确认设计或审查文档。',
            'sourceArtifact.type': '来源文档类型：design 或 review。',
            'sourceArtifact.path': '来源文档路径。',
            path: '可选的输出路径，必须位于 .graycode/plans/**.md 下（多根工作区为 workspace/.graycode/plans/**.md）。不传时根据标题生成。'
        }
    },

    update_plan: {
        description:
            '修改 .graycode/plans/**.md 下已有的 Markdown 计划文档。revision 模式（默认）重写计划，之后需要用户重新确认。' +
            'progress_sync 只在实施期间更新 TODO 状态，不改动计划正文，只传 path、todos、updateMode 和可选的 changeSummary。' +
            'sourceArtifact 和其他续接字段（如 sourcePath、planContent、continuationIntent）只在 revision 模式下有意义，progress_sync 中不要传；' +
            '在 progress_sync 中传入的 sourceArtifact 会被忽略并给出警告，传入本 schema 以外的字段会导致调用失败。',
        parameters: {
            path: '已有计划文档的路径，位于 .graycode/plans/**.md 下。请沿用已批准计划的路径。',
            title: '可选的新标题。',
            overview: '可选的新的一行概述。',
            plan: '修改后的完整计划内容，使用 Markdown。revision 模式下必填，progress_sync 模式下不使用。',
            todos: '完整的 TODO 清单，会替换原有清单；每项包含 id、content 和 status。',
            'todos[].id': '条目 ID。',
            'todos[].content': '条目内容。',
            'todos[].status': '条目状态：pending、in_progress、completed 或 cancelled。',
            updateMode: 'revision（默认）重写计划并需要重新确认；progress_sync 只更新 TODO 状态，只接受 path、todos、updateMode 和 changeSummary。',
            sourceArtifact: '可选，要关联的已确认设计或审查文档；不传时保留原有关联。只在 revision 模式下使用，在 progress_sync 中会被忽略并给出警告。',
            'sourceArtifact.type': '来源文档类型：design 或 review。',
            'sourceArtifact.path': '来源文档路径。',
            changeSummary: '可选的本次修改摘要。'
        }
    },

    create_progress: {
        description:
            '在 .graycode/progress.md 创建项目进度文档，用来跟踪项目状态、阶段、关联文档、TODO、里程碑、风险和变更日志。' +
            '结果是一份简短的进度快照，而不是完整的 Markdown。' +
            '如果已经存在有效的进度文档，会返回它的快照并附带警告，不会再建第二份；已有文件无效时调用会失败。status 默认为 active，phase 默认为 design。',
        parameters: {
            path: '可选的输出路径，必须是 .graycode/progress.md（多根工作区为 workspace/.graycode/progress.md）。',
            projectName: '可选的项目名称，默认取第一个工作区文件夹的名称。',
            projectId: '可选的稳定项目 ID，默认由项目名称生成 slug。',
            status: '项目状态：active、blocked、completed 或 archived。',
            phase: '项目阶段：design、plan、implementation、review 或 maintenance。',
            currentFocus: '当前的工作重点。',
            latestConclusion: '最新结论。',
            currentBlocker: '当前的阻塞问题。',
            nextAction: '下一步行动。',
            activeArtifacts: '当前关联的设计、计划和审查文档路径。',
            'activeArtifacts.design': '设计文档路径。',
            'activeArtifacts.plan': '计划文档路径。',
            'activeArtifacts.review': '审查文档路径。',
            todos: 'TODO 快照；每项包含 id、content 和 status。',
            'todos[].id': '条目 ID。',
            'todos[].content': '条目内容。',
            'todos[].status': '条目状态：pending、in_progress、completed 或 cancelled。',
            risks: '风险清单；每项包含 id、title、status 和 description。',
            'risks[].id': '风险 ID。',
            'risks[].title': '风险标题。',
            'risks[].status': '风险状态：active、resolved 或 accepted。',
            'risks[].description': '风险说明。'
        }
    },

    update_progress: {
        description:
            '修改 .graycode/progress.md 中已有的项目进度文档。只会改动传入的字段：activeArtifacts 只更新传入的键，todos 和 risks 整体替换原有列表，appendLog 把条目追加到日志末尾。' +
            '结果是一份简短的进度快照，并列出改动过的部分。',
        parameters: {
            path: '可选的目标路径，必须是 .graycode/progress.md（多根工作区为 workspace/.graycode/progress.md）。',
            status: '项目状态：active、blocked、completed 或 archived。',
            phase: '项目阶段：design、plan、implementation、review 或 maintenance。',
            currentFocus: '当前的工作重点。',
            latestConclusion: '最新结论。',
            currentBlocker: '当前的阻塞问题。',
            nextAction: '下一步行动。',
            activeArtifacts: '当前关联的设计、计划和审查文档路径。',
            'activeArtifacts.design': '设计文档路径。',
            'activeArtifacts.plan': '计划文档路径。',
            'activeArtifacts.review': '审查文档路径。',
            todos: '新的 TODO 快照；每项包含 id、content 和 status。',
            'todos[].id': '条目 ID。',
            'todos[].content': '条目内容。',
            'todos[].status': '条目状态：pending、in_progress、completed 或 cancelled。',
            risks: '新的风险清单；每项包含 id、title、status 和 description。',
            'risks[].id': '风险 ID。',
            'risks[].title': '风险标题。',
            'risks[].status': '风险状态：active、resolved 或 accepted。',
            'risks[].description': '风险说明。',
            appendLog: '要追加的日志条目；每项包含 type 和 message，可以带 refId。',
            'appendLog[].type': '日志类型：created、updated、milestone_recorded、artifact_changed 或 risk_changed。',
            'appendLog[].refId': '可选的关联 ID，例如里程碑 ID。',
            'appendLog[].message': '日志内容。'
        }
    },

    record_progress_milestone: {
        description:
            '在 .graycode/progress.md 中记录一个项目级里程碑，并返回刷新后的进度快照。它用于记录项目进展节点，审查发现和计划内容不要写在这里。' +
            '不传 milestoneId 时自动生成下一个 ID（PG1、PG2……），传入已存在的 ID 会导致调用失败。' +
            'status 默认为 completed，此时 completedAt 默认取当前时间。latestConclusion、currentBlocker 和 nextAction 也会同步更新文档摘要。',
        parameters: {
            path: '可选的目标路径，必须是 .graycode/progress.md（多根工作区为 workspace/.graycode/progress.md）。',
            milestoneId: '可选的里程碑 ID。',
            title: '里程碑标题。',
            status: '里程碑状态：in_progress 或 completed。',
            summary: '里程碑摘要。',
            relatedTodoIds: '相关 TODO 的 ID 数组。',
            relatedReviewMilestoneIds: '相关审查里程碑的 ID 数组。',
            relatedArtifacts: '相关的设计、计划和审查文档路径。',
            'relatedArtifacts.design': '设计文档路径。',
            'relatedArtifacts.plan': '计划文档路径。',
            'relatedArtifacts.review': '审查文档路径。',
            startedAt: '开始时间，使用 ISO 时间字符串。',
            completedAt: '完成时间，使用 ISO 时间字符串。',
            nextAction: '下一步行动。',
            latestConclusion: '最新结论。',
            currentBlocker: '当前的阻塞问题。'
        }
    },

    validate_progress_document: {
        description:
            '检查 .graycode/progress.md 中的进度文档，不修改文件。结果会列出元数据、章节顺序和基本一致性规则方面的问题。',
        parameters: {
            path: '进度文档路径，必须是 .graycode/progress.md（多根工作区为 workspace/.graycode/progress.md）。'
        }
    },

    create_review: {
        description:
            '在 .graycode/review/**.md 下创建一份 Markdown 审查文档，并以它开始一次审查。本工具属于 Review 模式，只写审查文档，不修改项目代码。' +
            '一次审查只对应一份文档，同一会话中同时只能有一个进行中的审查；要开始新的审查，请先结束当前审查。' +
            '目标文件已存在时调用会失败；请用 record_review_milestone 或 finalize_review 继续那次审查，或者换一个路径。',
        parameters: {
            title: '可选的审查标题，也用于生成默认文件名。',
            overview: '可选的一行审查概述。',
            review: '初始审查内容，使用 Markdown，例如审查范围和方法。',
            path: '可选的输出路径，必须位于 .graycode/review/**.md 下（多根工作区为 workspace/.graycode/review/**.md）。不传时根据标题生成。'
        }
    },

    record_review_milestone: {
        description:
            '为进行中的审查追加一个里程碑，并更新它在 .graycode/review/**.md 下的文档的摘要、问题和统计。' +
            'path 必须是当前会话中进行中的那次审查的文档。调用 finalize_review 之后不能再记录里程碑，除非先用 reopen_review 重新打开。',
        parameters: {
            path: '审查文档路径，位于 .graycode/review/**.md 下。',
            milestoneId: '可选的里程碑 ID，不传时自动生成。',
            milestoneTitle: '里程碑标题。',
            summary: '里程碑摘要，使用 Markdown。',
            status: '里程碑状态：in_progress 或 completed。',
            conclusion: '可选，要显示在审查摘要中的最新结论。',
            evidenceFiles: '可选的证据文件路径数组。无法指出具体行号时使用。',
            evidence: '可选的证据引用数组，每项包含文件路径，以及可选的行号、符号或片段哈希。',
            'evidence[].path': '证据文件路径。',
            'evidence[].lineStart': '可选的起始行号，从 1 开始。',
            'evidence[].lineEnd': '可选的结束行号，从 1 开始。',
            'evidence[].symbol': '可选的符号名。',
            'evidence[].excerptHash': '可选的证据片段哈希。',
            findings: '可选的纯文本问题数组，会合并到问题区。优先使用 structuredFindings。',
            structuredFindings: '可选的结构化问题数组，会合并到问题区。标题保持简短，详细说明写在 description 中。',
            'structuredFindings[].id': '可选的简短、稳定的问题 ID。没有现成的 ID 时省略。',
            'structuredFindings[].severity': '严重程度：high、medium 或 low。',
            'structuredFindings[].category': '问题类别：html、css、javascript、accessibility、performance、maintainability、docs、test 或 other。',
            'structuredFindings[].title': '简短的问题标签，不要写成完整句子、文件路径或建议。',
            'structuredFindings[].description': '问题的详细说明，包括推理过程、影响和背景。',
            'structuredFindings[].evidenceFiles': '可选，作为该问题证据的文件路径数组。',
            'structuredFindings[].evidence': '可选，该问题的证据引用数组。',
            'structuredFindings[].evidence[].path': '证据文件路径。',
            'structuredFindings[].evidence[].lineStart': '可选的起始行号，从 1 开始。',
            'structuredFindings[].evidence[].lineEnd': '可选的结束行号，从 1 开始。',
            'structuredFindings[].evidence[].symbol': '可选的符号名。',
            'structuredFindings[].evidence[].excerptHash': '可选的证据片段哈希。',
            'structuredFindings[].relatedMilestoneIds': '可选，相关里程碑的 ID 数组。',
            'structuredFindings[].recommendation': '可选的修复或处理建议。',
            'structuredFindings[].trackingStatus': '跟踪状态：open、accepted_risk、fixed、wont_fix 或 duplicate。',
            reviewedModules: '可选，本次审查覆盖的模块数组，会合并到审查摘要。',
            recommendedNextAction: '可选，要显示在审查摘要中的建议下一步。'
        }
    },

    finalize_review: {
        description:
            '结束进行中的审查：记录最终结论和总体决定，整理它在 .graycode/review/**.md 下的文档结构，并更新最终摘要。' +
            'path 必须是当前进行中的那次审查的文档。调用之后不能再记录里程碑，除非先用 reopen_review 重新打开。',
        parameters: {
            path: '审查文档路径，位于 .graycode/review/**.md 下。',
            conclusion: '审查的最终结论。',
            overallDecision: '可选的总体决定：accepted、conditionally_accepted、rejected 或 needs_follow_up。',
            recommendedNextAction: '可选，要显示在摘要中的建议下一步。',
            reviewedModules: '可选，本次审查覆盖的模块数组，会合并到摘要。'
        }
    },

    validate_review_document: {
        description:
            '检查 .graycode/review/**.md 下已有的审查文档，不修改文件。结果会列出格式、元数据和一致性规则方面的问题。',
        parameters: {
            path: '审查文档路径，位于 .graycode/review/**.md 下。'
        }
    },

    reopen_review: {
        description:
            '重新打开 .graycode/review/**.md 下一份已结束的审查文档，让同一次审查可以继续记录里程碑。当前会话中已有其他进行中的审查时，调用会失败。',
        parameters: {
            path: '已结束的审查文档路径，位于 .graycode/review/**.md 下。'
        }
    },

    compare_review_documents: {
        description:
            '比较 .graycode/review/**.md 下的两份审查文档，不修改任何文件。结果列出新增、移除和延续的问题、跟踪状态的变化，以及摘要统计的差异。',
        parameters: {
            basePath: '作为比较起点的较早审查文档路径。',
            targetPath: '要与之比较的较新审查文档路径。',
            includeUnchanged: '是否同时列出没有变化的延续问题，默认为 false。'
        }
    }
};
