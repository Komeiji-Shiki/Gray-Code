<!--
本快照由命令 node scripts/i18n-sync.mjs --report 生成，生成日期：2026-08-13。
手工刷新：node scripts/i18n-sync.mjs --report > scripts/i18n-inventory-snapshot.md（再补本头注）。
快照仅作盘点存档，以 --report 实时输出为准。
-->

========================================================================
GrayCode i18n 语言包盘点报告
========================================================================

【1】结构概览（叶子 key 数）

  backend（zh-CN / en / ja 叶子数: 528 / 528 / 528）
    - modules: 238
    - tools: 143
    - notifications: 8
    - workspace: 4
    - multimodal: 4
    - webview: 125
    - errors: 6

  frontend（zh-CN / en / ja 叶子数: 2910 / 2910 / 2910）
    - common: 78
    - components: 2747
    - app: 19
    - errors: 13
    - composables: 6
    - stores: 26
    - utils: 21

【2】完全重复词条（zh 译文精确相同；key 不同，值相同）
  共 85 条 zh 译文在两端同时出现（已迁移 = 该译文对应的全部 frontend key 已登记到 manifest）
  - "CSS" （已迁移）
      backend : tools.reviewDocument.values.category.css
      frontend: components.message.tool.reviewCard.categoryCss
  - "HTML" （已迁移）
      backend : tools.reviewDocument.values.category.html
      frontend: components.message.tool.reviewCard.categoryHtml
  - "ID 只能包含字母、数字、下划线和中划线" （已迁移）
      backend : modules.mcp.errors.invalidServerId
      frontend: components.settings.mcpSettings.form.serverIdError
  - "JavaScript" （已迁移）
      backend : tools.reviewDocument.values.category.javascript
      frontend: components.message.tool.reviewCard.categoryJavascript
  - "{name} 安装成功！" （已迁移）
      backend : modules.dependencies.progress.installSuccess
      frontend: components.settings.dependencySettings.progress.installSuccess
  - "、" （已迁移）
      backend : webview.promptSettings.dynamicSection.strategyVarsSeparator
      frontend: components.settings.promptSettings.dynamicSection.strategyVarsSeparator
  - "下一步建议" （已迁移）
      backend : tools.reviewDocument.milestone.recommendedNextAction, tools.reviewDocument.summary.recommendedNextAction
      frontend: components.message.tool.reviewCard.recommendedNextAction
  - "不修复" （已迁移）
      backend : tools.reviewDocument.values.trackingStatus.wontFix
      frontend: components.message.tool.reviewCard.trackingWontFix
  - "不通过" （已迁移）
      backend : tools.reviewDocument.values.overallDecision.rejected
      frontend: components.message.tool.reviewCard.decisionRejected
  - "严重级别" （已迁移）
      backend : tools.reviewDocument.finding.severity
      frontend: components.message.tool.reviewCard.changeSeverity
  - "中" （已迁移）
      backend : tools.reviewDocument.values.severity.medium
      frontend: components.channels.anthropic.thinking.effortMedium, components.channels.gemini.thinking.levelMedium, components.channels.openai.thinking.effortMedium, components.message.tool.reviewCard.severityMedium
  - "传统模板" （已迁移）
      backend : webview.promptSettings.assemblyMode.legacyLabel
      frontend: components.settings.promptSettings.assemblyMode.legacyLabel
  - "低" （已迁移）
      backend : tools.reviewDocument.values.severity.low
      frontend: components.channels.anthropic.thinking.effortLow, components.channels.gemini.thinking.levelLow, components.channels.openai.thinking.effortLow, components.message.tool.reviewCard.severityLow
  - "使用可排序条目，并通过 Chat History 控制真实历史位置。" （已迁移）
      backend : webview.promptSettings.assemblyMode.entriesDescription
      frontend: components.settings.promptSettings.assemblyMode.entriesDescription
  - "使用系统提示词模板和动态上下文模板。" （已迁移）
      backend : webview.promptSettings.assemblyMode.legacyDescription
      frontend: components.settings.promptSettings.assemblyMode.legacyDescription
  - "保留旧动态上下文原位" （已迁移）
      backend : webview.promptSettings.dynamicSection.strategyPreserve
      frontend: components.settings.promptSettings.dynamicSection.strategyPreserve
  - "保留旧动态上下文原位 会把旧回合的动态快照固定插回原位，并在当前回合插入当前上下文，适合长上下文和多历史回合。" （已迁移）
      backend : webview.promptSettings.dynamicSection.strategyVarsWarning
      frontend: components.settings.promptSettings.dynamicSection.strategyVarsWarning
  - "保留模式会增加请求 token；旧动态上下文越多，越容易触发上下文裁剪或总结。" （已迁移）
      backend : webview.promptSettings.dynamicSection.strategyPreserveWarning
      frontend: components.settings.promptSettings.dynamicSection.strategyPreserveWarning
  - "全部拒绝" （已迁移）
      backend : tools.file.diffCodeLens.rejectAll
      frontend: components.message.tool.rejectAll
  - "其他" （已迁移）
      backend : tools.reviewDocument.values.category.other
      frontend: components.message.tool.reviewCard.categoryOther, components.settings.autoExec.categories.other, components.settings.toolsSettings.categories.other
  - "动态上下文策略" （已迁移）
      backend : webview.promptSettings.dynamicSection.strategyTitle
      frontend: components.settings.promptSettings.dynamicSection.strategyTitle
  - "单份动态上下文" （已迁移）
      backend : webview.promptSettings.dynamicSection.strategySingle
      frontend: components.settings.promptSettings.dynamicSection.strategySingle
  - "单份模式保持现有行为；保留模式会把已缓存的旧动态上下文固定插回原回合位置，新回合上下文插入到新消息前。" （已迁移）
      backend : webview.promptSettings.dynamicSection.strategyDescription
      frontend: components.settings.promptSettings.dynamicSection.strategyDescription
  - "可维护性" （已迁移）
      backend : tools.reviewDocument.values.category.maintainability
      frontend: components.message.tool.reviewCard.categoryMaintainability
  - "可访问性" （已迁移）
      backend : tools.reviewDocument.values.category.accessibility
      frontend: components.message.tool.reviewCard.categoryAccessibility
  - "失败" （已迁移）
      backend : notifications.windowsAgentStop.reasonLabels.error
      frontend: common.failed, components.backgroundTasks.failed, components.message.responseViewer.toolStatuses.error, components.settings.checkpoint.sections.cleanup.progress.failed, components.subagents.monitor.status.failed, components.tools.file.createDirectoryPanel.failed, components.tools.file.deleteFilePanel.failed, components.tools.media.cropImagePanel.status.failed, components.tools.media.generateImagePanel.status.failed, components.tools.media.removeBackgroundPanel.status.failed, components.tools.media.resizeImagePanel.status.failed, components.tools.media.rotateImagePanel.status.failed, components.tools.terminal.executeCommandPanel.status.failed
  - "已修复" （已迁移）
      backend : tools.reviewDocument.values.trackingStatus.fixed
      frontend: components.message.tool.reviewCard.trackingFixed
  - "已完成" （已迁移）
      backend : tools.reviewDocument.values.milestoneStatus.completed
      frontend: common.completed, components.backgroundTasks.completed, components.message.tool.progressCard.milestoneStatusCompleted, components.message.tool.progressCard.statusCompleted, components.message.tool.reviewCard.statusCompleted, components.message.tool.todoPanel.statusCompleted, components.subagents.monitor.status.completed, components.tools.subagents.completed
  - "已审模块" （已迁移）
      backend : tools.reviewDocument.milestone.reviewedModules, tools.reviewDocument.summary.reviewedModules
      frontend: components.message.tool.reviewCard.modules
  - "已断开" （已迁移）
      backend : modules.mcp.status.disconnected
      frontend: components.settings.mcp.disconnected
  - "已连接" （已迁移）
      backend : modules.mcp.status.connected
      frontend: components.settings.mcp.connected, components.settings.mcpSettings.status.connected
  - "建议" （已迁移）
      backend : tools.reviewDocument.finding.recommendation
      frontend: components.message.tool.reviewCard.changeRecommendation
  - "开放" （已迁移）
      backend : tools.reviewDocument.values.trackingStatus.open
      frontend: components.message.tool.reviewCard.trackingOpen
  - "当前进度" （已迁移）
      backend : tools.reviewDocument.summary.currentProgress
      frontend: components.message.tool.progressCard.currentProgress
  - "当预设条目或传统模板中包含" （已迁移）
      backend : webview.promptSettings.dynamicSection.strategyVarsPrefix
      frontend: components.settings.promptSettings.dynamicSection.strategyVarsPrefix
  - "性能" （已迁移）
      backend : tools.reviewDocument.values.category.performance
      frontend: components.message.tool.reviewCard.categoryPerformance
  - "恢复检查点失败" （已迁移）
      backend : modules.checkpoint.errors.restoreFailed, webview.errors.restoreCheckpointFailed
      frontend: components.message.checkpoint.restoreResultFailed, stores.chatStore.errors.restoreCheckpointFailed
  - "打开 diff 预览失败" （已迁移）
      backend : webview.errors.openDiffPreviewFailed
      frontend: components.message.tool.openDiffFailed
  - "打开文件失败" 
      backend : webview.errors.openFileFailed
      frontend: components.common.markdown.openFileFailed, components.message.tool.designCard.openFileFailed, components.message.tool.planCard.openFileFailed
  - "执行前" （已迁移）
      backend : modules.checkpoint.description.before
      frontend: components.settings.checkpoint.sections.cleanup.phaseBefore, components.settings.checkpoint.sections.tools.beforeLabel
  - "执行后" （已迁移）
      backend : modules.checkpoint.description.after
      frontend: components.settings.checkpoint.sections.cleanup.phaseAfter, components.settings.checkpoint.sections.tools.afterLabel
  - "执行计划" （已迁移）
      backend : notifications.windowsAgentStop.actionLabels.executePlan
      frontend: app.agentStopNotification.actions.executePlan, components.message.tool.planCard.executePlan
  - "执行超时" （已迁移）
      backend : tools.errors.timeout
      frontend: components.settings.toolSettings.terminal.executeCommand.execTimeout
  - "拒绝" （已迁移）
      backend : tools.file.diffCodeLens.reject
      frontend: components.message.tool.reject, components.tools.reject
  - "接受风险" （已迁移）
      backend : tools.reviewDocument.values.trackingStatus.acceptedRisk
      frontend: components.message.tool.reviewCard.trackingAcceptedRisk
  - "提示词组装方式" （已迁移）
      backend : webview.promptSettings.assemblyMode.title
      frontend: components.settings.promptSettings.assemblyMode.title
  - "摘要" （已迁移）
      backend : tools.reviewDocument.milestone.summary
      frontend: components.channels.anthropic.thinking.displaySummarized
  - "操作已取消" （已迁移）
      backend : errors.cancelled
      frontend: errors.cancelled
  - "文件不在任何打开的工作区内" （已迁移）
      backend : webview.errors.fileNotInAnyWorkspace
      frontend: components.input.notifications.fileNotInAnyWorkspace
  - "文件不存在" （已迁移）
      backend : webview.errors.fileNotExists
      frontend: components.input.fileNotExists
  - "文件属于其他工作区: {workspaceName}" （已迁移）
      backend : webview.errors.fileInOtherWorkspace
      frontend: components.input.notifications.fileInOtherWorkspace
  - "文档" （已迁移）
      backend : tools.reviewDocument.values.category.docs
      frontend: components.message.tool.reviewCard.categoryDocs, components.settings.channelSettings.form.multimodal.document
  - "日期" （已迁移）
      backend : tools.reviewDocument.header.date
      frontend: common.date
  - "显示" 
      backend : tools.common.show
      frontend: common.show, components.settings.channelSettings.form.apiKey.show, components.settings.generateImageSettings.api.show
  - "最新结论" （已迁移）
      backend : tools.reviewDocument.summary.latestConclusion
      frontend: components.message.tool.progressCard.latestConclusion, components.message.tool.reviewCard.latestConclusion
  - "有条件通过" （已迁移）
      backend : tools.reviewDocument.values.overallDecision.conditionallyAccepted
      frontend: components.message.tool.reviewCard.decisionConditionallyAccepted
  - "未知错误" （已迁移）
      backend : errors.unknown, modules.api.chat.errors.unknownError
      frontend: common.unknownError, components.settings.dependencySettings.progress.unknownError, errors.unknown, stores.chatStore.errors.unknownError
  - "正在连接..." （已迁移）
      backend : modules.mcp.status.connecting
      frontend: components.settings.mcpSettings.serverCard.connecting, components.settings.mcpSettings.status.connecting
  - "此次修改删除了 {deletePercent}% 的文件内容（{deletedLines}/{totalLines} 行），超过 {threshold}% 的警戒阈值，请仔细检查" （已迁移）
      backend : tools.file.diffManager.diffGuardWarning
      frontend: components.settings.toolSettings.files.applyDiff.diffGuardWarning
  - "每个模式只能选择一种组装方式：传统模板或预设条目。" （已迁移）
      backend : webview.promptSettings.assemblyMode.description
      frontend: components.settings.promptSettings.assemblyMode.description
  - "测试" （已迁移）
      backend : tools.reviewDocument.values.category.test
      frontend: components.message.tool.reviewCard.categoryTest
  - "添加模型失败" （已迁移）
      backend : modules.api.models.errors.addModelsFailed, webview.errors.addModelsFailed
      frontend: components.settings.modelManager.errors.addFailed
  - "状态" （已迁移）
      backend : tools.reviewDocument.header.status, tools.reviewDocument.milestone.status
      frontend: common.status, components.message.responseViewer.status, components.message.tool.progressCard.status, components.message.tool.reviewCard.status
  - "生成计划" （已迁移）
      backend : notifications.windowsAgentStop.actionLabels.generatePlan
      frontend: app.agentStopNotification.actions.generatePlan, components.message.tool.designCard.generatePlan, components.message.tool.reviewCard.generatePlan
  - "相关里程碑" （已迁移）
      backend : tools.reviewDocument.finding.relatedMilestones
      frontend: components.message.tool.reviewCard.changeRelatedMilestoneIds
  - "确认" （已迁移）
      backend : notifications.windowsAgentStop.actionLabels.genericConfirmation
      frontend: common.confirm, components.common.confirmDialog.confirm, components.common.confirmDialog.title, components.settings.channelSettings.dialog.delete.confirm, components.settings.channelSettings.selector.confirm
  - "移除模型失败" （已迁移）
      backend : modules.api.models.errors.removeModelFailed, webview.errors.removeModelFailed
      frontend: components.settings.modelManager.errors.removeFailed
  - "等会变化变量时，此设置决定旧回合快照是否保留。" （已迁移）
      backend : webview.promptSettings.dynamicSection.strategyVarsSuffix
      frontend: components.settings.promptSettings.dynamicSection.strategyVarsSuffix
  - "终止终端失败" （已迁移）
      backend : webview.errors.killTerminalFailed
      frontend: stores.terminalStore.errors.killTerminalFailed
  - "结论" （已迁移）
      backend : tools.reviewDocument.milestone.conclusion
      frontend: components.message.tool.reviewCard.decision
  - "继续" （已迁移）
      backend : notifications.windowsAgentStop.actionLabels.continue
      frontend: app.agentStopNotification.actions.continue, common.resume, components.message.continue.button, components.subagents.monitor.resume
  - "设置激活模型失败" （已迁移）
      backend : modules.api.models.errors.setActiveModelFailed, webview.errors.setActiveModelFailed
      frontend: components.settings.modelManager.errors.setActiveFailed
  - "证据" （已迁移）
      backend : tools.reviewDocument.finding.evidenceFiles, tools.reviewDocument.milestone.evidenceFiles
      frontend: components.message.tool.reviewCard.changeEvidence, components.message.tool.reviewCard.evidence
  - "该存档创建时按当时的排除规则排除了 {count} 个文件" （已迁移）
      backend : modules.checkpoint.restore.excludedNote
      frontend: components.settings.checkpoint.sections.cleanup.manifestNote
  - "说明" （已迁移）
      backend : tools.reviewDocument.finding.description
      frontend: common.description, components.message.tool.reviewCard.changeDescription, components.settings.mcpSettings.form.description, components.settings.subagents.description
  - "读取文件失败" 
      backend : webview.errors.readFileFailed
      frontend: components.input.promptContext.readFailed, composables.useAttachments.errors.readFileFailed, utils.file.readFailed
  - "跟踪状态" （已迁移）
      backend : tools.reviewDocument.finding.trackingStatus
      frontend: components.message.tool.reviewCard.changeTrackingStatus, components.message.tool.reviewCard.tracking
  - "进行中" （已迁移）
      backend : tools.reviewDocument.values.milestoneStatus.inProgress
      frontend: components.message.tool.progressCard.milestoneStatusInProgress, components.message.tool.progressCard.statusActive, components.message.tool.reviewCard.statusInProgress, components.message.tool.todoPanel.statusInProgress
  - "通过" （已迁移）
      backend : tools.reviewDocument.values.overallDecision.accepted
      frontend: components.message.tool.reviewCard.decisionAccepted
  - "重复" （已迁移）
      backend : tools.reviewDocument.values.trackingStatus.duplicate
      frontend: components.message.tool.reviewCard.trackingDuplicate
  - "错误" （已迁移）
      backend : modules.mcp.status.error
      frontend: common.error, components.message.tool.error, components.message.tool.progressCard.issueError, components.message.tool.reviewCard.issueError, components.settings.contextSettings.diagnostics.severity.error, components.settings.mcp.error, components.settings.toolSettings.common.error, components.tools.error, components.tools.media.cropImagePanel.status.error, components.tools.media.generateImagePanel.status.error, components.tools.media.removeBackgroundPanel.status.error, components.tools.media.resizeImagePanel.status.error, components.tools.media.rotateImagePanel.status.error
  - "问题" （已迁移）
      backend : tools.reviewDocument.milestone.findings
      frontend: components.message.tool.reviewCard.findings
  - "隐藏" 
      backend : tools.common.hide
      frontend: common.hide, components.channels.anthropic.thinking.displayOmitted, components.settings.channelSettings.form.apiKey.hide, components.settings.generateImageSettings.api.hide
  - "预设条目" （已迁移）
      backend : webview.promptSettings.assemblyMode.entriesLabel
      frontend: components.settings.promptSettings.assemblyMode.entriesLabel
  - "高" （已迁移）
      backend : tools.reviewDocument.values.severity.high
      frontend: components.channels.gemini.thinking.levelHigh, components.channels.openai.thinking.effortHigh, components.message.tool.reviewCard.severityHigh

