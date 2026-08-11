========================================================================
LimCode i18n 语言包盘点报告
========================================================================

【1】结构概览（叶子 key 数）

  backend（zh-CN / en / ja 叶子数: 482 / 482 / 482）
    - core: 7
    - modules: 202
    - tools: 141
    - notifications: 8
    - workspace: 4
    - multimodal: 4
    - webview: 110
    - errors: 6

  frontend（zh-CN / en / ja 叶子数: 2817 / 2817 / 2817）
    - common: 75
    - components: 2671
    - app: 19
    - errors: 13
    - composables: 6
    - stores: 26
    - utils: 7

【2】完全重复词条（zh 译文精确相同；key 不同，值相同）
  共 66 条 zh 译文在两端同时出现（已迁移 = 该译文对应的全部 frontend key 已登记到 manifest）
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
  - "{name} 安装成功！" 
      backend : modules.dependencies.progress.installSuccess
      frontend: components.settings.dependencySettings.progress.installSuccess
  - "下一步建议" 
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
  - "中" 
      backend : tools.reviewDocument.values.severity.medium
      frontend: components.channels.gemini.thinking.levelMedium, components.channels.openai.thinking.effortMedium, components.message.tool.reviewCard.severityMedium
  - "低" 
      backend : tools.reviewDocument.values.severity.low
      frontend: components.channels.gemini.thinking.levelLow, components.channels.openai.thinking.effortLow, components.message.tool.reviewCard.severityLow
  - "全部拒绝" （已迁移）
      backend : tools.file.diffCodeLens.rejectAll
      frontend: components.message.tool.rejectAll
  - "其他" 
      backend : tools.reviewDocument.values.category.other
      frontend: components.message.tool.reviewCard.categoryOther, components.settings.autoExec.categories.other, components.settings.toolsSettings.categories.other
  - "可维护性" （已迁移）
      backend : tools.reviewDocument.values.category.maintainability
      frontend: components.message.tool.reviewCard.categoryMaintainability
  - "可访问性" （已迁移）
      backend : tools.reviewDocument.values.category.accessibility
      frontend: components.message.tool.reviewCard.categoryAccessibility
  - "失败" 
      backend : notifications.windowsAgentStop.reasonLabels.error
      frontend: common.failed, components.backgroundTasks.failed, components.message.responseViewer.toolStatuses.error, components.settings.checkpoint.sections.cleanup.progress.failed, components.subagents.monitor.status.failed, components.tools.file.createDirectoryPanel.failed, components.tools.file.deleteFilePanel.failed, components.tools.media.cropImagePanel.status.failed, components.tools.media.generateImagePanel.status.failed, components.tools.media.removeBackgroundPanel.status.failed, components.tools.media.resizeImagePanel.status.failed, components.tools.media.rotateImagePanel.status.failed, components.tools.terminal.executeCommandPanel.status.failed
  - "已修复" （已迁移）
      backend : tools.reviewDocument.values.trackingStatus.fixed
      frontend: components.message.tool.reviewCard.trackingFixed
  - "已完成" 
      backend : tools.reviewDocument.values.milestoneStatus.completed
      frontend: common.completed, components.backgroundTasks.completed, components.message.tool.progressCard.milestoneStatusCompleted, components.message.tool.progressCard.statusCompleted, components.message.tool.reviewCard.statusCompleted, components.subagents.monitor.status.completed
  - "已审模块" 
      backend : tools.reviewDocument.milestone.reviewedModules, tools.reviewDocument.summary.reviewedModules
      frontend: components.message.tool.reviewCard.modules
  - "已断开" （已迁移）
      backend : modules.mcp.status.disconnected
      frontend: components.settings.mcp.disconnected
  - "已连接" 
      backend : modules.mcp.status.connected
      frontend: components.settings.mcp.connected, components.settings.mcpSettings.status.connected
  - "建议" （已迁移）
      backend : tools.reviewDocument.finding.recommendation
      frontend: components.message.tool.reviewCard.changeRecommendation
  - "开放" （已迁移）
      backend : tools.reviewDocument.values.trackingStatus.open
      frontend: components.message.tool.reviewCard.trackingOpen
  - "当前进度" 
      backend : tools.reviewDocument.summary.currentProgress
      frontend: components.message.tool.progressCard.currentProgress
  - "性能" （已迁移）
      backend : tools.reviewDocument.values.category.performance
      frontend: components.message.tool.reviewCard.categoryPerformance
  - "恢复检查点失败" （已迁移）
      backend : modules.checkpoint.errors.restoreFailed, webview.errors.restoreCheckpointFailed
      frontend: components.message.checkpoint.restoreResultFailed, stores.chatStore.errors.restoreCheckpointFailed
  - "打开 diff 预览失败" （已迁移）
      backend : webview.errors.openDiffPreviewFailed
      frontend: components.message.tool.openDiffFailed
  - "打开文件失败" （已迁移）
      backend : webview.errors.openFileFailed
      frontend: components.message.tool.designCard.openFileFailed, components.message.tool.planCard.openFileFailed
  - "执行前" 
      backend : modules.checkpoint.description.before
      frontend: components.settings.checkpoint.sections.cleanup.phaseBefore, components.settings.checkpoint.sections.tools.beforeLabel
  - "执行后" 
      backend : modules.checkpoint.description.after
      frontend: components.settings.checkpoint.sections.cleanup.phaseAfter, components.settings.checkpoint.sections.tools.afterLabel
  - "执行计划" 
      backend : notifications.windowsAgentStop.actionLabels.executePlan
      frontend: app.agentStopNotification.actions.executePlan, components.message.tool.planCard.executePlan
  - "执行超时" 
      backend : tools.errors.timeout
      frontend: components.settings.toolSettings.terminal.executeCommand.execTimeout
  - "拒绝" 
      backend : tools.file.diffCodeLens.reject
      frontend: components.message.tool.reject, components.tools.reject
  - "接受风险" （已迁移）
      backend : tools.reviewDocument.values.trackingStatus.acceptedRisk
      frontend: components.message.tool.reviewCard.trackingAcceptedRisk
  - "摘要" 
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
  - "文档" 
      backend : tools.reviewDocument.values.category.docs
      frontend: components.message.tool.reviewCard.categoryDocs, components.settings.channelSettings.form.multimodal.document
  - "日期" （已迁移）
      backend : tools.reviewDocument.header.date
      frontend: common.date
  - "最新结论" 
      backend : tools.reviewDocument.summary.latestConclusion
      frontend: components.message.tool.progressCard.latestConclusion, components.message.tool.reviewCard.latestConclusion
  - "有条件通过" （已迁移）
      backend : tools.reviewDocument.values.overallDecision.conditionallyAccepted
      frontend: components.message.tool.reviewCard.decisionConditionallyAccepted
  - "未知错误" 
      backend : errors.unknown, modules.api.chat.errors.unknownError
      frontend: components.settings.dependencySettings.progress.unknownError, errors.unknown, stores.chatStore.errors.unknownError
  - "此次修改删除了 {deletePercent}% 的文件内容（{deletedLines}/{totalLines} 行），超过 {threshold}% 的警戒阈值，请仔细检查" （已迁移）
      backend : tools.file.diffManager.diffGuardWarning
      frontend: components.settings.toolSettings.files.applyDiff.diffGuardWarning
  - "测试" （已迁移）
      backend : tools.reviewDocument.values.category.test
      frontend: components.message.tool.reviewCard.categoryTest
  - "添加模型失败" 
      backend : modules.api.models.errors.addModelsFailed, webview.errors.addModelsFailed
      frontend: components.settings.modelManager.errors.addFailed
  - "状态" 
      backend : tools.reviewDocument.header.status, tools.reviewDocument.milestone.status
      frontend: common.status, components.message.responseViewer.status, components.message.tool.progressCard.status, components.message.tool.reviewCard.status
  - "生成计划" 
      backend : notifications.windowsAgentStop.actionLabels.generatePlan
      frontend: app.agentStopNotification.actions.generatePlan, components.message.tool.designCard.generatePlan, components.message.tool.reviewCard.generatePlan
  - "相关里程碑" 
      backend : tools.reviewDocument.finding.relatedMilestones
      frontend: components.message.tool.reviewCard.changeRelatedMilestoneIds
  - "确认" 
      backend : notifications.windowsAgentStop.actionLabels.genericConfirmation
      frontend: common.confirm, components.common.confirmDialog.title, components.settings.channelSettings.selector.confirm
  - "移除模型失败" （已迁移）
      backend : modules.api.models.errors.removeModelFailed, webview.errors.removeModelFailed
      frontend: components.settings.modelManager.errors.removeFailed
  - "结论" 
      backend : tools.reviewDocument.milestone.conclusion
      frontend: components.message.tool.reviewCard.decision
  - "继续" 
      backend : notifications.windowsAgentStop.actionLabels.continue
      frontend: app.agentStopNotification.actions.continue, common.resume, components.message.continue.button, components.subagents.monitor.resume
  - "设置激活模型失败" （已迁移）
      backend : modules.api.models.errors.setActiveModelFailed, webview.errors.setActiveModelFailed
      frontend: components.settings.modelManager.errors.setActiveFailed
  - "证据" （已迁移）
      backend : tools.reviewDocument.finding.evidenceFiles, tools.reviewDocument.milestone.evidenceFiles
      frontend: components.message.tool.reviewCard.changeEvidence, components.message.tool.reviewCard.evidence
  - "该存档创建时按当时的排除规则排除了 {count} 个文件" 
      backend : modules.checkpoint.restore.excludedNote
      frontend: components.settings.checkpoint.sections.cleanup.manifestNote
  - "说明" （已迁移）
      backend : tools.reviewDocument.finding.description
      frontend: components.message.tool.reviewCard.changeDescription
  - "读取文件失败" 
      backend : webview.errors.readFileFailed
      frontend: components.input.promptContext.readFailed, composables.useAttachments.errors.readFileFailed
  - "跟踪状态" 
      backend : tools.reviewDocument.finding.trackingStatus
      frontend: components.message.tool.reviewCard.changeTrackingStatus, components.message.tool.reviewCard.tracking
  - "进行中" 
      backend : tools.reviewDocument.values.milestoneStatus.inProgress
      frontend: components.message.tool.progressCard.milestoneStatusInProgress, components.message.tool.progressCard.statusActive, components.message.tool.reviewCard.statusInProgress, components.message.tool.todoPanel.statusInProgress
  - "通过" （已迁移）
      backend : tools.reviewDocument.values.overallDecision.accepted
      frontend: components.message.tool.reviewCard.decisionAccepted
  - "重复" （已迁移）
      backend : tools.reviewDocument.values.trackingStatus.duplicate
      frontend: components.message.tool.reviewCard.trackingDuplicate
  - "错误" 
      backend : modules.mcp.status.error
      frontend: common.error, components.message.tool.error, components.message.tool.progressCard.issueError, components.message.tool.reviewCard.issueError, components.settings.contextSettings.diagnostics.severity.error, components.settings.mcp.error, components.settings.toolSettings.common.error, components.tools.error, components.tools.media.cropImagePanel.status.error, components.tools.media.generateImagePanel.status.error, components.tools.media.removeBackgroundPanel.status.error, components.tools.media.resizeImagePanel.status.error, components.tools.media.rotateImagePanel.status.error
  - "问题" 
      backend : tools.reviewDocument.milestone.findings
      frontend: components.message.tool.reviewCard.findings
  - "高" 
      backend : tools.reviewDocument.values.severity.high
      frontend: components.channels.gemini.thinking.levelHigh, components.channels.openai.thinking.effortHigh, components.message.tool.reviewCard.severityHigh

