<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { useI18n } from '../../i18n'
import { TaskCard, MarkdownRenderer, CustomScrollbar } from '../common'
import type { ReviewCardData } from '../../utils/reviewCards'
import { copyToClipboard } from '../../utils/format'
import { sendToExtension, showNotification } from '../../utils/vscode'

const props = withDefaults(defineProps<{
  card: ReviewCardData
  content?: string
  status?: 'pending' | 'running' | 'success' | 'error'
  defaultExpanded?: boolean
  showRawResult?: boolean
}>(), {
  content: '',
  status: 'success',
  defaultExpanded: false,
  showRawResult: true
})

const { t } = useI18n()

const copied = ref(false)
let copyResetTimer: ReturnType<typeof setTimeout> | undefined

function getFallbackTitleByTool(sourceTool: ReviewCardData['sourceTool']): string {
  switch (sourceTool) {
    case 'create_review':
      return t('components.message.tool.createReview.fallbackTitle')
    case 'record_review_milestone':
      return t('components.message.tool.recordReviewMilestone.fallbackTitle')
    case 'finalize_review':
      return t('components.message.tool.finalizeReview.fallbackTitle')
    case 'validate_review_document':
      return t('components.message.tool.validateReviewDocument.fallbackTitle')
  }
}

function getSourceToolLabel(sourceTool: ReviewCardData['sourceTool']): string {
  switch (sourceTool) {
    case 'create_review':
      return t('components.message.tool.reviewCard.sourceCreate')
    case 'record_review_milestone':
      return t('components.message.tool.reviewCard.sourceMilestone')
    case 'finalize_review':
      return t('components.message.tool.reviewCard.sourceFinalize')
    case 'validate_review_document':
      return t('components.message.tool.reviewCard.sourceValidate')
  }
}

function getCardIcon(sourceTool: ReviewCardData['sourceTool']): string {
  switch (sourceTool) {
    case 'create_review':
      return 'codicon-eye'
    case 'record_review_milestone':
      return 'codicon-list-unordered'
    case 'finalize_review':
      return 'codicon-check-all'
    case 'validate_review_document':
      return 'codicon-verified'
  }
}

function getReviewStatusLabel(status?: ReviewCardData['status']): string {
  if (status === 'completed') return t('components.message.tool.reviewCard.statusCompleted')
  if (status === 'in_progress') return t('components.message.tool.reviewCard.statusInProgress')
  return ''
}

function getOverallDecisionLabel(decision?: ReviewCardData['overallDecision']): string {
  if (decision === 'accepted') return t('components.message.tool.reviewCard.decisionAccepted')
  if (decision === 'conditionally_accepted') return t('components.message.tool.reviewCard.decisionConditionallyAccepted')
  if (decision === 'rejected') return t('components.message.tool.reviewCard.decisionRejected')
  if (decision === 'needs_follow_up') return t('components.message.tool.reviewCard.decisionNeedsFollowUp')
  return ''
}

function getValidationLabel(card: ReviewCardData): string {
  if (card.canAutoUpgrade) return t('components.message.tool.reviewCard.validationAutoUpgrade')
  if (card.isValid === false) return t('components.message.tool.reviewCard.validationInvalid')
  if ((card.warningCount || 0) > 0) return t('components.message.tool.reviewCard.validationWarning')
  if (card.isValid === true) return t('components.message.tool.reviewCard.validationValid')
  return ''
}

function getIssueSeverityLabel(severity?: 'error' | 'warning'): string {
  return severity === 'error'
    ? t('components.message.tool.reviewCard.issueError')
    : t('components.message.tool.reviewCard.issueWarning')
}

type ReviewSummaryTone = 'neutral' | 'success' | 'warning' | 'error'
type ReviewSummaryItem = {
  key: string
  label: string
  value: string
  tone?: ReviewSummaryTone
}

function getStatusTone(status?: ReviewCardData['status']): ReviewSummaryTone {
  return status === 'completed' ? 'success' : 'neutral'
}

function getDecisionTone(decision?: ReviewCardData['overallDecision']): ReviewSummaryTone {
  if (decision === 'accepted') return 'success'
  if (decision === 'rejected') return 'error'
  if (decision === 'conditionally_accepted' || decision === 'needs_follow_up') return 'warning'
  return 'neutral'
}