【3】三语言完全一致词条（zh/en/ja 译文在两端完全相同）——最强重复信号
  共 85 组
  - zh="CSS" en="CSS" ja="CSS" （已迁移）
      backend : tools.reviewDocument.values.category.css
      frontend: components.message.tool.reviewCard.categoryCss
  - zh="HTML" en="HTML" ja="HTML" （已迁移）
      backend : tools.reviewDocument.values.category.html
      frontend: components.message.tool.reviewCard.categoryHtml
  - zh="ID 只能包含字母、数字、下划线和中划线" en="ID can only contain letters, numbers, underscores and hyphens" ja="ID には英数字、アンダースコア、ハイフンのみ使用できます" （已迁移）
      backend : modules.mcp.errors.invalidServerId
      frontend: components.settings.mcpSettings.form.serverIdError
  - zh="JavaScript" en="JavaScript" ja="JavaScript" （已迁移）
      backend : tools.reviewDocument.values.category.javascript
      frontend: components.message.tool.reviewCard.categoryJavascript
  - zh="{name} 安装成功！" en="{name} installed successfully!" ja="{name} のインストールが完了しました！" （已迁移）
      backend : modules.dependencies.progress.installSuccess
      frontend: components.settings.dependencySettings.progress.installSuccess
  - zh="、" en=", " ja="、" （已迁移）
      backend : webview.promptSettings.dynamicSection.strategyVarsSeparator
      frontend: components.settings.promptSettings.dynamicSection.strategyVarsSeparator
  - zh="下一步建议" en="Recommended Next Action" ja="次の対応" （已迁移）
      backend : tools.reviewDocument.milestone.recommendedNextAction, tools.reviewDocument.summary.recommendedNextAction
      frontend: components.message.tool.reviewCard.recommendedNextAction
  - zh="不修复" en="Won't Fix" ja="修正しない" （已迁移）
      backend : tools.reviewDocument.values.trackingStatus.wontFix
      frontend: components.message.tool.reviewCard.trackingWontFix
  - zh="不通过" en="Rejected" ja="却下" （已迁移）
      backend : tools.reviewDocument.values.overallDecision.rejected
      frontend: components.message.tool.reviewCard.decisionRejected
  - zh="严重级别" en="Severity" ja="重大度" （已迁移）
      backend : tools.reviewDocument.finding.severity
      frontend: components.message.tool.reviewCard.changeSeverity
  - zh="中" en="Medium" ja="中" （已迁移）
      backend : tools.reviewDocument.values.severity.medium
      frontend: components.channels.anthropic.thinking.effortMedium, components.channels.gemini.thinking.levelMedium, components.channels.openai.thinking.effortMedium, components.message.tool.reviewCard.severityMedium
  - zh="传统模板" en="Legacy template" ja="従来テンプレート" （已迁移）
      backend : webview.promptSettings.assemblyMode.legacyLabel
      frontend: components.settings.promptSettings.assemblyMode.legacyLabel
  - zh="低" en="Low" ja="低" （已迁移）
      backend : tools.reviewDocument.values.severity.low
      frontend: components.channels.anthropic.thinking.effortLow, components.channels.gemini.thinking.levelLow, components.channels.openai.thinking.effortLow, components.message.tool.reviewCard.severityLow
  - zh="使用可排序条目，并通过 Chat History 控制真实历史位置。" en="Uses sortable entries, with Chat History controlling the actual history position." ja="並べ替え可能なエントリを使用し、Chat History で実際の履歴の位置を制御します。" （已迁移）
      backend : webview.promptSettings.assemblyMode.entriesDescription
      frontend: components.settings.promptSettings.assemblyMode.entriesDescription
  - zh="使用系统提示词模板和动态上下文模板。" en="Uses the system prompt template and the dynamic context template." ja="システムプロンプトテンプレートと動的コンテキストテンプレートを使用します。" （已迁移）
      backend : webview.promptSettings.assemblyMode.legacyDescription
      frontend: components.settings.promptSettings.assemblyMode.legacyDescription
  - zh="保留旧动态上下文原位" en="Preserve old dynamic context in place" ja="古い動的コンテキストを元の位置に保持" （已迁移）
      backend : webview.promptSettings.dynamicSection.strategyPreserve
      frontend: components.settings.promptSettings.dynamicSection.strategyPreserve
  - zh="保留旧动态上下文原位 会把旧回合的动态快照固定插回原位，并在当前回合插入当前上下文，适合长上下文和多历史回合。" en="Preserving old dynamic context in place fixes old-turn dynamic snapshots back into their original positions and inserts the current context in the current turn, suitable for long contexts and many history turns." ja="古い動的コンテキストを元の位置に保持すると、古いターンの動的スナップショットを元の位置に固定して戻し、現在のターンに現在のコンテキストを挿入します。長いコンテキストや多数の履歴ターンに適しています。" （已迁移）
      backend : webview.promptSettings.dynamicSection.strategyVarsWarning
      frontend: components.settings.promptSettings.dynamicSection.strategyVarsWarning
  - zh="保留模式会增加请求 token；旧动态上下文越多，越容易触发上下文裁剪或总结。" en="Preserve mode increases request tokens. More preserved contexts make context trimming or summarization more likely." ja="保持モードはリクエストのトークン数を増やします。保持するコンテキストが多いほど、コンテキスト裁剪や要約が発生しやすくなります。" （已迁移）
      backend : webview.promptSettings.dynamicSection.strategyPreserveWarning
      frontend: components.settings.promptSettings.dynamicSection.strategyPreserveWarning
  - zh="全部拒绝" en="Reject All" ja="すべて拒否" （已迁移）
      backend : tools.file.diffCodeLens.rejectAll
      frontend: components.message.tool.rejectAll
  - zh="其他" en="Other" ja="その他" （已迁移）
      backend : tools.reviewDocument.values.category.other
      frontend: components.message.tool.reviewCard.categoryOther, components.settings.autoExec.categories.other, components.settings.toolsSettings.categories.other
  - zh="动态上下文策略" en="Dynamic context strategy" ja="動的コンテキスト戦略" （已迁移）
      backend : webview.promptSettings.dynamicSection.strategyTitle
      frontend: components.settings.promptSettings.dynamicSection.strategyTitle
  - zh="单份动态上下文" en="Single dynamic context" ja="単一の動的コンテキスト" （已迁移）
      backend : webview.promptSettings.dynamicSection.strategySingle
      frontend: components.settings.promptSettings.dynamicSection.strategySingle
  - zh="单份模式保持现有行为；保留模式会把已缓存的旧动态上下文固定插回原回合位置，新回合上下文插入到新消息前。" en="Single mode keeps existing behavior. Preserve mode inserts cached old dynamic contexts back at their original turns and inserts the new context before the new message." ja="単一モードは既存の動作を維持します。保持モードでは、キャッシュ済みの古い動的コンテキストを元のターン位置に戻し、新しいコンテキストを新しいメッセージの前に挿入します。" （已迁移）
      backend : webview.promptSettings.dynamicSection.strategyDescription
      frontend: components.settings.promptSettings.dynamicSection.strategyDescription
  - zh="可维护性" en="Maintainability" ja="保守性" （已迁移）
      backend : tools.reviewDocument.values.category.maintainability
      frontend: components.message.tool.reviewCard.categoryMaintainability
  - zh="可访问性" en="Accessibility" ja="アクセシビリティ" （已迁移）
      backend : tools.reviewDocument.values.category.accessibility
      frontend: components.message.tool.reviewCard.categoryAccessibility
  - zh="失败" en="Failure" ja="失敗" （已迁移）
      backend : notifications.windowsAgentStop.reasonLabels.error
      frontend: common.failed, components.backgroundTasks.failed, components.message.responseViewer.toolStatuses.error, components.settings.checkpoint.sections.cleanup.progress.failed, components.subagents.monitor.status.failed, components.tools.file.createDirectoryPanel.failed, components.tools.file.deleteFilePanel.failed, components.tools.media.cropImagePanel.status.failed, components.tools.media.generateImagePanel.status.failed, components.tools.media.removeBackgroundPanel.status.failed, components.tools.media.resizeImagePanel.status.failed, components.tools.media.rotateImagePanel.status.failed, components.tools.terminal.executeCommandPanel.status.failed
  - zh="已修复" en="Fixed" ja="修正済み" （已迁移）
      backend : tools.reviewDocument.values.trackingStatus.fixed
      frontend: components.message.tool.reviewCard.trackingFixed
  - zh="已完成" en="Completed" ja="完了" （已迁移）
      backend : tools.reviewDocument.values.milestoneStatus.completed
      frontend: common.completed, components.backgroundTasks.completed, components.message.tool.progressCard.milestoneStatusCompleted, components.message.tool.progressCard.statusCompleted, components.message.tool.reviewCard.statusCompleted, components.message.tool.todoPanel.statusCompleted, components.subagents.monitor.status.completed, components.tools.subagents.completed
  - zh="已审模块" en="Reviewed Modules" ja="レビュー済みモジュール" （已迁移）
      backend : tools.reviewDocument.milestone.reviewedModules, tools.reviewDocument.summary.reviewedModules
      frontend: components.message.tool.reviewCard.modules
  - zh="已断开" en="Disconnected" ja="切断済み" （已迁移）
      backend : modules.mcp.status.disconnected
      frontend: components.settings.mcp.disconnected
  - zh="已连接" en="Connected" ja="接続済み" （已迁移）
      backend : modules.mcp.status.connected
      frontend: components.settings.mcp.connected, components.settings.mcpSettings.status.connected
  - zh="建议" en="Recommendation" ja="提案" （已迁移）
      backend : tools.reviewDocument.finding.recommendation
      frontend: components.message.tool.reviewCard.changeRecommendation
  - zh="开放" en="Open" ja="オープン" （已迁移）
      backend : tools.reviewDocument.values.trackingStatus.open
      frontend: components.message.tool.reviewCard.trackingOpen
  - zh="当前进度" en="Current Progress" ja="現在の進捗" （已迁移）
      backend : tools.reviewDocument.summary.currentProgress
      frontend: components.message.tool.progressCard.currentProgress
  - zh="当预设条目或传统模板中包含" en="When preset entries or legacy templates contain" ja="プリセットエントリまたは従来テンプレートに" （已迁移）
      backend : webview.promptSettings.dynamicSection.strategyVarsPrefix
      frontend: components.settings.promptSettings.dynamicSection.strategyVarsPrefix
  - zh="性能" en="Performance" ja="パフォーマンス" （已迁移）
      backend : tools.reviewDocument.values.category.performance
      frontend: components.message.tool.reviewCard.categoryPerformance
  - zh="恢复检查点失败" en="Failed to restore checkpoint" ja="チェックポイントの復元に失敗しました" （已迁移）
      backend : modules.checkpoint.errors.restoreFailed, webview.errors.restoreCheckpointFailed
      frontend: components.message.checkpoint.restoreResultFailed, stores.chatStore.errors.restoreCheckpointFailed
  - zh="打开 diff 预览失败" en="Failed to open diff preview" ja="diff プレビューを開くのに失敗しました" （已迁移）
      backend : webview.errors.openDiffPreviewFailed
      frontend: components.message.tool.openDiffFailed
  - zh="打开文件失败" en="Failed to open file" ja="ファイルを開くのに失敗しました" （已迁移）
      backend : webview.errors.openFileFailed
      frontend: components.message.tool.designCard.openFileFailed, components.message.tool.planCard.openFileFailed
  - zh="执行前" en="Before" ja="実行前" （已迁移）
      backend : modules.checkpoint.description.before
      frontend: components.settings.checkpoint.sections.cleanup.phaseBefore, components.settings.checkpoint.sections.tools.beforeLabel
  - zh="执行后" en="After" ja="実行後" （已迁移）
      backend : modules.checkpoint.description.after
      frontend: components.settings.checkpoint.sections.cleanup.phaseAfter, components.settings.checkpoint.sections.tools.afterLabel
  - zh="执行计划" en="Execute Plan" ja="計画を実行" （已迁移）
      backend : notifications.windowsAgentStop.actionLabels.executePlan
      frontend: app.agentStopNotification.actions.executePlan, components.message.tool.planCard.executePlan
  - zh="执行超时" en="Execution Timeout" ja="実行がタイムアウトしました" （已迁移）
      backend : tools.errors.timeout
      frontend: components.settings.toolSettings.terminal.executeCommand.execTimeout
  - zh="拒绝" en="Reject" ja="拒否" （已迁移）
      backend : tools.file.diffCodeLens.reject
      frontend: components.message.tool.reject, components.tools.reject
  - zh="接受风险" en="Accepted Risk" ja="リスク受容" （已迁移）
      backend : tools.reviewDocument.values.trackingStatus.acceptedRisk
      frontend: components.message.tool.reviewCard.trackingAcceptedRisk
  - zh="提示词组装方式" en="Prompt assembly mode" ja="プロンプト組み立て方式" （已迁移）
      backend : webview.promptSettings.assemblyMode.title
      frontend: components.settings.promptSettings.assemblyMode.title
  - zh="摘要" en="Summary" ja="要約" （已迁移）
      backend : tools.reviewDocument.milestone.summary
      frontend: components.channels.anthropic.thinking.displaySummarized
  - zh="操作已取消" en="Operation cancelled" ja="操作がキャンセルされました" （已迁移）
      backend : errors.cancelled
      frontend: errors.cancelled
  - zh="文件不在任何打开的工作区内" en="File is not in any open workspace" ja="ファイルが開いているワークスペースにありません" （已迁移）
      backend : webview.errors.fileNotInAnyWorkspace
      frontend: components.input.notifications.fileNotInAnyWorkspace
  - zh="文件不存在" en="File does not exist" ja="ファイルが存在しません" （已迁移）
      backend : webview.errors.fileNotExists
      frontend: components.input.fileNotExists
  - zh="文件属于其他工作区: {workspaceName}" en="File belongs to another workspace: {workspaceName}" ja="ファイルは別のワークスペースに属しています: {workspaceName}" （已迁移）
      backend : webview.errors.fileInOtherWorkspace
      frontend: components.input.notifications.fileInOtherWorkspace
  - zh="文档" en="Docs" ja="ドキュメント" （已迁移）
      backend : tools.reviewDocument.values.category.docs
      frontend: components.message.tool.reviewCard.categoryDocs, components.settings.channelSettings.form.multimodal.document
  - zh="日期" en="Date" ja="日付" （已迁移）
      backend : tools.reviewDocument.header.date
      frontend: common.date
  - zh="显示" en="Show" ja="表示" 
      backend : tools.common.show
      frontend: common.show, components.settings.channelSettings.form.apiKey.show, components.settings.generateImageSettings.api.show
  - zh="最新结论" en="Latest Conclusion" ja="最新の結論" （已迁移）
      backend : tools.reviewDocument.summary.latestConclusion
      frontend: components.message.tool.progressCard.latestConclusion, components.message.tool.reviewCard.latestConclusion
  - zh="有条件通过" en="Conditionally Accepted" ja="条件付き承認" （已迁移）
      backend : tools.reviewDocument.values.overallDecision.conditionallyAccepted
      frontend: components.message.tool.reviewCard.decisionConditionallyAccepted
  - zh="未知错误" en="Unknown error" ja="不明なエラー" （已迁移）
      backend : errors.unknown, modules.api.chat.errors.unknownError
      frontend: common.unknownError, components.settings.dependencySettings.progress.unknownError, errors.unknown, stores.chatStore.errors.unknownError
  - zh="正在连接..." en="Connecting..." ja="接続中..." （已迁移）
      backend : modules.mcp.status.connecting
      frontend: components.settings.mcpSettings.serverCard.connecting, components.settings.mcpSettings.status.connecting
  - zh="此次修改删除了 {deletePercent}% 的文件内容（{deletedLines}/{totalLines} 行），超过 {threshold}% 的警戒阈值，请仔细检查" en="This change deletes {deletePercent}% of the file content ({deletedLines}/{totalLines} lines), exceeding the {threshold}% guard threshold. Please review carefully." ja="この変更はファイルの {deletePercent}% のコンテンツ（{deletedLines}/{totalLines} 行）を削除し、{threshold}% のガード閾値を超えています。慎重に確認してください。" （已迁移）
      backend : tools.file.diffManager.diffGuardWarning
      frontend: components.settings.toolSettings.files.applyDiff.diffGuardWarning
  - zh="每个模式只能选择一种组装方式：传统模板或预设条目。" en="Each mode can only use one assembly method: legacy template or preset entries." ja="各モードで選択できる組み立て方式は 1 つだけです：従来テンプレートまたはプリセットエントリ。" （已迁移）
      backend : webview.promptSettings.assemblyMode.description
      frontend: components.settings.promptSettings.assemblyMode.description
  - zh="测试" en="Test" ja="テスト" （已迁移）
      backend : tools.reviewDocument.values.category.test
      frontend: components.message.tool.reviewCard.categoryTest
  - zh="添加模型失败" en="Failed to add models" ja="モデルの追加に失敗しました" （已迁移）
      backend : modules.api.models.errors.addModelsFailed, webview.errors.addModelsFailed
      frontend: components.settings.modelManager.errors.addFailed
  - zh="状态" en="Status" ja="状態" （已迁移）
      backend : tools.reviewDocument.header.status, tools.reviewDocument.milestone.status
      frontend: common.status, components.message.responseViewer.status, components.message.tool.progressCard.status, components.message.tool.reviewCard.status
  - zh="生成计划" en="Generate Plan" ja="計画を生成" （已迁移）
      backend : notifications.windowsAgentStop.actionLabels.generatePlan
      frontend: app.agentStopNotification.actions.generatePlan, components.message.tool.designCard.generatePlan, components.message.tool.reviewCard.generatePlan
  - zh="相关里程碑" en="Related Milestones" ja="関連マイルストーン" （已迁移）
      backend : tools.reviewDocument.finding.relatedMilestones
      frontend: components.message.tool.reviewCard.changeRelatedMilestoneIds
  - zh="确认" en="Confirm" ja="確認" （已迁移）
      backend : notifications.windowsAgentStop.actionLabels.genericConfirmation
      frontend: common.confirm, components.common.confirmDialog.confirm, components.common.confirmDialog.title, components.settings.channelSettings.dialog.delete.confirm, components.settings.channelSettings.selector.confirm
  - zh="移除模型失败" en="Failed to remove model" ja="モデルの削除に失敗しました" （已迁移）
      backend : modules.api.models.errors.removeModelFailed, webview.errors.removeModelFailed
      frontend: components.settings.modelManager.errors.removeFailed
  - zh="等会变化变量时，此设置决定旧回合快照是否保留。" en="or other changing variables, this setting determines whether old-turn snapshots are preserved." ja="などの変化する変数が含まれる場合、この設定は古いターンのスナップショットを保持するかどうかを決定します。" （已迁移）
      backend : webview.promptSettings.dynamicSection.strategyVarsSuffix
      frontend: components.settings.promptSettings.dynamicSection.strategyVarsSuffix
  - zh="终止终端失败" en="Failed to kill terminal" ja="ターミナルの終了に失敗しました" （已迁移）
      backend : webview.errors.killTerminalFailed
      frontend: stores.terminalStore.errors.killTerminalFailed
  - zh="结论" en="Conclusion" ja="結論" （已迁移）
      backend : tools.reviewDocument.milestone.conclusion
      frontend: components.message.tool.reviewCard.decision
  - zh="继续" en="Continue" ja="続行" （已迁移）
      backend : notifications.windowsAgentStop.actionLabels.continue
      frontend: app.agentStopNotification.actions.continue, common.resume, components.message.continue.button, components.subagents.monitor.resume
  - zh="设置激活模型失败" en="Failed to set active model" ja="アクティブモデルの設定に失敗しました" （已迁移）
      backend : modules.api.models.errors.setActiveModelFailed, webview.errors.setActiveModelFailed
      frontend: components.settings.modelManager.errors.setActiveFailed
  - zh="证据" en="Evidence" ja="証拠" （已迁移）
      backend : tools.reviewDocument.finding.evidenceFiles, tools.reviewDocument.milestone.evidenceFiles
      frontend: components.message.tool.reviewCard.changeEvidence, components.message.tool.reviewCard.evidence
  - zh="该存档创建时按当时的排除规则排除了 {count} 个文件" en="This checkpoint excluded {count} file(s) under the exclusion rules in effect when it was created" ja="このチェックポイントは作成時の除外ルールで {count} 個のファイルを除外しました" （已迁移）
      backend : modules.checkpoint.restore.excludedNote
      frontend: components.settings.checkpoint.sections.cleanup.manifestNote
  - zh="说明" en="Description" ja="説明" （已迁移）
      backend : tools.reviewDocument.finding.description
      frontend: common.description, components.message.tool.reviewCard.changeDescription, components.settings.mcpSettings.form.description, components.settings.subagents.description
  - zh="读取文件失败" en="Failed to read file" ja="ファイルの読み取りに失敗しました" 
      backend : webview.errors.readFileFailed
      frontend: components.input.promptContext.readFailed, composables.useAttachments.errors.readFileFailed, utils.file.readFailed
  - zh="跟踪状态" en="Tracking Status" ja="追跡状態" （已迁移）
      backend : tools.reviewDocument.finding.trackingStatus
      frontend: components.message.tool.reviewCard.changeTrackingStatus, components.message.tool.reviewCard.tracking
  - zh="进行中" en="In Progress" ja="進行中" （已迁移）
      backend : tools.reviewDocument.values.milestoneStatus.inProgress
      frontend: components.message.tool.progressCard.milestoneStatusInProgress, components.message.tool.progressCard.statusActive, components.message.tool.reviewCard.statusInProgress, components.message.tool.todoPanel.statusInProgress
  - zh="通过" en="Accepted" ja="承認" （已迁移）
      backend : tools.reviewDocument.values.overallDecision.accepted
      frontend: components.message.tool.reviewCard.decisionAccepted
  - zh="重复" en="Duplicate" ja="重複" （已迁移）
      backend : tools.reviewDocument.values.trackingStatus.duplicate
      frontend: components.message.tool.reviewCard.trackingDuplicate
  - zh="错误" en="Error" ja="エラー" （已迁移）
      backend : modules.mcp.status.error
      frontend: common.error, components.message.tool.error, components.message.tool.progressCard.issueError, components.message.tool.reviewCard.issueError, components.settings.contextSettings.diagnostics.severity.error, components.settings.mcp.error, components.settings.toolSettings.common.error, components.tools.error, components.tools.media.cropImagePanel.status.error, components.tools.media.generateImagePanel.status.error, components.tools.media.removeBackgroundPanel.status.error, components.tools.media.resizeImagePanel.status.error, components.tools.media.rotateImagePanel.status.error
  - zh="问题" en="Findings" ja="問題" （已迁移）
      backend : tools.reviewDocument.milestone.findings
      frontend: components.message.tool.reviewCard.findings
  - zh="隐藏" en="Hide" ja="非表示" 
      backend : tools.common.hide
      frontend: common.hide, components.settings.channelSettings.form.apiKey.hide, components.settings.generateImageSettings.api.hide
  - zh="预设条目" en="Preset entries" ja="プリセットエントリ" （已迁移）
      backend : webview.promptSettings.assemblyMode.entriesLabel
      frontend: components.settings.promptSettings.assemblyMode.entriesLabel
  - zh="高" en="High" ja="高" （已迁移）
      backend : tools.reviewDocument.values.severity.high
      frontend: components.channels.gemini.thinking.levelHigh, components.channels.openai.thinking.effortHigh, components.message.tool.reviewCard.severityHigh