【3】三语言完全一致词条（zh/en/ja 译文在两端完全相同）——最强重复信号
  共 50 组
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
  - zh="不修复" en="Won't Fix" ja="修正しない" （已迁移）
      backend : tools.reviewDocument.values.trackingStatus.wontFix
      frontend: components.message.tool.reviewCard.trackingWontFix
  - zh="不通过" en="Rejected" ja="却下" （已迁移）
      backend : tools.reviewDocument.values.overallDecision.rejected
      frontend: components.message.tool.reviewCard.decisionRejected
  - zh="严重级别" en="Severity" ja="重大度" （已迁移）
      backend : tools.reviewDocument.finding.severity
      frontend: components.message.tool.reviewCard.changeSeverity
  - zh="中" en="Medium" ja="中" 
      backend : tools.reviewDocument.values.severity.medium
      frontend: components.channels.gemini.thinking.levelMedium, components.channels.openai.thinking.effortMedium, components.message.tool.reviewCard.severityMedium
  - zh="低" en="Low" ja="低" 
      backend : tools.reviewDocument.values.severity.low
      frontend: components.channels.gemini.thinking.levelLow, components.channels.openai.thinking.effortLow, components.message.tool.reviewCard.severityLow
  - zh="全部拒绝" en="Reject All" ja="すべて拒否" （已迁移）
      backend : tools.file.diffCodeLens.rejectAll
      frontend: components.message.tool.rejectAll
  - zh="其他" en="Other" ja="その他" 
      backend : tools.reviewDocument.values.category.other
      frontend: components.message.tool.reviewCard.categoryOther, components.settings.autoExec.categories.other, components.settings.toolsSettings.categories.other
  - zh="可维护性" en="Maintainability" ja="保守性" （已迁移）
      backend : tools.reviewDocument.values.category.maintainability
      frontend: components.message.tool.reviewCard.categoryMaintainability
  - zh="可访问性" en="Accessibility" ja="アクセシビリティ" （已迁移）
      backend : tools.reviewDocument.values.category.accessibility
      frontend: components.message.tool.reviewCard.categoryAccessibility
  - zh="已修复" en="Fixed" ja="修正済み" （已迁移）
      backend : tools.reviewDocument.values.trackingStatus.fixed
      frontend: components.message.tool.reviewCard.trackingFixed
  - zh="已完成" en="Completed" ja="完了" 
      backend : tools.reviewDocument.values.milestoneStatus.completed
      frontend: common.completed, components.backgroundTasks.completed, components.message.tool.progressCard.milestoneStatusCompleted, components.message.tool.progressCard.statusCompleted, components.message.tool.reviewCard.statusCompleted, components.subagents.monitor.status.completed
  - zh="已断开" en="Disconnected" ja="切断済み" （已迁移）
      backend : modules.mcp.status.disconnected
      frontend: components.settings.mcp.disconnected
  - zh="已连接" en="Connected" ja="接続済み" 
      backend : modules.mcp.status.connected
      frontend: components.settings.mcp.connected, components.settings.mcpSettings.status.connected
  - zh="建议" en="Recommendation" ja="提案" （已迁移）
      backend : tools.reviewDocument.finding.recommendation
      frontend: components.message.tool.reviewCard.changeRecommendation
  - zh="开放" en="Open" ja="オープン" （已迁移）
      backend : tools.reviewDocument.values.trackingStatus.open
      frontend: components.message.tool.reviewCard.trackingOpen
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
      frontend: components.settings.checkpoint.sections.cleanup.phaseBefore
  - zh="执行后" en="After" ja="実行後" （已迁移）
      backend : modules.checkpoint.description.after
      frontend: components.settings.checkpoint.sections.cleanup.phaseAfter
  - zh="拒绝" en="Reject" ja="拒否" 
      backend : tools.file.diffCodeLens.reject
      frontend: components.message.tool.reject, components.tools.reject
  - zh="接受风险" en="Accepted Risk" ja="リスク受容" （已迁移）
      backend : tools.reviewDocument.values.trackingStatus.acceptedRisk
      frontend: components.message.tool.reviewCard.trackingAcceptedRisk
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
      frontend: components.message.tool.reviewCard.categoryDocs
  - zh="日期" en="Date" ja="日付" （已迁移）
      backend : tools.reviewDocument.header.date
      frontend: common.date
  - zh="有条件通过" en="Conditionally Accepted" ja="条件付き承認" （已迁移）
      backend : tools.reviewDocument.values.overallDecision.conditionallyAccepted
      frontend: components.message.tool.reviewCard.decisionConditionallyAccepted
  - zh="未知错误" en="Unknown error" ja="不明なエラー" 
      backend : errors.unknown, modules.api.chat.errors.unknownError
      frontend: components.settings.dependencySettings.progress.unknownError, errors.unknown, stores.chatStore.errors.unknownError
  - zh="此次修改删除了 {deletePercent}% 的文件内容（{deletedLines}/{totalLines} 行），超过 {threshold}% 的警戒阈值，请仔细检查" en="This change deletes {deletePercent}% of the file content ({deletedLines}/{totalLines} lines), exceeding the {threshold}% guard threshold. Please review carefully." ja="この変更はファイルの {deletePercent}% のコンテンツ（{deletedLines}/{totalLines} 行）を削除し、{threshold}% のガード閾値を超えています。慎重に確認してください。" （已迁移）
      backend : tools.file.diffManager.diffGuardWarning
      frontend: components.settings.toolSettings.files.applyDiff.diffGuardWarning
  - zh="测试" en="Test" ja="テスト" （已迁移）
      backend : tools.reviewDocument.values.category.test
      frontend: components.message.tool.reviewCard.categoryTest
  - zh="状态" en="Status" ja="状態" 
      backend : tools.reviewDocument.header.status, tools.reviewDocument.milestone.status
      frontend: components.message.responseViewer.status, components.message.tool.progressCard.status, components.message.tool.reviewCard.status
  - zh="确认" en="Confirm" ja="確認" 
      backend : notifications.windowsAgentStop.actionLabels.genericConfirmation
      frontend: common.confirm, components.common.confirmDialog.title, components.settings.channelSettings.selector.confirm
  - zh="移除模型失败" en="Failed to remove model" ja="モデルの削除に失敗しました" （已迁移）
      backend : modules.api.models.errors.removeModelFailed, webview.errors.removeModelFailed
      frontend: components.settings.modelManager.errors.removeFailed
  - zh="继续" en="Continue" ja="続行" 
      backend : notifications.windowsAgentStop.actionLabels.continue
      frontend: app.agentStopNotification.actions.continue, components.message.continue.button
  - zh="设置激活模型失败" en="Failed to set active model" ja="アクティブモデルの設定に失敗しました" （已迁移）
      backend : modules.api.models.errors.setActiveModelFailed, webview.errors.setActiveModelFailed
      frontend: components.settings.modelManager.errors.setActiveFailed
  - zh="证据" en="Evidence" ja="証拠" （已迁移）
      backend : tools.reviewDocument.finding.evidenceFiles, tools.reviewDocument.milestone.evidenceFiles
      frontend: components.message.tool.reviewCard.changeEvidence, components.message.tool.reviewCard.evidence
  - zh="说明" en="Description" ja="説明" （已迁移）
      backend : tools.reviewDocument.finding.description
      frontend: components.message.tool.reviewCard.changeDescription
  - zh="读取文件失败" en="Failed to read file" ja="ファイルの読み取りに失敗しました" 
      backend : webview.errors.readFileFailed
      frontend: components.input.promptContext.readFailed, composables.useAttachments.errors.readFileFailed
  - zh="进行中" en="In Progress" ja="進行中" （已迁移）
      backend : tools.reviewDocument.values.milestoneStatus.inProgress
      frontend: components.message.tool.progressCard.milestoneStatusInProgress, components.message.tool.reviewCard.statusInProgress, components.message.tool.todoPanel.statusInProgress
  - zh="通过" en="Accepted" ja="承認" （已迁移）
      backend : tools.reviewDocument.values.overallDecision.accepted
      frontend: components.message.tool.reviewCard.decisionAccepted
  - zh="重复" en="Duplicate" ja="重複" （已迁移）
      backend : tools.reviewDocument.values.trackingStatus.duplicate
      frontend: components.message.tool.reviewCard.trackingDuplicate
  - zh="错误" en="Error" ja="エラー" 
      backend : modules.mcp.status.error
      frontend: common.error, components.message.tool.error, components.message.tool.progressCard.issueError, components.message.tool.reviewCard.issueError, components.settings.contextSettings.diagnostics.severity.error, components.settings.mcp.error, components.settings.toolSettings.common.error, components.tools.error, components.tools.media.cropImagePanel.status.error, components.tools.media.generateImagePanel.status.error, components.tools.media.removeBackgroundPanel.status.error, components.tools.media.resizeImagePanel.status.error, components.tools.media.rotateImagePanel.status.error
  - zh="高" en="High" ja="高" 
      backend : tools.reviewDocument.values.severity.high
      frontend: components.channels.gemini.thinking.levelHigh, components.channels.openai.thinking.effortHigh, components.message.tool.reviewCard.severityHigh