function getValidationTone(card: ReviewCardData): ReviewSummaryTone {
  if (card.isValid === false) return 'error'
  if (card.canAutoUpgrade || (card.warningCount || 0) > 0) return 'warning'
  if (card.isValid === true) return 'success'
  return 'neutral'
}

const title = computed(() => props.card.title || getFallbackTitleByTool(props.card.sourceTool))
const subtitle = computed(() => props.card.path || undefined)
const footerRight = computed(() => {
  const parts = [getSourceToolLabel(props.card.sourceTool), props.card.date || ''].filter(Boolean)
  return parts.length > 0 ? parts.join(' · ') : undefined
})

const metaChips = computed(() => {
  const chips: string[] = []
  const statusLabel = getReviewStatusLabel(props.card.status)
  if (statusLabel) chips.push(statusLabel)

  const decisionLabel = getOverallDecisionLabel(props.card.overallDecision)
  if (decisionLabel) chips.push(decisionLabel)

  if (
    typeof props.card.completedMilestones === 'number'
    && typeof props.card.totalMilestones === 'number'
  ) {
    chips.push(t('components.message.tool.reviewCard.milestonesChip', {
      completed: props.card.completedMilestones,
      total: props.card.totalMilestones
    }))
  }

  if (typeof props.card.totalFindings === 'number') {
    chips.push(t('components.message.tool.reviewCard.findingsChip', {
      total: props.card.totalFindings,
      high: props.card.highCount || 0,
      medium: props.card.mediumCount || 0,
      low: props.card.lowCount || 0
    }))
  }

  if ((props.card.reviewedModulesCount || 0) > 0) {
    chips.push(t('components.message.tool.reviewCard.modulesChip', {
      count: props.card.reviewedModulesCount || 0
    }))
  }

  const validationLabel = getValidationLabel(props.card)
  if (validationLabel) chips.push(validationLabel)

  if (props.card.sourceTool === 'validate_review_document' && props.card.detectedFormat) {
    chips.push(t('components.message.tool.reviewCard.formatChip', {
      format: props.card.detectedFormat
    }))
  }

  return chips
})

const preview = computed(() => {
  const blocks: string[] = []

  if (props.card.latestConclusionPreview) {
    blocks.push([
      t('components.message.tool.reviewCard.latestConclusion'),
      props.card.latestConclusionPreview
    ].join('\n'))
  }

  if (props.card.recommendedNextActionPreview) {
    blocks.push([
      t('components.message.tool.reviewCard.recommendedNextAction'),
      props.card.recommendedNextActionPreview
    ].join('\n'))
  }

  if (blocks.length === 0) {
    const validationLabel = getValidationLabel(props.card)
    if (validationLabel) {
      blocks.push([
        t('components.message.tool.reviewCard.validation'),
        validationIssueSummary.value || validationLabel
      ].join('\n'))
    }
  }

  return blocks.join('\n\n')
})

const rawContent = computed(() => (props.content || '').trim())
const showRawContent = computed(() => props.showRawResult && rawContent.value.length > 0)
const rawContentIsMarkdown = computed(() => props.card.sourceTool !== 'validate_review_document')

const validationIssueSummary = computed(() => {
  if (
    props.card.issueCount === undefined
    && props.card.errorCount === undefined
    && props.card.warningCount === undefined
  ) {
    return ''
  }

  if ((props.card.issueCount || 0) === 0) {
    return t('components.message.tool.reviewCard.noIssues')
  }

  return t('components.message.tool.reviewCard.issueSummary', {
    count: props.card.issueCount || 0,
    errors: props.card.errorCount || 0,
    warnings: props.card.warningCount || 0
  })
})

const milestonesSummary = computed(() => {
  if (
    typeof props.card.completedMilestones === 'number'
    && typeof props.card.totalMilestones === 'number'
  ) {
    return `${props.card.completedMilestones}/${props.card.totalMilestones}`
  }

  return ''
})

const findingsSummary = computed(() => {
  if (typeof props.card.totalFindings !== 'number') {
    return ''
  }

  return t('components.message.tool.reviewCard.findingsChip', {
    total: props.card.totalFindings,
    high: props.card.highCount || 0,
    medium: props.card.mediumCount || 0,
    low: props.card.lowCount || 0
  })
})