【4】仅空白差异的相似词条（归一化后相同，原文不同）
  共 184 对
  - backend "modules.mcp.errors.invalidServerId"
    frontend "components.settings.mcpSettings.form.serverIdError"
  - backend "modules.mcp.status.connecting"
    frontend "components.settings.mcpSettings.serverCard.connecting"
  - backend "modules.mcp.status.connecting"
    frontend "components.settings.mcpSettings.status.connecting"
  - backend "modules.mcp.status.connected"
    frontend "components.settings.mcp.connected"
  - backend "modules.mcp.status.connected"
    frontend "components.settings.mcpSettings.status.connected"
  - backend "modules.mcp.status.disconnected"
    frontend "components.settings.mcp.disconnected"
  - backend "modules.mcp.status.error"
    frontend "common.error"
  - backend "modules.mcp.status.error"
    frontend "components.message.tool.error"
  - backend "modules.mcp.status.error"
    frontend "components.message.tool.reviewCard.issueError"
  - backend "modules.mcp.status.error"
    frontend "components.message.tool.progressCard.issueError"
  - backend "modules.mcp.status.error"
    frontend "components.settings.mcp.error"
  - backend "modules.mcp.status.error"
    frontend "components.settings.contextSettings.diagnostics.severity.error"
  - backend "modules.mcp.status.error"
    frontend "components.settings.toolSettings.common.error"
  - backend "modules.mcp.status.error"
    frontend "components.tools.error"
  - backend "modules.mcp.status.error"
    frontend "components.tools.media.cropImagePanel.status.error"
  - backend "modules.mcp.status.error"
    frontend "components.tools.media.generateImagePanel.status.error"
  - backend "modules.mcp.status.error"
    frontend "components.tools.media.removeBackgroundPanel.status.error"
  - backend "modules.mcp.status.error"
    frontend "components.tools.media.resizeImagePanel.status.error"
  - backend "modules.mcp.status.error"
    frontend "components.tools.media.rotateImagePanel.status.error"
  - backend "modules.checkpoint.description.before"
    frontend "components.settings.checkpoint.sections.tools.beforeLabel"
  - backend "modules.checkpoint.description.before"
    frontend "components.settings.checkpoint.sections.cleanup.phaseBefore"
  - backend "modules.checkpoint.description.after"
    frontend "components.settings.checkpoint.sections.tools.afterLabel"
  - backend "modules.checkpoint.description.after"
    frontend "components.settings.checkpoint.sections.cleanup.phaseAfter"
  - backend "modules.checkpoint.restore.excludedNote"
    frontend "components.settings.checkpoint.sections.cleanup.manifestNote"
  - backend "modules.checkpoint.errors.restoreFailed"
    frontend "components.message.checkpoint.restoreResultFailed"
  - backend "modules.checkpoint.errors.restoreFailed"
    frontend "stores.chatStore.errors.restoreCheckpointFailed"
  - backend "webview.errors.restoreCheckpointFailed"
    frontend "components.message.checkpoint.restoreResultFailed"
  - backend "webview.errors.restoreCheckpointFailed"
    frontend "stores.chatStore.errors.restoreCheckpointFailed"
  - backend "modules.dependencies.progress.installSuccess"
    frontend "components.settings.dependencySettings.progress.installSuccess"
  - backend "modules.api.models.errors.addModelsFailed"
    frontend "components.settings.modelManager.errors.addFailed"
  - backend "webview.errors.addModelsFailed"
    frontend "components.settings.modelManager.errors.addFailed"
  - backend "modules.api.models.errors.removeModelFailed"
    frontend "components.settings.modelManager.errors.removeFailed"
  - backend "webview.errors.removeModelFailed"
    frontend "components.settings.modelManager.errors.removeFailed"
  - backend "modules.api.models.errors.setActiveModelFailed"
    frontend "components.settings.modelManager.errors.setActiveFailed"
  - backend "webview.errors.setActiveModelFailed"
    frontend "components.settings.modelManager.errors.setActiveFailed"
  - backend "modules.api.chat.errors.unknownError"
    frontend "common.unknownError"
  - backend "modules.api.chat.errors.unknownError"
    frontend "components.settings.dependencySettings.progress.unknownError"
  - backend "modules.api.chat.errors.unknownError"
    frontend "errors.unknown"
  - backend "modules.api.chat.errors.unknownError"
    frontend "stores.chatStore.errors.unknownError"
  - backend "errors.unknown"
    frontend "common.unknownError"
  - backend "errors.unknown"
    frontend "components.settings.dependencySettings.progress.unknownError"
  - backend "errors.unknown"
    frontend "errors.unknown"
  - backend "errors.unknown"
    frontend "stores.chatStore.errors.unknownError"
  - backend "tools.errors.timeout"
    frontend "components.settings.toolSettings.terminal.executeCommand.execTimeout"
  - backend "tools.file.diffManager.diffGuardWarning"
    frontend "components.settings.toolSettings.files.applyDiff.diffGuardWarning"
  - backend "tools.file.diffCodeLens.reject"
    frontend "components.message.tool.reject"
  - backend "tools.file.diffCodeLens.reject"
    frontend "components.tools.reject"
  - backend "tools.file.diffCodeLens.rejectAll"
    frontend "components.message.tool.rejectAll"
  - backend "tools.common.show"
    frontend "common.show"
  - backend "tools.common.show"
    frontend "components.settings.channelSettings.form.apiKey.show"
  - backend "tools.common.show"
    frontend "components.settings.generateImageSettings.api.show"
  - backend "tools.common.hide"
    frontend "common.hide"
  - backend "tools.common.hide"
    frontend "components.settings.channelSettings.form.apiKey.hide"
  - backend "tools.common.hide"
    frontend "components.settings.generateImageSettings.api.hide"
  - backend "tools.common.hide"
    frontend "components.channels.anthropic.thinking.displayOmitted"
  - backend "tools.reviewDocument.header.date"
    frontend "common.date"
  - backend "tools.reviewDocument.header.status"
    frontend "common.status"
  - backend "tools.reviewDocument.header.status"
    frontend "components.message.responseViewer.status"
  - backend "tools.reviewDocument.header.status"
    frontend "components.message.tool.reviewCard.status"
  - backend "tools.reviewDocument.header.status"
    frontend "components.message.tool.progressCard.status"
  - backend "tools.reviewDocument.milestone.status"
    frontend "common.status"
  - backend "tools.reviewDocument.milestone.status"
    frontend "components.message.responseViewer.status"
  - backend "tools.reviewDocument.milestone.status"
    frontend "components.message.tool.reviewCard.status"
  - backend "tools.reviewDocument.milestone.status"
    frontend "components.message.tool.progressCard.status"
  - backend "tools.reviewDocument.summary.reviewedModules"
    frontend "components.message.tool.reviewCard.modules"
  - backend "tools.reviewDocument.milestone.reviewedModules"
    frontend "components.message.tool.reviewCard.modules"
  - backend "tools.reviewDocument.summary.currentProgress"
    frontend "components.message.tool.progressCard.currentProgress"
  - backend "tools.reviewDocument.summary.latestConclusion"
    frontend "components.message.tool.reviewCard.latestConclusion"
  - backend "tools.reviewDocument.summary.latestConclusion"
    frontend "components.message.tool.progressCard.latestConclusion"
  - backend "tools.reviewDocument.summary.recommendedNextAction"
    frontend "components.message.tool.reviewCard.recommendedNextAction"
  - backend "tools.reviewDocument.milestone.recommendedNextAction"
    frontend "components.message.tool.reviewCard.recommendedNextAction"
  - backend "tools.reviewDocument.finding.severity"
    frontend "components.message.tool.reviewCard.changeSeverity"
  - backend "tools.reviewDocument.finding.trackingStatus"
    frontend "components.message.tool.reviewCard.changeTrackingStatus"
  - backend "tools.reviewDocument.finding.trackingStatus"
    frontend "components.message.tool.reviewCard.tracking"
  - backend "tools.reviewDocument.finding.description"
    frontend "common.description"
  - backend "tools.reviewDocument.finding.description"
    frontend "components.message.tool.reviewCard.changeDescription"
  - backend "tools.reviewDocument.finding.description"
    frontend "components.settings.mcpSettings.form.description"
  - backend "tools.reviewDocument.finding.description"
    frontend "components.settings.subagents.description"
  - backend "tools.reviewDocument.finding.recommendation"
    frontend "components.message.tool.reviewCard.changeRecommendation"
  - backend "tools.reviewDocument.finding.relatedMilestones"
    frontend "components.message.tool.reviewCard.changeRelatedMilestoneIds"
  - backend "tools.reviewDocument.finding.evidenceFiles"
    frontend "components.message.tool.reviewCard.changeEvidence"
  - backend "tools.reviewDocument.finding.evidenceFiles"
    frontend "components.message.tool.reviewCard.evidence"
  - backend "tools.reviewDocument.milestone.evidenceFiles"
    frontend "components.message.tool.reviewCard.changeEvidence"
  - backend "tools.reviewDocument.milestone.evidenceFiles"
    frontend "components.message.tool.reviewCard.evidence"
  - backend "tools.reviewDocument.milestone.summary"
    frontend "components.channels.anthropic.thinking.displaySummarized"
  - backend "tools.reviewDocument.milestone.conclusion"
    frontend "components.message.tool.reviewCard.decision"
  - backend "tools.reviewDocument.milestone.findings"
    frontend "components.message.tool.reviewCard.findings"
  - backend "tools.reviewDocument.values.milestoneStatus.inProgress"
    frontend "components.message.tool.todoPanel.statusInProgress"
  - backend "tools.reviewDocument.values.milestoneStatus.inProgress"
    frontend "components.message.tool.reviewCard.statusInProgress"
  - backend "tools.reviewDocument.values.milestoneStatus.inProgress"
    frontend "components.message.tool.progressCard.milestoneStatusInProgress"
  - backend "tools.reviewDocument.values.milestoneStatus.inProgress"
    frontend "components.message.tool.progressCard.statusActive"
  - backend "tools.reviewDocument.values.milestoneStatus.completed"
    frontend "common.completed"
  - backend "tools.reviewDocument.values.milestoneStatus.completed"
    frontend "components.message.tool.todoPanel.statusCompleted"
  - backend "tools.reviewDocument.values.milestoneStatus.completed"
    frontend "components.message.tool.reviewCard.statusCompleted"
  - backend "tools.reviewDocument.values.milestoneStatus.completed"
    frontend "components.message.tool.progressCard.milestoneStatusCompleted"
  - backend "tools.reviewDocument.values.milestoneStatus.completed"
    frontend "components.message.tool.progressCard.statusCompleted"
  - backend "tools.reviewDocument.values.milestoneStatus.completed"
    frontend "components.backgroundTasks.completed"
  - backend "tools.reviewDocument.values.milestoneStatus.completed"
    frontend "components.subagents.monitor.status.completed"
  - backend "tools.reviewDocument.values.milestoneStatus.completed"
    frontend "components.tools.subagents.completed"
  - backend "tools.reviewDocument.values.overallDecision.accepted"
    frontend "components.message.tool.reviewCard.decisionAccepted"
  - backend "tools.reviewDocument.values.overallDecision.conditionallyAccepted"
    frontend "components.message.tool.reviewCard.decisionConditionallyAccepted"
  - backend "tools.reviewDocument.values.overallDecision.rejected"
    frontend "components.message.tool.reviewCard.decisionRejected"
  - backend "tools.reviewDocument.values.severity.high"
    frontend "components.message.tool.reviewCard.severityHigh"
  - backend "tools.reviewDocument.values.severity.high"
    frontend "components.channels.gemini.thinking.levelHigh"
  - backend "tools.reviewDocument.values.severity.high"
    frontend "components.channels.openai.thinking.effortHigh"
  - backend "tools.reviewDocument.values.severity.medium"
    frontend "components.message.tool.reviewCard.severityMedium"
  - backend "tools.reviewDocument.values.severity.medium"
    frontend "components.channels.anthropic.thinking.effortMedium"
  - backend "tools.reviewDocument.values.severity.medium"
    frontend "components.channels.gemini.thinking.levelMedium"
  - backend "tools.reviewDocument.values.severity.medium"
    frontend "components.channels.openai.thinking.effortMedium"
  - backend "tools.reviewDocument.values.severity.low"
    frontend "components.message.tool.reviewCard.severityLow"
  - backend "tools.reviewDocument.values.severity.low"
    frontend "components.channels.anthropic.thinking.effortLow"
  - backend "tools.reviewDocument.values.severity.low"
    frontend "components.channels.gemini.thinking.levelLow"
  - backend "tools.reviewDocument.values.severity.low"
    frontend "components.channels.openai.thinking.effortLow"
  - backend "tools.reviewDocument.values.category.html"
    frontend "components.message.tool.reviewCard.categoryHtml"
  - backend "tools.reviewDocument.values.category.css"
    frontend "components.message.tool.reviewCard.categoryCss"
  - backend "tools.reviewDocument.values.category.javascript"
    frontend "components.message.tool.reviewCard.categoryJavascript"
  - backend "tools.reviewDocument.values.category.accessibility"
    frontend "components.message.tool.reviewCard.categoryAccessibility"
  - backend "tools.reviewDocument.values.category.performance"
    frontend "components.message.tool.reviewCard.categoryPerformance"
  - backend "tools.reviewDocument.values.category.maintainability"
    frontend "components.message.tool.reviewCard.categoryMaintainability"
  - backend "tools.reviewDocument.values.category.docs"
    frontend "components.message.tool.reviewCard.categoryDocs"
  - backend "tools.reviewDocument.values.category.docs"
    frontend "components.settings.channelSettings.form.multimodal.document"
  - backend "tools.reviewDocument.values.category.test"
    frontend "components.message.tool.reviewCard.categoryTest"
  - backend "tools.reviewDocument.values.category.other"
    frontend "components.message.tool.reviewCard.categoryOther"
  - backend "tools.reviewDocument.values.category.other"
    frontend "components.settings.autoExec.categories.other"
  - backend "tools.reviewDocument.values.category.other"
    frontend "components.settings.toolsSettings.categories.other"
  - backend "tools.reviewDocument.values.trackingStatus.open"
    frontend "components.message.tool.reviewCard.trackingOpen"
  - backend "tools.reviewDocument.values.trackingStatus.acceptedRisk"
    frontend "components.message.tool.reviewCard.trackingAcceptedRisk"
  - backend "tools.reviewDocument.values.trackingStatus.fixed"
    frontend "components.message.tool.reviewCard.trackingFixed"
  - backend "tools.reviewDocument.values.trackingStatus.wontFix"
    frontend "components.message.tool.reviewCard.trackingWontFix"
  - backend "tools.reviewDocument.values.trackingStatus.duplicate"
    frontend "components.message.tool.reviewCard.trackingDuplicate"
  - backend "notifications.windowsAgentStop.reasonLabels.error"
    frontend "common.failed"
  - backend "notifications.windowsAgentStop.reasonLabels.error"
    frontend "components.message.responseViewer.toolStatuses.error"
  - backend "notifications.windowsAgentStop.reasonLabels.error"
    frontend "components.settings.checkpoint.sections.cleanup.progress.failed"
  - backend "notifications.windowsAgentStop.reasonLabels.error"
    frontend "components.backgroundTasks.failed"
  - backend "notifications.windowsAgentStop.reasonLabels.error"
    frontend "components.subagents.monitor.status.failed"
  - backend "notifications.windowsAgentStop.reasonLabels.error"
    frontend "components.tools.file.createDirectoryPanel.failed"
  - backend "notifications.windowsAgentStop.reasonLabels.error"
    frontend "components.tools.file.deleteFilePanel.failed"
  - backend "notifications.windowsAgentStop.reasonLabels.error"
    frontend "components.tools.media.cropImagePanel.status.failed"
  - backend "notifications.windowsAgentStop.reasonLabels.error"
    frontend "components.tools.media.generateImagePanel.status.failed"
  - backend "notifications.windowsAgentStop.reasonLabels.error"
    frontend "components.tools.media.removeBackgroundPanel.status.failed"
  - backend "notifications.windowsAgentStop.reasonLabels.error"
    frontend "components.tools.media.resizeImagePanel.status.failed"
  - backend "notifications.windowsAgentStop.reasonLabels.error"
    frontend "components.tools.media.rotateImagePanel.status.failed"
  - backend "notifications.windowsAgentStop.reasonLabels.error"
    frontend "components.tools.terminal.executeCommandPanel.status.failed"
  - backend "notifications.windowsAgentStop.actionLabels.generatePlan"
    frontend "components.message.tool.designCard.generatePlan"
  - backend "notifications.windowsAgentStop.actionLabels.generatePlan"
    frontend "components.message.tool.reviewCard.generatePlan"
  - backend "notifications.windowsAgentStop.actionLabels.generatePlan"
    frontend "app.agentStopNotification.actions.generatePlan"
  - backend "notifications.windowsAgentStop.actionLabels.executePlan"
    frontend "components.message.tool.planCard.executePlan"
  - backend "notifications.windowsAgentStop.actionLabels.executePlan"
    frontend "app.agentStopNotification.actions.executePlan"
  - backend "notifications.windowsAgentStop.actionLabels.continue"
    frontend "common.resume"
  - backend "notifications.windowsAgentStop.actionLabels.continue"
    frontend "components.message.continue.button"
  - backend "notifications.windowsAgentStop.actionLabels.continue"
    frontend "components.subagents.monitor.resume"
  - backend "notifications.windowsAgentStop.actionLabels.continue"
    frontend "app.agentStopNotification.actions.continue"
  - backend "notifications.windowsAgentStop.actionLabels.genericConfirmation"
    frontend "common.confirm"
  - backend "notifications.windowsAgentStop.actionLabels.genericConfirmation"
    frontend "components.common.confirmDialog.title"
  - backend "notifications.windowsAgentStop.actionLabels.genericConfirmation"
    frontend "components.common.confirmDialog.confirm"
  - backend "notifications.windowsAgentStop.actionLabels.genericConfirmation"
    frontend "components.settings.channelSettings.selector.confirm"
  - backend "notifications.windowsAgentStop.actionLabels.genericConfirmation"
    frontend "components.settings.channelSettings.dialog.delete.confirm"
  - backend "webview.errors.fileNotExists"
    frontend "components.input.fileNotExists"
  - backend "webview.errors.fileNotInAnyWorkspace"
    frontend "components.input.notifications.fileNotInAnyWorkspace"
  - backend "webview.errors.fileInOtherWorkspace"
    frontend "components.input.notifications.fileInOtherWorkspace"
  - backend "webview.errors.readFileFailed"
    frontend "components.input.promptContext.readFailed"
  - backend "webview.errors.readFileFailed"
    frontend "composables.useAttachments.errors.readFileFailed"
  - backend "webview.errors.readFileFailed"
    frontend "utils.file.readFailed"
  - backend "webview.errors.killTerminalFailed"
    frontend "stores.terminalStore.errors.killTerminalFailed"
  - backend "webview.errors.openDiffPreviewFailed"
    frontend "components.message.tool.openDiffFailed"
  - backend "webview.errors.openFileFailed"
    frontend "components.common.markdown.openFileFailed"
  - backend "webview.errors.openFileFailed"
    frontend "components.message.tool.planCard.openFileFailed"
  - backend "webview.errors.openFileFailed"
    frontend "components.message.tool.designCard.openFileFailed"
  - backend "webview.promptSettings.dynamicSection.strategyTitle"
    frontend "components.settings.promptSettings.dynamicSection.strategyTitle"
  - backend "webview.promptSettings.dynamicSection.strategySingle"
    frontend "components.settings.promptSettings.dynamicSection.strategySingle"
  - backend "webview.promptSettings.dynamicSection.strategyPreserve"
    frontend "components.settings.promptSettings.dynamicSection.strategyPreserve"
  - backend "webview.promptSettings.dynamicSection.strategyDescription"
    frontend "components.settings.promptSettings.dynamicSection.strategyDescription"
  - backend "webview.promptSettings.dynamicSection.strategyPreserveWarning"
    frontend "components.settings.promptSettings.dynamicSection.strategyPreserveWarning"
  - backend "webview.promptSettings.dynamicSection.strategyVarsPrefix"
    frontend "components.settings.promptSettings.dynamicSection.strategyVarsPrefix"
  - backend "webview.promptSettings.dynamicSection.strategyVarsSeparator"
    frontend "components.settings.promptSettings.dynamicSection.strategyVarsSeparator"
  - backend "webview.promptSettings.dynamicSection.strategyVarsSuffix"
    frontend "components.settings.promptSettings.dynamicSection.strategyVarsSuffix"
  - backend "webview.promptSettings.dynamicSection.strategyVarsWarning"
    frontend "components.settings.promptSettings.dynamicSection.strategyVarsWarning"
  - backend "webview.promptSettings.assemblyMode.title"
    frontend "components.settings.promptSettings.assemblyMode.title"
  - backend "webview.promptSettings.assemblyMode.description"
    frontend "components.settings.promptSettings.assemblyMode.description"
  - backend "webview.promptSettings.assemblyMode.legacyLabel"
    frontend "components.settings.promptSettings.assemblyMode.legacyLabel"
  - backend "webview.promptSettings.assemblyMode.legacyDescription"
    frontend "components.settings.promptSettings.assemblyMode.legacyDescription"
  - backend "webview.promptSettings.assemblyMode.entriesLabel"
    frontend "components.settings.promptSettings.assemblyMode.entriesLabel"
  - backend "webview.promptSettings.assemblyMode.entriesDescription"
    frontend "components.settings.promptSettings.assemblyMode.entriesDescription"
  - backend "errors.cancelled"
    frontend "errors.cancelled"