【4】仅空白差异的相似词条（归一化后相同，原文不同）
  共 146 对
  - backend "modules.mcp.errors.invalidServerId"
    frontend "components.settings.mcpSettings.form.serverIdError"
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
    frontend "components.settings.dependencySettings.progress.unknownError"
  - backend "modules.api.chat.errors.unknownError"
    frontend "errors.unknown"
  - backend "modules.api.chat.errors.unknownError"
    frontend "stores.chatStore.errors.unknownError"
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
    frontend "components.message.tool.reviewCard.tracking"
  - backend "tools.reviewDocument.finding.trackingStatus"
    frontend "components.message.tool.reviewCard.changeTrackingStatus"
  - backend "tools.reviewDocument.finding.description"
    frontend "components.message.tool.reviewCard.changeDescription"
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
    frontend "components.message.tool.reviewCard.statusCompleted"
  - backend "tools.reviewDocument.values.milestoneStatus.completed"
    frontend "components.message.tool.progressCard.milestoneStatusCompleted"
  - backend "tools.reviewDocument.values.milestoneStatus.completed"
    frontend "components.message.tool.progressCard.statusCompleted"
  - backend "tools.reviewDocument.values.milestoneStatus.completed"
    frontend "components.backgroundTasks.completed"
  - backend "tools.reviewDocument.values.milestoneStatus.completed"
    frontend "components.subagents.monitor.status.completed"
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
    frontend "components.channels.gemini.thinking.levelMedium"
  - backend "tools.reviewDocument.values.severity.medium"
    frontend "components.channels.openai.thinking.effortMedium"
  - backend "tools.reviewDocument.values.severity.low"
    frontend "components.message.tool.reviewCard.severityLow"
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
    frontend "components.settings.channelSettings.selector.confirm"
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
  - backend "webview.errors.openDiffPreviewFailed"
    frontend "components.message.tool.openDiffFailed"
  - backend "webview.errors.openFileFailed"
    frontend "components.message.tool.planCard.openFileFailed"
  - backend "webview.errors.openFileFailed"
    frontend "components.message.tool.designCard.openFileFailed"
  - backend "errors.cancelled"
    frontend "errors.cancelled"