const summaryItems = computed<ReviewSummaryItem[]>(() => {
  const items: ReviewSummaryItem[] = []

  const statusLabel = getReviewStatusLabel(props.card.status)
  if (statusLabel) {
    items.push({
      key: 'status',
      label: t('components.message.tool.reviewCard.status'),
      value: statusLabel,
      tone: getStatusTone(props.card.status)
    })
  }

  const decisionLabel = getOverallDecisionLabel(props.card.overallDecision)
  if (decisionLabel) {
    items.push({
      key: 'decision',
      label: t('components.message.tool.reviewCard.decision'),
      value: decisionLabel,
      tone: getDecisionTone(props.card.overallDecision)
    })
  }

  if (props.card.currentProgress) {
    items.push({
      key: 'progress',
      label: t('components.message.tool.reviewCard.progress'),
      value: props.card.currentProgress
    })
  }

  if (milestonesSummary.value) {
    items.push({
      key: 'milestones',
      label: t('components.message.tool.reviewCard.milestones'),
      value: milestonesSummary.value
    })
  }

  if (findingsSummary.value) {
    items.push({
      key: 'findings',
      label: t('components.message.tool.reviewCard.findings'),
      value: findingsSummary.value
    })
  }

  const validationLabel = getValidationLabel(props.card)
  if (validationLabel || validationIssueSummary.value) {
    items.push({
      key: 'validation',
      label: t('components.message.tool.reviewCard.validation'),
      value: validationIssueSummary.value || validationLabel,
      tone: getValidationTone(props.card)
    })
  }

  if (props.card.sourceTool === 'validate_review_document' && props.card.detectedFormat) {
    items.push({
      key: 'format',
      label: t('components.message.tool.reviewCard.format'),
      value: props.card.detectedFormat
    })
  }

  return items
})

const moduleTags = computed(() => props.card.reviewedModules || [])

async function openReviewFile(): Promise<void> {
  if (!props.card.path) return

  try {
    await sendToExtension('openWorkspaceFileAt', {
      path: props.card.path,
      highlight: false,
      preview: false
    })
  } catch (error) {
    console.error('[review-card] Failed to open review file:', error)
    await showNotification(t('components.message.tool.reviewCard.openFileFailed'), 'error')
  }
}

async function copyReviewPath(): Promise<void> {
  if (!props.card.path) return

  const success = await copyToClipboard(props.card.path)
  if (!success) {
    await showNotification(t('components.message.tool.reviewCard.copyFailed'), 'error')
    return
  }

  copied.value = true
  if (copyResetTimer) clearTimeout(copyResetTimer)
  copyResetTimer = setTimeout(() => {
    copied.value = false
    copyResetTimer = undefined
  }, 1500)
}

onBeforeUnmount(() => {
  if (copyResetTimer) {
    clearTimeout(copyResetTimer)
    copyResetTimer = undefined
  }
})
</script>

<template>
  <TaskCard
    :title="title"
    :subtitle="subtitle"
    :icon="getCardIcon(card.sourceTool)"
    :status="status"
    :preview="preview"
    :preview-is-markdown="false"
    :meta-chips="metaChips"
    :footer-right="footerRight"
    :default-expanded="props.defaultExpanded"
  >
    <template #expanded>
      <div class="review-card-expanded">
        <div class="review-card-actions">
          <button
            class="review-card-btn"
            :disabled="!card.path"
            @click="openReviewFile"
          >
            <span class="codicon codicon-go-to-file"></span>
            <span>{{ t('components.message.tool.reviewCard.openFile') }}</span>
          </button>
          <button
            class="review-card-btn secondary"
            :disabled="!card.path"
            @click="copyReviewPath"
          >
            <span class="codicon codicon-copy"></span>
            <span>{{ copied ? t('components.message.tool.reviewCard.copied') : t('components.message.tool.reviewCard.copyPath') }}</span>
          </button>
        </div>

        <div v-if="summaryItems.length > 0" class="review-summary-grid">
          <div
            v-for="item in summaryItems"
            :key="item.key"
            :class="['review-summary-item', item.tone ? `tone-${item.tone}` : '']"
          >
            <div class="review-summary-label">{{ item.label }}</div>
            <div class="review-summary-value">{{ item.value }}</div>
          </div>
        </div>

        <div v-if="moduleTags.length > 0" class="review-block">
          <div class="review-label">{{ t('components.message.tool.reviewCard.modules') }}</div>
          <div class="review-module-tags">
            <span v-for="moduleName in moduleTags" :key="moduleName" class="review-module-tag">
              {{ moduleName }}
            </span>
          </div>
        </div>

        <div v-if="card.latestConclusion" class="review-block">
          <div class="review-label">{{ t('components.message.tool.reviewCard.latestConclusion') }}</div>
          <div class="review-rich-content">
            <MarkdownRenderer :content="card.latestConclusion" />
          </div>
        </div>

        <div v-if="card.recommendedNextAction" class="review-block">
          <div class="review-label">{{ t('components.message.tool.reviewCard.recommendedNextAction') }}</div>
          <div class="review-rich-content">
            <MarkdownRenderer :content="card.recommendedNextAction" />
          </div>
        </div>

        <div v-if="card.issues && card.issues.length > 0" class="review-block">
          <div class="review-label">{{ t('components.message.tool.reviewCard.validation') }}</div>
          <ul class="review-issues">
            <li v-for="(issue, index) in card.issues" :key="`${issue.code || 'issue'}-${index}`" class="review-issue-item">
              <span :class="['review-issue-badge', issue.severity || 'warning']">{{ getIssueSeverityLabel(issue.severity) }}</span>
              <span class="review-issue-text">{{ issue.message }}</span>
            </li>
          </ul>
        </div>

        <div v-if="showRawContent" class="review-block">
          <div class="review-label">{{ t('components.message.tool.reviewCard.rawResult') }}</div>
          <div class="review-raw-result">
            <CustomScrollbar :max-height="400">
              <div class="review-raw-result-inner">
                <MarkdownRenderer v-if="rawContentIsMarkdown" :content="rawContent" />
                <pre v-else class="review-raw-text">{{ rawContent }}</pre>
              </div>
            </CustomScrollbar>
          </div>
        </div>
      </div>
    </template>
  </TaskCard>