【5】只有一端有的词条（按 zh 译文统计）
  backend 独有: 402 条（frontend 无同译文）
    - "配置不存在: {configId}" <- modules.api.chat.errors.configNotFound, modules.channel.errors.configNotFound, modules.config.errors.configNotFound
    - "配置已存在: {configId}，使用 overwrite 选项覆盖" <- modules.config.errors.configExists
    - "无效的配置" <- modules.config.errors.invalidConfig
    - "配置验证失败: {errors}" <- modules.config.errors.validationFailed
    - "保存配置失败" <- modules.config.errors.saveFailed
    - "加载配置失败" <- modules.config.errors.loadFailed
    - "名称不能为空" <- modules.config.validation.nameRequired
    - "类型不能为空" <- modules.config.validation.typeRequired
    - "API URL 无效" <- modules.config.validation.invalidUrl
    - "API Key 为空，需要配置后才能使用" <- modules.config.validation.apiKeyEmpty
    - "有可用模型但未选择当前使用的模型" <- modules.config.validation.modelNotSelected
    - "temperature 必须在 0.0 - 2.0 之间" <- modules.config.validation.temperatureRange
    - "maxOutputTokens 必须大于 0" <- modules.config.validation.maxOutputTokensMin
    - "maxOutputTokens 过大，可能导致高延迟" <- modules.config.validation.maxOutputTokensHigh
    - "temperature 必须在 0.0 - 1.0 之间（Anthropic）" <- modules.config.validation.temperatureRangeAnthropic
    ...（其余 387 条略）
  frontend 独有: 2121 条（backend 无同译文）
    - "保存" <- common.save, components.common.editDialog.save, components.message.branchTree.save, components.settings.checkpoint.sections.branchCleanup.retention.save, components.settings.checkpoint.sections.exclusion.profilePatterns.save, components.settings.mcpSettings.form.save, components.settings.settingsPanel.proxy.save, components.tools.media.cropImagePanel.save, components.tools.media.generateImagePanel.save, components.tools.media.removeBackgroundPanel.save, components.tools.media.resizeImagePanel.save, components.tools.media.rotateImagePanel.save, components.usage.save
    - "取消" <- common.cancel, components.common.confirmDialog.cancel, components.common.deleteDialog.cancel, components.common.editDialog.cancel, components.common.inputDialog.cancel, components.common.retryDialog.cancel, components.message.branch.workspaceConfirmCancel, components.message.branchTree.cancel, components.message.checkpoint.dirtyConfirmCancel, components.message.tool.todoPanel.statusCancelled, components.settings.channelSettings.dialog.delete.cancel, components.settings.channelSettings.dialog.new.cancel, components.settings.channelSettings.selector.cancel, components.settings.checkpoint.sections.cleanup.confirmDelete.cancel, components.settings.checkpoint.sections.cleanup.progress.cancel, components.settings.checkpoint.sections.exclusion.profilePatterns.cancel, components.settings.mcpSettings.delete.cancel, components.settings.mcpSettings.form.cancel, components.settings.modelManager.clearDialog.cancel, components.settings.modelSelectionDialog.cancel, components.settings.storageSettings.dialog.cancel, components.usage.cancel
    - "删除" <- common.delete, components.channels.customBody.deleteTooltip, components.channels.customHeaders.deleteTooltip, components.common.deleteDialog.delete, components.settings.checkpoint.sections.cleanup.confirmDelete.delete, components.settings.mcpSettings.delete.confirm, components.settings.mcpSettings.serverCard.delete, components.settings.subagents.delete, components.settings.toolSettings.files.listFiles.deleteTooltip, components.settings.toolSettings.search.findFiles.deleteTooltip, components.settings.toolSettings.search.searchInFiles.deleteTooltip, components.tools.file.applyDiffPanel.deletedLines
    - "编辑" <- common.edit, components.input.queue.edit, components.settings.mcpSettings.serverCard.edit
    - "添加" <- common.add, components.settings.checkpoint.sections.exclusion.patternsAdd, components.settings.contextSettings.ignorePatterns.addButton, components.settings.modelManager.addTooltip, components.settings.toolSettings.files.listFiles.addButton, components.settings.toolSettings.search.findFiles.addButton, components.settings.toolSettings.search.searchInFiles.addButton
    - "移除" <- common.remove, components.input.queue.remove, components.input.remove, components.settings.contextSettings.ignorePatterns.removeTooltip, components.settings.modelManager.removeTooltip
    - "启用" <- common.enable, components.settings.mcpSettings.form.enabled, components.settings.soundSettings.enabled.label
    - "禁用" <- common.disable
    - "已启用" <- common.enabled, components.channels.customBody.enabled, components.channels.customHeaders.enabled
    - "已禁用" <- common.disabled, components.channels.customBody.disabled, components.channels.customHeaders.disabled, components.settings.promptSettings.toolPolicy.disabledBadge, components.settings.subagents.disabled, components.tools.media.removeBackgroundPanel.status.disabled
    - "加载中..." <- common.loading, components.input.pinnedFilesPanel.loading, components.input.skillsPanel.loading, components.settings.checkpoint.sections.cleanup.loading, components.settings.contextSettings.loading, components.settings.mcpSettings.loading, components.settings.modelSelectionDialog.loading, components.settings.promptSettings.loading, components.settings.toolSettings.common.loading
    - "成功" <- common.success, components.message.responseViewer.toolStatuses.success, components.tools.file.createDirectoryPanel.success, components.tools.file.deleteFilePanel.success, components.tools.media.cropImagePanel.status.success, components.tools.media.generateImagePanel.status.success, components.tools.media.removeBackgroundPanel.status.success, components.tools.media.resizeImagePanel.status.success, components.tools.media.rotateImagePanel.status.success, components.tools.terminal.executeCommandPanel.status.success
    - "警告" <- common.warning, components.message.responseViewer.toolStatuses.warning, components.message.tool.progressCard.issueWarning, components.message.tool.reviewCard.issueWarning, components.settings.contextSettings.diagnostics.severity.warning
    - "信息" <- common.info, components.settings.contextSettings.diagnostics.severity.information
    - "关闭" <- common.close, components.attachment.close, components.common.modal.close, components.input.filePicker.close, components.message.branchTree.close, components.message.error.dismiss, components.settings.appearanceSettings.smoothStreaming.off, components.settings.checkpoint.sections.cleanup.manifestClose, components.settings.modelSelectionDialog.close
    ...（其余 2106 条略）

