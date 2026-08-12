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
 *   add → id、content、status；set_status → id、status；set_content → id、content；
 *   cancel → id；remove → id；
 * - update_plan 保留 revision 与 progress_sync 的严格边界，删除重复表述；
 * - record_review_milestone / update_progress 等要求数组参数必须传数组。
 */

import type { ToolDescriptionLocalization } from '../../types';

export const workflow: Record<string, ToolDescriptionLocalization> = {
    todo_write: {
        description:
            '创建/替换当前会话的 TODO 列表（ConversationMetadata.custom["todoList"]）。' +
            '重要：使用本工具初始化列表；如需增量更新（状态/内容），请使用 todo_update。',
        parameters: {
            todos: '待办事项数组（必须传数组）',
            'todos[].id': '唯一的待办 ID',
            'todos[].content': '待办内容',
            'todos[].status': '待办状态：pending / in_progress / completed / cancelled'
        }
    },

    todo_update: {
        description:
            '增量更新当前会话的 TODO 列表（ConversationMetadata.custom["todoList"]），无需重写整个列表即可更新状态或内容。' +
            '各操作所需字段：add → id、content、status；set_status → id、status；set_content → id、content；cancel → id；remove → id。' +
            '响应只返回摘要统计，不回传完整列表。',
        parameters: {
            ops: '要应用到当前 TODO 列表的操作数组（必须传数组），按顺序应用',
            'ops[].op': '操作类型：add（新增或 upsert，id 已存在则更新）、set_status（更新状态）、set_content（更新内容）、cancel（设为 cancelled）、remove（移除）',
            'ops[].id': '目标待办 ID',
            'ops[].content': '待办内容（add/set_content 操作使用）',
            'ops[].status': '待办状态（add/set_status 操作使用）：pending / in_progress / completed / cancelled'
        }
    },

    create_design: {
        description:
            '创建设计文档（markdown）并写入 .graycode/design/**.md（多根工作区为 workspace/.graycode/design/**.md）。' +
            '本工具只创建设计；不创建计划，也不实现代码。目标文件已存在时拒绝覆盖，请改用 update_design。',
        parameters: {
            title: '可选的设计标题（用于默认文件名）',
            overview: '可选的一行概述',
            design: '设计文档内容（markdown 格式）',
            path: '可选的输出路径。必须位于 .graycode/design/**.md 下（多根工作区为 workspace/.graycode/design/**.md）。'
        }
    },

    update_design: {
        description:
            '更新 .graycode/design/**.md（多根工作区为 workspace/.graycode/design/**.md）下已有的设计文档（markdown）。' +
            '当用户要修订当前设计而不是新建时使用本工具。',
        parameters: {
            path: '目标设计文档路径，位于 .graycode/design/**.md 下',
            title: '可选的更新后设计标题',
            overview: '可选的更新后一行概述',
            design: '更新后的设计内容（markdown 格式）',
            changeSummary: '可选的本次设计修订变更摘要'
        }
    },

    create_plan: {
        description:
            '创建计划文档（markdown）并写入 .graycode/plans/**.md（多根工作区为 workspace/.graycode/plans/**.md）。' +
            '本工具只创建计划；不负责执行。目标文件已存在时拒绝覆盖，请改用 update_plan。',
        parameters: {
            title: '可选的计划标题（用于默认文件名）',
            overview: '可选的一行概述',
            plan: '计划内容（markdown 格式）',
            todos: 'TODO 清单（Cursor 风格），必须传数组；每项包含 id、content、status',
            'todos[].id': '待办 ID',
            'todos[].content': '待办内容',
            'todos[].status': '待办状态：pending / in_progress / completed / cancelled',
            sourceArtifact: '可选的源工件，用于对照已确认的设计或审查文档跟踪计划的新鲜度',
            'sourceArtifact.type': '源工件类型：design / review',
            'sourceArtifact.path': '源工件路径',
            path: '可选的输出路径。必须位于 .graycode/plans/**.md 下（多根工作区为 workspace/.graycode/plans/**.md）。'
        }
    },

    update_plan: {
        description:
            '更新 .graycode/plans/**.md（多根工作区为 workspace/.graycode/plans/**.md）下已有的计划文档（markdown）。' +
            'revision 模式重写计划本身并要求重新确认；progress_sync 模式只在实施期间同步 TODO 状态。' +
            'progress_sync 模式只发送 path、todos、updateMode 和可选的 changeSummary——不要发送 sourceArtifact，' +
            '也不要转发任何 continuation/source-artifact 延续字段（如 sourceArtifactType、sourcePath、sourceContent、planPath、planContent、continuationPrompt）。',
        parameters: {
            path: '目标计划文档路径，位于 .graycode/plans/**.md 下。直接复用已批准的计划路径，不要另发 sourcePath 或 planPath 字段。',
            title: '可选的更新后计划标题',
            overview: '可选的更新后一行概述',
            plan: '更新后的计划内容（markdown 格式）。revision 模式下必填。',
            todos: '更新后的计划 TODO 清单（必须传数组）；每项包含 id、content、status',
            'todos[].id': '待办 ID',
            'todos[].content': '待办内容',
            'todos[].status': '待办状态：pending / in_progress / completed / cancelled',
            updateMode: 'revision：重写计划并要求重新确认。progress_sync：实施期间仅同步 TODO 状态；该模式只发送 path、todos、updateMode 和可选的 changeSummary，误传 sourceArtifact 会被忽略并给出警告。',
            sourceArtifact: '可选的源工件，将计划重新绑定到最新已确认的设计或审查文档。仅 revision 模式有效；progress_sync 模式下会被忽略。只在 schema 明确允许时使用此嵌套对象，不要发送同级延续字段（sourceArtifactType、sourcePath、sourceContent 等）。',
            'sourceArtifact.type': '源工件类型：design / review',
            'sourceArtifact.path': '源工件路径',
            changeSummary: '可选的本次计划修订变更摘要'
        }
    },

    create_progress: {
        description:
            '在 .graycode/progress.md（多根工作区为 workspace/.graycode/progress.md）创建项目进度文档。' +
            '初始化项目级状态台账，并返回轻量进度快照而不是完整 markdown 正文。' +
            '文件已存在且有效时返回现有快照，不会创建第二个文件。',
        parameters: {
            path: '可选的输出路径。必须是 .graycode/progress.md（多根工作区为 workspace/.graycode/progress.md）。',
            projectName: '可选的项目可读名称（默认取第一个工作区名称）',
            projectId: '可选的稳定项目 ID（默认由项目名称生成 slug）',
            status: '项目状态：active / blocked / completed / archived',
            phase: '项目阶段：design / plan / implementation / review / maintenance',
            currentFocus: '当前焦点',
            latestConclusion: '最新结论',
            currentBlocker: '当前阻塞项',
            nextAction: '下一步行动',
            activeArtifacts: '当前关联工件引用（design/plan/review 路径）',
            'activeArtifacts.design': '设计文档路径',
            'activeArtifacts.plan': '计划文档路径',
            'activeArtifacts.review': '审查文档路径',
            todos: 'TODO 快照，必须传数组；每项包含 id、content、status',
            'todos[].id': '待办 ID',
            'todos[].content': '待办内容',
            'todos[].status': '待办状态：pending / in_progress / completed / cancelled',
            risks: '风险清单，必须传数组；每项包含 id、title、status、description',
            'risks[].id': '风险 ID',
            'risks[].title': '风险标题',
            'risks[].status': '风险状态：active / resolved / accepted',
            'risks[].description': '风险描述'
        }
    },

    update_progress: {
        description:
            '更新 .graycode/progress.md（多根工作区为 workspace/.graycode/progress.md）项目进度文档。' +
            '刷新摘要字段、关联工件、TODO 快照、风险与最近日志条目，并返回轻量进度快照。未传入的字段保持原值。',
        parameters: {
            path: '可选的目标路径。必须是 .graycode/progress.md（多根工作区为 workspace/.graycode/progress.md）。',
            status: '项目状态：active / blocked / completed / archived',
            phase: '项目阶段：design / plan / implementation / review / maintenance',
            currentFocus: '当前焦点',
            latestConclusion: '最新结论',
            currentBlocker: '当前阻塞项',
            nextAction: '下一步行动',
            activeArtifacts: '当前关联工件引用（design/plan/review 路径），只更新传入的键',
            'activeArtifacts.design': '设计文档路径',
            'activeArtifacts.plan': '计划文档路径',
            'activeArtifacts.review': '审查文档路径',
            todos: 'TODO 快照（整体替换），必须传数组；每项包含 id、content、status',
            'todos[].id': '待办 ID',
            'todos[].content': '待办内容',
            'todos[].status': '待办状态：pending / in_progress / completed / cancelled',
            risks: '风险清单（整体替换），必须传数组；每项包含 id、title、status、description',
            'risks[].id': '风险 ID',
            'risks[].title': '风险标题',
            'risks[].status': '风险状态：active / resolved / accepted',
            'risks[].description': '风险描述',
            appendLog: '要追加的日志条目数组（必须传数组），每项包含 type 与 message，可带 refId',
            'appendLog[].type': '日志类型：created / updated / milestone_recorded / artifact_changed / risk_changed',
            'appendLog[].refId': '可选的关联 ID（如里程碑 ID）',
            'appendLog[].message': '日志消息'
        }
    },

    record_progress_milestone: {
        description:
            '在 .graycode/progress.md（多根工作区为 workspace/.graycode/progress.md）中记录项目里程碑，并刷新最新进度快照。' +
            '本工具用于项目级进度节点，不是完整的审查发现或计划文档。',
        parameters: {
            path: '可选的目标路径。必须是 .graycode/progress.md（多根工作区为 workspace/.graycode/progress.md）。',
            milestoneId: '可选的里程碑 ID（省略时自动生成，如 PG1、PG2…）；已存在则报错',
            title: '里程碑标题',
            status: '里程碑状态：in_progress / completed（默认 completed）',
            summary: '里程碑摘要',
            relatedTodoIds: '关联的 TODO ID 数组（必须传数组）',
            relatedReviewMilestoneIds: '关联的审查里程碑 ID 数组（必须传数组）',
            relatedArtifacts: '关联工件引用（design/plan/review 路径）',
            'relatedArtifacts.design': '设计文档路径',
            'relatedArtifacts.plan': '计划文档路径',
            'relatedArtifacts.review': '审查文档路径',
            startedAt: '开始时间（ISO 时间字符串）',
            completedAt: '完成时间（ISO 时间字符串；status 为 completed 时默认取当前时间）',
            nextAction: '下一步行动',
            latestConclusion: '最新结论',
            currentBlocker: '当前阻塞项'
        }
    },

    validate_progress_document: {
        description:
            '只读校验 .graycode/progress.md（多根工作区为 workspace/.graycode/progress.md）进度文档，不修改文件。' +
            '报告元数据健康度、章节顺序与基本不变量。',
        parameters: {
            path: '目标进度文档路径。必须是 .graycode/progress.md（多根工作区为 workspace/.graycode/progress.md）。'
        }
    },

    create_review: {
        description:
            '创建审查文档（markdown）并写入 .graycode/review/**.md（多根工作区为 workspace/.graycode/review/**.md）。' +
            '本工具仅供 Review 模式使用，不得修改业务代码。目标文件已存在时拒绝覆盖，请用 record_review_milestone 或 finalize_review 继续。',
        parameters: {
            title: '可选的审查标题（用于默认文件名）',
            overview: '可选的一行审查概述',
            review: '初始审查内容（markdown 格式）',
            path: '可选的输出路径。必须位于 .graycode/review/**.md 下（多根工作区为 workspace/.graycode/review/**.md）。'
        }
    },

    record_review_milestone: {
        description:
            '向 .graycode/review/**.md 下已有的审查文档追加里程碑，并更新结构化摘要区与问题汇总区。',
        parameters: {
            path: '目标审查文档路径，位于 .graycode/review/**.md 下',
            milestoneId: '可选的里程碑 ID（省略时自动生成）',
            milestoneTitle: '里程碑标题',
            summary: '里程碑摘要（markdown 格式）',
            status: '里程碑状态：in_progress / completed',
            conclusion: '可选的摘要区最新结论',
            evidenceFiles: '可选的关联证据文件路径数组（必须传数组）。当无法提供行级引用时，用此字段做简单的文件级证据。',
            evidence: '可选的结构化证据引用数组（必须传数组），包含文件路径及可选的起始行、结束行、符号或摘要哈希',
            'evidence[].path': '证据文件路径',
            'evidence[].lineStart': '起始行号（1-based，可选）',
            'evidence[].lineEnd': '结束行号（1-based，可选）',
            'evidence[].symbol': '可选的符号名',
            'evidence[].excerptHash': '可选的证据片段哈希',
            findings: '可选的旧版问题字符串数组（必须传数组），合并到审查问题区',
            structuredFindings: '可选的结构化问题数组（必须传数组），合并到审查问题区。标题保持简洁，详细说明放到 description 中。',
            'structuredFindings[].id': '可选的问题 ID。没有简洁的现成 ID 时可省略。',
            'structuredFindings[].severity': '严重级别：high / medium / low',
            'structuredFindings[].category': '问题类别：html / css / javascript / accessibility / performance / maintainability / docs / test / other',
            'structuredFindings[].title': '简短问题标题。使用简洁的问题标签，不要写成完整句子、文件路径或建议。',
            'structuredFindings[].description': '问题的详细说明。把推理过程、影响和背景放在这里。',
            'structuredFindings[].evidenceFiles': '可选的该问题简单证据文件路径数组（必须传数组）',
            'structuredFindings[].evidence': '可选的结构化证据引用数组（必须传数组）',
            'structuredFindings[].evidence[].path': '证据文件路径',
            'structuredFindings[].evidence[].lineStart': '起始行号（1-based，可选）',
            'structuredFindings[].evidence[].lineEnd': '结束行号（1-based，可选）',
            'structuredFindings[].evidence[].symbol': '可选的符号名',
            'structuredFindings[].evidence[].excerptHash': '可选的证据片段哈希',
            'structuredFindings[].relatedMilestoneIds': '可选的关联里程碑 ID 数组（必须传数组），用于交叉引用',
            'structuredFindings[].recommendation': '可选的后续修复或处理建议',
            'structuredFindings[].trackingStatus': '跟踪状态：open / accepted_risk / fixed / wont_fix / duplicate',
            reviewedModules: '可选的已审查模块数组（必须传数组），合并到审查摘要区',
            recommendedNextAction: '可选的审查摘要区推荐下一步行动'
        }
    },

    finalize_review: {
        description:
            '结束 .graycode/review/**.md 下已有的审查文档：规范化其结构并更新最终审查摘要。',
        parameters: {
            path: '目标审查文档路径，位于 .graycode/review/**.md 下',
            conclusion: '最终审查结论',
            overallDecision: '可选的总体审查决策：accepted / conditionally_accepted / rejected / needs_follow_up',
            recommendedNextAction: '可选的摘要区推荐下一步行动',
            reviewedModules: '可选的已审查模块数组（必须传数组），合并到摘要区'
        }
    },

    validate_review_document: {
        description:
            '只读校验 .graycode/review/**.md 下已有的审查文档，不修改文件。报告格式、元数据健康度与不变量问题。',
        parameters: {
            path: '目标审查文档路径，位于 .graycode/review/**.md 下'
        }
    },

    reopen_review: {
        description:
            '重新打开 .graycode/review/**.md 下已结束的审查文档，使同一轮审查可以继续记录里程碑。',
        parameters: {
            path: '目标已结束审查文档路径，位于 .graycode/review/**.md 下'
        }
    },

    compare_review_documents: {
        description:
            '只读比较 .graycode/review/**.md 下的两份审查文档，不修改任何文件。' +
            '返回问题增量（新增/移除/持续）、跟踪状态变化与快照统计差异。',
        parameters: {
            basePath: '基准审查文档路径，位于 .graycode/review/**.md 下',
            targetPath: '目标审查文档路径，位于 .graycode/review/**.md 下',
            includeUnchanged: '是否在结果中包含未变化的持续问题'
        }
    }
};