</template>

<style scoped>
.review-card-expanded {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.review-card-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.review-card-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border: none;
  border-radius: 6px;
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  cursor: pointer;
  font-size: 11px;
}

.review-card-btn:hover:not(:disabled) {
  background: var(--vscode-button-hoverBackground);
}

.review-card-btn.secondary {
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
}

.review-card-btn.secondary:hover:not(:disabled) {
  background: var(--vscode-button-secondaryHoverBackground, var(--vscode-button-secondaryBackground));
}

.review-card-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.review-summary-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 8px;
}

.review-summary-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  padding: 10px;
  border: 1px solid var(--vscode-panel-border);
  border-radius: 8px;
  background: var(--vscode-sideBar-background);
}

.review-summary-item.tone-success {
  border-color: var(--vscode-testing-iconPassed);
}

.review-summary-item.tone-warning {
  border-color: var(--vscode-editorWarning-foreground);
}

.review-summary-item.tone-error {
  border-color: var(--vscode-errorForeground);
}

.review-summary-label {
  font-size: 10px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--vscode-descriptionForeground);
}

.review-summary-value {
  font-size: 12px;
  line-height: 1.5;
  color: var(--vscode-foreground);
  word-break: break-word;
}

.review-module-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.review-module-tag {
  display: inline-flex;
  align-items: center;
  padding: 4px 8px;
  border-radius: 999px;
  border: 1px solid var(--vscode-panel-border);
  background: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
  font-size: 11px;
}

.review-block {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.review-label {
  font-size: 10px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--vscode-descriptionForeground);
}

.review-rich-content,
.review-raw-result {
  border: 1px solid var(--vscode-panel-border);
  border-radius: 8px;
  background: var(--vscode-sideBar-background);
  overflow: hidden;
}

.review-rich-content :deep(.markdown-content),
.review-raw-result-inner {
  padding: 8px 10px;
}

.review-issues {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.review-issue-item {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  padding: 8px 10px;
  border: 1px solid var(--vscode-panel-border);
  border-radius: 8px;
  background: var(--vscode-sideBar-background);
}

.review-issue-badge {
  flex-shrink: 0;
  border-radius: 999px;
  padding: 2px 8px;
  font-size: 10px;
  background: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
}

.review-issue-badge.error {
  background: var(--vscode-inputValidation-errorBackground);
  color: var(--vscode-errorForeground);
}

.review-issue-badge.warning {
  background: var(--vscode-inputValidation-warningBackground);
  color: var(--vscode-editorWarning-foreground);
}

.review-issue-text {
  font-size: 12px;
  line-height: 1.5;
  color: var(--vscode-foreground);
}

.review-raw-text {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 12px;
  line-height: 1.5;
  color: var(--vscode-foreground);
  font-family: var(--vscode-editor-font-family), monospace;
}
</style>