【6】共享映射 manifest 当前状态
  已登记映射: 160 条（A:\api\Gray-Code-main\scripts\i18n-shared-manifest.json）
    - components.message.tool.reviewCard.categoryCss <- tools.reviewDocument.values.category.css
    - components.message.tool.reviewCard.categoryHtml <- tools.reviewDocument.values.category.html
    - components.message.tool.reviewCard.categoryJavascript <- tools.reviewDocument.values.category.javascript
    - components.message.tool.reviewCard.categoryOther <- tools.reviewDocument.values.category.other
    - components.message.tool.reviewCard.categoryMaintainability <- tools.reviewDocument.values.category.maintainability
    - components.message.tool.reviewCard.categoryAccessibility <- tools.reviewDocument.values.category.accessibility
    - components.message.tool.reviewCard.categoryPerformance <- tools.reviewDocument.values.category.performance
    - components.message.tool.reviewCard.categoryDocs <- tools.reviewDocument.values.category.docs
    - components.message.tool.reviewCard.categoryTest <- tools.reviewDocument.values.category.test
    - components.message.tool.reviewCard.severityHigh <- tools.reviewDocument.values.severity.high
    - components.message.tool.reviewCard.severityMedium <- tools.reviewDocument.values.severity.medium
    - components.message.tool.reviewCard.severityLow <- tools.reviewDocument.values.severity.low
    - components.message.tool.reviewCard.changeSeverity <- tools.reviewDocument.finding.severity
    - components.message.tool.reviewCard.trackingWontFix <- tools.reviewDocument.values.trackingStatus.wontFix
    - components.message.tool.reviewCard.trackingFixed <- tools.reviewDocument.values.trackingStatus.fixed
    - components.message.tool.reviewCard.trackingOpen <- tools.reviewDocument.values.trackingStatus.open
    - components.message.tool.reviewCard.trackingAcceptedRisk <- tools.reviewDocument.values.trackingStatus.acceptedRisk
    - components.message.tool.reviewCard.trackingDuplicate <- tools.reviewDocument.values.trackingStatus.duplicate
    - components.message.tool.reviewCard.decisionRejected <- tools.reviewDocument.values.overallDecision.rejected
    - components.message.tool.reviewCard.decisionConditionallyAccepted <- tools.reviewDocument.values.overallDecision.conditionallyAccepted
    - components.message.tool.reviewCard.decisionAccepted <- tools.reviewDocument.values.overallDecision.accepted
    - components.message.tool.reviewCard.changeRecommendation <- tools.reviewDocument.finding.recommendation
    - components.message.tool.reviewCard.changeDescription <- tools.reviewDocument.finding.description
    - components.message.tool.reviewCard.changeEvidence <- tools.reviewDocument.finding.evidenceFiles
    - components.message.tool.reviewCard.evidence <- tools.reviewDocument.milestone.evidenceFiles
    - components.message.tool.reviewCard.status <- tools.reviewDocument.header.status
    - components.message.tool.reviewCard.statusInProgress <- tools.reviewDocument.values.milestoneStatus.inProgress
    - components.message.tool.rejectAll <- tools.file.diffCodeLens.rejectAll
    - components.message.tool.reject <- tools.file.diffCodeLens.reject
    - components.message.tool.openDiffFailed <- webview.errors.openDiffPreviewFailed
    - components.message.tool.designCard.openFileFailed <- webview.errors.openFileFailed
    - components.message.tool.planCard.openFileFailed <- webview.errors.openFileFailed
    - components.message.tool.progressCard.milestoneStatusCompleted <- tools.reviewDocument.values.milestoneStatus.completed
    - components.message.tool.progressCard.milestoneStatusInProgress <- tools.reviewDocument.values.milestoneStatus.inProgress
    - components.message.tool.progressCard.status <- tools.reviewDocument.milestone.status
    - components.message.tool.todoPanel.statusInProgress <- tools.reviewDocument.values.milestoneStatus.inProgress
    - components.message.checkpoint.restoreResultFailed <- modules.checkpoint.errors.restoreFailed
    - stores.chatStore.errors.restoreCheckpointFailed <- modules.checkpoint.errors.restoreFailed
    - components.settings.mcp.connected <- modules.mcp.status.connected
    - components.settings.mcp.disconnected <- modules.mcp.status.disconnected
    - components.settings.mcpSettings.form.serverIdError <- modules.mcp.errors.invalidServerId
    - components.settings.modelManager.errors.removeFailed <- modules.api.models.errors.removeModelFailed
    - components.settings.modelManager.errors.setActiveFailed <- modules.api.models.errors.setActiveModelFailed
    - components.settings.checkpoint.sections.cleanup.phaseBefore <- modules.checkpoint.description.before
    - components.settings.checkpoint.sections.cleanup.phaseAfter <- modules.checkpoint.description.after
    - components.settings.toolSettings.files.applyDiff.diffGuardWarning <- tools.file.diffManager.diffGuardWarning
    - errors.cancelled <- errors.cancelled
    - errors.unknown <- errors.unknown
    - common.date <- tools.reviewDocument.header.date
    - components.input.fileNotExists <- webview.errors.fileNotExists
    - components.input.notifications.fileNotInAnyWorkspace <- webview.errors.fileNotInAnyWorkspace
    - components.input.notifications.fileInOtherWorkspace <- webview.errors.fileInOtherWorkspace
    - components.input.promptContext.readFailed <- webview.errors.readFileFailed
    - app.agentStopNotification.actions.continue <- notifications.windowsAgentStop.actionLabels.continue
    - common.completed <- tools.reviewDocument.values.milestoneStatus.completed
    - components.backgroundTasks.completed <- tools.reviewDocument.values.milestoneStatus.completed
    - components.subagents.monitor.status.completed <- tools.reviewDocument.values.milestoneStatus.completed
    - components.message.tool.progressCard.statusCompleted <- tools.reviewDocument.values.milestoneStatus.completed
    - components.message.tool.reviewCard.statusCompleted <- tools.reviewDocument.values.milestoneStatus.completed
    - components.channels.gemini.thinking.levelHigh <- tools.reviewDocument.values.severity.high
    - components.channels.gemini.thinking.levelMedium <- tools.reviewDocument.values.severity.medium
    - components.channels.gemini.thinking.levelLow <- tools.reviewDocument.values.severity.low
    - components.channels.openai.thinking.effortHigh <- tools.reviewDocument.values.severity.high
    - components.channels.openai.thinking.effortMedium <- tools.reviewDocument.values.severity.medium
    - components.channels.openai.thinking.effortLow <- tools.reviewDocument.values.severity.low
    - components.settings.autoExec.categories.other <- tools.reviewDocument.values.category.other
    - components.settings.toolsSettings.categories.other <- tools.reviewDocument.values.category.other
    - components.message.responseViewer.status <- tools.reviewDocument.header.status
    - components.settings.mcpSettings.status.connected <- modules.mcp.status.connected
    - common.error <- modules.mcp.status.error
    - components.message.tool.error <- modules.mcp.status.error
    - components.message.tool.progressCard.issueError <- modules.mcp.status.error
    - components.message.tool.reviewCard.issueError <- modules.mcp.status.error
    - components.settings.contextSettings.diagnostics.severity.error <- modules.mcp.status.error
    - components.settings.mcp.error <- modules.mcp.status.error
    - components.settings.toolSettings.common.error <- modules.mcp.status.error
    - components.tools.error <- modules.mcp.status.error
    - components.tools.media.cropImagePanel.status.error <- modules.mcp.status.error
    - components.tools.media.generateImagePanel.status.error <- modules.mcp.status.error
    - components.tools.media.removeBackgroundPanel.status.error <- modules.mcp.status.error
    - components.tools.media.resizeImagePanel.status.error <- modules.mcp.status.error
    - components.tools.media.rotateImagePanel.status.error <- modules.mcp.status.error
    - components.settings.dependencySettings.progress.unknownError <- modules.api.chat.errors.unknownError
    - stores.chatStore.errors.unknownError <- modules.api.chat.errors.unknownError
    - common.confirm <- notifications.windowsAgentStop.actionLabels.genericConfirmation
    - components.common.confirmDialog.title <- notifications.windowsAgentStop.actionLabels.genericConfirmation
    - components.settings.channelSettings.selector.confirm <- notifications.windowsAgentStop.actionLabels.genericConfirmation
    - components.message.continue.button <- notifications.windowsAgentStop.actionLabels.continue
    - components.tools.reject <- tools.file.diffCodeLens.reject
    - composables.useAttachments.errors.readFileFailed <- webview.errors.readFileFailed
    - common.failed <- notifications.windowsAgentStop.reasonLabels.error
    - components.backgroundTasks.failed <- notifications.windowsAgentStop.reasonLabels.error
    - components.subagents.monitor.status.failed <- notifications.windowsAgentStop.reasonLabels.error
    - components.message.responseViewer.toolStatuses.error <- notifications.windowsAgentStop.reasonLabels.error
    - components.settings.checkpoint.sections.cleanup.progress.failed <- notifications.windowsAgentStop.reasonLabels.error
    - components.tools.file.createDirectoryPanel.failed <- notifications.windowsAgentStop.reasonLabels.error
    - components.tools.file.deleteFilePanel.failed <- notifications.windowsAgentStop.reasonLabels.error
    - components.tools.media.cropImagePanel.status.failed <- notifications.windowsAgentStop.reasonLabels.error
    - components.tools.media.generateImagePanel.status.failed <- notifications.windowsAgentStop.reasonLabels.error
    - components.tools.media.removeBackgroundPanel.status.failed <- notifications.windowsAgentStop.reasonLabels.error
    - components.tools.media.resizeImagePanel.status.failed <- notifications.windowsAgentStop.reasonLabels.error
    - components.tools.media.rotateImagePanel.status.failed <- notifications.windowsAgentStop.reasonLabels.error
    - components.tools.terminal.executeCommandPanel.status.failed <- notifications.windowsAgentStop.reasonLabels.error
    - common.resume <- notifications.windowsAgentStop.actionLabels.continue
    - components.subagents.monitor.resume <- notifications.windowsAgentStop.actionLabels.continue
    - common.status <- tools.reviewDocument.header.status
    - app.agentStopNotification.actions.generatePlan <- notifications.windowsAgentStop.actionLabels.generatePlan
    - components.message.tool.designCard.generatePlan <- notifications.windowsAgentStop.actionLabels.generatePlan
    - components.message.tool.reviewCard.generatePlan <- notifications.windowsAgentStop.actionLabels.generatePlan
    - app.agentStopNotification.actions.executePlan <- notifications.windowsAgentStop.actionLabels.executePlan
    - components.message.tool.planCard.executePlan <- notifications.windowsAgentStop.actionLabels.executePlan
    - components.channels.anthropic.thinking.displaySummarized <- tools.reviewDocument.milestone.summary
    - components.message.tool.progressCard.statusActive <- tools.reviewDocument.values.milestoneStatus.inProgress
    - components.message.tool.reviewCard.decision <- tools.reviewDocument.milestone.conclusion
    - components.message.tool.reviewCard.findings <- tools.reviewDocument.milestone.findings
    - components.settings.channelSettings.form.multimodal.document <- tools.reviewDocument.values.category.docs
    - components.settings.checkpoint.sections.cleanup.manifestNote <- modules.checkpoint.restore.excludedNote
    - components.settings.checkpoint.sections.tools.beforeLabel <- modules.checkpoint.description.before
    - components.settings.checkpoint.sections.tools.afterLabel <- modules.checkpoint.description.after
    - components.settings.dependencySettings.progress.installSuccess <- modules.dependencies.progress.installSuccess
    - components.settings.modelManager.errors.addFailed <- modules.api.models.errors.addModelsFailed
    - components.settings.toolSettings.terminal.executeCommand.execTimeout <- tools.errors.timeout
    - components.message.tool.progressCard.currentProgress <- tools.reviewDocument.summary.currentProgress
    - components.message.tool.progressCard.latestConclusion <- tools.reviewDocument.summary.latestConclusion
    - components.message.tool.reviewCard.latestConclusion <- tools.reviewDocument.summary.latestConclusion
    - components.message.tool.reviewCard.tracking <- tools.reviewDocument.finding.trackingStatus
    - components.message.tool.reviewCard.changeTrackingStatus <- tools.reviewDocument.finding.trackingStatus
    - components.message.tool.reviewCard.modules <- tools.reviewDocument.summary.reviewedModules
    - components.message.tool.reviewCard.recommendedNextAction <- tools.reviewDocument.summary.recommendedNextAction
    - components.message.tool.reviewCard.changeRelatedMilestoneIds <- tools.reviewDocument.finding.relatedMilestones
    - components.settings.mcpSettings.serverCard.connecting <- modules.mcp.status.connecting
    - components.settings.mcpSettings.status.connecting <- modules.mcp.status.connecting
    - common.description <- tools.reviewDocument.finding.description
    - components.settings.mcpSettings.form.description <- tools.reviewDocument.finding.description
    - components.settings.subagents.description <- tools.reviewDocument.finding.description
    - components.message.tool.todoPanel.statusCompleted <- tools.reviewDocument.values.milestoneStatus.completed
    - components.tools.subagents.completed <- tools.reviewDocument.values.milestoneStatus.completed
    - components.channels.anthropic.thinking.effortMedium <- tools.reviewDocument.values.severity.medium
    - components.channels.anthropic.thinking.effortLow <- tools.reviewDocument.values.severity.low
    - components.common.confirmDialog.confirm <- notifications.windowsAgentStop.actionLabels.genericConfirmation
    - components.settings.channelSettings.dialog.delete.confirm <- notifications.windowsAgentStop.actionLabels.genericConfirmation
    - stores.terminalStore.errors.killTerminalFailed <- webview.errors.killTerminalFailed
    - components.settings.promptSettings.dynamicSection.strategyTitle <- webview.promptSettings.dynamicSection.strategyTitle
    - components.settings.promptSettings.dynamicSection.strategySingle <- webview.promptSettings.dynamicSection.strategySingle
    - components.settings.promptSettings.dynamicSection.strategyPreserve <- webview.promptSettings.dynamicSection.strategyPreserve
    - components.settings.promptSettings.dynamicSection.strategyDescription <- webview.promptSettings.dynamicSection.strategyDescription
    - components.settings.promptSettings.dynamicSection.strategyPreserveWarning <- webview.promptSettings.dynamicSection.strategyPreserveWarning
    - components.settings.promptSettings.dynamicSection.strategyVarsPrefix <- webview.promptSettings.dynamicSection.strategyVarsPrefix
    - components.settings.promptSettings.dynamicSection.strategyVarsSeparator <- webview.promptSettings.dynamicSection.strategyVarsSeparator
    - components.settings.promptSettings.dynamicSection.strategyVarsSuffix <- webview.promptSettings.dynamicSection.strategyVarsSuffix
    - components.settings.promptSettings.dynamicSection.strategyVarsWarning <- webview.promptSettings.dynamicSection.strategyVarsWarning
    - components.settings.promptSettings.assemblyMode.title <- webview.promptSettings.assemblyMode.title
    - components.settings.promptSettings.assemblyMode.description <- webview.promptSettings.assemblyMode.description
    - components.settings.promptSettings.assemblyMode.legacyLabel <- webview.promptSettings.assemblyMode.legacyLabel
    - components.settings.promptSettings.assemblyMode.legacyDescription <- webview.promptSettings.assemblyMode.legacyDescription
    - components.settings.promptSettings.assemblyMode.entriesLabel <- webview.promptSettings.assemblyMode.entriesLabel
    - components.settings.promptSettings.assemblyMode.entriesDescription <- webview.promptSettings.assemblyMode.entriesDescription
    - common.hide <- tools.common.hide
    - common.show <- tools.common.show
    - common.unknownError <- modules.api.chat.errors.unknownError