【5】只有一端有的词条（按 zh 译文统计）
  backend 独有: 376 条（frontend 无同译文）
    - "模块 "{moduleId}" 已经注册" <- core.registry.moduleAlreadyRegistered
    - "模块 "{moduleId}" 中存在重复的 API 名称: {apiName}" <- core.registry.duplicateApiName
    - "[ModuleRegistry] 注册模块: {moduleId} ({moduleName} v{version})" <- core.registry.registeringModule
    - "模块未注册: {moduleId}" <- core.registry.moduleNotRegistered
    - "[ModuleRegistry] 取消注册模块: {moduleId}" <- core.registry.unregisteringModule
    - "API 不存在: {moduleId}.{apiName}" <- core.registry.apiNotFound
    - "缺少必需参数: {params}" <- core.registry.missingRequiredParams
    - "配置不存在: {configId}" <- modules.api.chat.errors.configNotFound, modules.channel.errors.configNotFound, modules.config.errors.configNotFound
    - "配置已存在: {configId}，使用 overwrite 选项覆盖" <- modules.config.errors.configExists
    - "无效的配置" <- modules.config.errors.invalidConfig
    - "配置验证失败: {errors}" <- modules.config.errors.validationFailed
    - "保存配置失败" <- modules.config.errors.saveFailed
    - "加载配置失败" <- modules.config.errors.loadFailed
    - "名称不能为空" <- modules.config.validation.nameRequired
    - "类型不能为空" <- modules.config.validation.typeRequired
    ...（其余 361 条略）
  frontend 独有: 2061 条（backend 无同译文）
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
    ...（其余 2046 条略）

【6】共享映射 manifest 当前状态
  已登记映射: 54 条（A:\api\Gray-Code-main\scripts\i18n-shared-manifest.json）
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

