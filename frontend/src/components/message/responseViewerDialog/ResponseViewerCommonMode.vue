<script setup lang="ts">
import { computed } from 'vue'
import { MarkdownRenderer } from '../../common'
import ReviewTaskCard from '../ReviewTaskCard.vue'
import ProgressTaskCard from '../ProgressTaskCard.vue'
import { useI18n } from '../../../i18n'
import type { ResponseViewerData } from '../responseViewer/buildResponseViewerData'
import {
  buildResponseInfoItems,
  formatDuration,
  formatSourceMessage,
  getResultSourceLabel,
  getReviewCardStatus,
  getToolStatusClass,
  getToolStatusLabel
} from './viewerFormat'

const props = defineProps<{
  value: ResponseViewerData
}>()

const emit = defineEmits<{
  copyBody: [text: string]
}>()

const { t } = useI18n()

const answerText = computed(() => props.value.common.answerText || '')
const thoughtText = computed(() => props.value.common.thoughtText || '')
const tools = computed(() => props.value.common.tools)
const responseInfoItems = computed(() => buildResponseInfoItems(props.value))

function handleCopyBody(text: string): void {
  emit('copyBody', text)
}
</script>

<template>
  <div class="viewer-mode">
    <section class="viewer-section">
      <div class="section-title">{{ t('components.message.responseViewer.body') }}</div>
      <div v-if="answerText" class="section-content">
        <div class="section-actions">
          <button class="section-action-btn" type="button" @click="handleCopyBody(answerText)">
            {{ t('components.message.responseViewer.copyBody') }}
          </button>
        </div>
        <MarkdownRenderer :content="answerText" class="viewer-markdown" />
      </div>
      <div v-else class="empty-block">{{ t('components.message.emptyResponse') }}</div>
    </section>

    <details v-if="thoughtText" class="viewer-details">
      <summary class="viewer-details-summary">
        <span>{{ t('components.message.responseViewer.thought') }}</span>
        <span
          v-if="typeof props.value.common.timing.thinkingDuration === 'number' && props.value.common.timing.thinkingDuration > 0"
          class="summary-badge"
        >
          {{ formatDuration(props.value.common.timing.thinkingDuration) }}
        </span>
      </summary>
      <div class="details-body">
        <MarkdownRenderer :content="thoughtText" class="viewer-markdown thought-markdown" />
      </div>
    </details>

    <section class="viewer-section">
      <div class="section-title">{{ t('components.message.responseViewer.toolCalls') }}</div>
      <div v-if="tools.length > 0" class="tool-list">
        <div
          v-for="(tool, index) in tools"
          :key="tool.id || `${tool.name}-${index}`"
          class="tool-entry"
        >
          <div v-if="tool.reviewCardData || tool.progressCardData" class="response-viewer-review-block">
            <ProgressTaskCard
              v-if="tool.progressCardData"
              class="response-viewer-review-card"
              :card="tool.progressCardData"
              :content="tool.progressFallbackContent"
              :status="getReviewCardStatus(tool.status)"
              :show-raw-result="false"
            />
            <ReviewTaskCard
              v-else-if="tool.reviewCardData"
              class="response-viewer-review-card"
              :card="tool.reviewCardData"
              :content="tool.reviewFallbackContent"
              :status="getReviewCardStatus(tool.status)"
            />

            <div v-if="tool.argsSummary || (tool.resultSource && tool.resultSource !== 'tool') || tool.error" class="response-viewer-review-meta">
              <div v-if="tool.argsSummary" class="tool-summary-row">
                <span class="summary-label">{{ t('components.message.tool.parameters') }}</span>
                <span class="summary-value">{{ tool.argsSummary }}</span>
              </div>

              <div v-if="tool.resultSource && tool.resultSource !== 'tool'" class="tool-summary-row">
                <span class="summary-label">{{ t('components.message.responseViewer.responseSource') }}</span>
                <span class="summary-value">{{ getResultSourceLabel(tool.resultSource) }}</span>
              </div>

              <div
                v-if="tool.resultSource === 'hiddenFunctionResponse' && (tool.sourceMessageId || typeof tool.sourceBackendIndex === 'number')"
                class="tool-summary-row"
              >
                <span class="summary-label">{{ t('components.message.responseViewer.sourceMessage') }}</span>
                <span class="summary-value">{{ formatSourceMessage(tool.sourceMessageId, tool.sourceBackendIndex) }}</span>
              </div>

              <div v-if="tool.error" class="tool-summary-row error-row">
                <span class="summary-label">{{ t('components.message.tool.error') }}</span>
                <span class="summary-value">{{ tool.error }}</span>
              </div>
            </div>
          </div>
          <div v-else class="tool-card">
            <div class="tool-card-header">
              <div class="tool-name">{{ tool.name }}</div>
              <span class="status-badge" :class="getToolStatusClass(tool.status)">
                {{ getToolStatusLabel(tool.status) }}
              </span>
            </div>

            <div v-if="tool.argsSummary" class="tool-summary-row">
              <span class="summary-label">{{ t('components.message.tool.parameters') }}</span>
              <span class="summary-value">{{ tool.argsSummary }}</span>
            </div>

            <div v-if="tool.resultSource && tool.resultSource !== 'tool'" class="tool-summary-row">
              <span class="summary-label">{{ t('components.message.responseViewer.responseSource') }}</span>
              <span class="summary-value">{{ getResultSourceLabel(tool.resultSource) }}</span>
            </div>

            <div
              v-if="tool.resultSource === 'hiddenFunctionResponse' && (tool.sourceMessageId || typeof tool.sourceBackendIndex === 'number')"
              class="tool-summary-row"
            >
              <span class="summary-label">{{ t('components.message.responseViewer.sourceMessage') }}</span>
              <span class="summary-value">{{ formatSourceMessage(tool.sourceMessageId, tool.sourceBackendIndex) }}</span>
            </div>

            <div v-if="tool.error" class="tool-summary-row error-row">
              <span class="summary-label">{{ t('components.message.tool.error') }}</span>
              <span class="summary-value">{{ tool.error }}</span>
            </div>
            <div v-else-if="tool.resultSummary" class="tool-summary-row">
              <span class="summary-label">{{ t('components.message.tool.result') }}</span>
              <span class="summary-value">{{ tool.resultSummary }}</span>
            </div>
          </div>
        </div>
      </div>
      <div v-else class="empty-block">{{ t('components.message.responseViewer.noTools') }}</div>
    </section>

    <section class="viewer-section">
      <div class="section-title">{{ t('components.message.responseViewer.responseInfo') }}</div>
      <div v-if="responseInfoItems.length > 0" class="info-grid section-body-grid">
        <div v-for="item in responseInfoItems" :key="`${item.label}-${item.value}`" class="info-item">
          <div class="info-label">{{ item.label }}</div>
          <div class="info-value">{{ item.value }}</div>
        </div>
      </div>
      <div v-else class="empty-block">{{ t('components.message.responseViewer.empty') }}</div>
    </section>
  </div>
</template>

<style scoped>
.viewer-mode {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.viewer-section,
.viewer-details {
  border: 1px solid var(--vscode-panel-border);
  border-radius: 8px;
  background: var(--vscode-editor-background);
}

.section-title {
  padding: 14px 18px;
  font-size: 13px;
  font-weight: 600;
  border-bottom: 1px solid var(--vscode-panel-border);
}

.section-content,
.details-body {
  padding: 16px 18px;
}

.empty-block {
  padding: 16px 18px;
  color: var(--vscode-descriptionForeground);
  font-size: 12px;
}

.viewer-details {
  overflow: hidden;
}

.viewer-details-summary {
  cursor: pointer;
  list-style: none;
}

.viewer-details-summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 18px;
  font-size: 13px;
  font-weight: 600;
}

.viewer-details-summary::-webkit-details-marker {
  display: none;
}

.summary-badge,
.status-badge {
  display: inline-flex;
  align-items: center;
  border-radius: 999px;
  padding: 2px 8px;
  font-size: 11px;
  font-weight: 500;
}

.summary-badge {
  background: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
}

.status-badge {
  background: var(--vscode-editor-inactiveSelectionBackground, rgba(128, 128, 128, 0.16));
  color: var(--vscode-foreground);
}

.status-streaming,
.status-queued,
.status-awaiting_approval,
.status-executing,
.status-awaiting_apply {
  background: color-mix(in srgb, var(--vscode-textLink-foreground) 14%, transparent);
  color: var(--vscode-textLink-foreground);
}

.status-success {
  background: color-mix(in srgb, var(--vscode-terminal-ansiGreen) 16%, transparent);
  color: var(--vscode-terminal-ansiGreen);
}

.status-error {
  background: color-mix(in srgb, var(--vscode-errorForeground) 16%, transparent);
  color: var(--vscode-errorForeground);
}

.status-warning {
  background: color-mix(in srgb, var(--vscode-editorWarning-foreground) 16%, transparent);
  color: var(--vscode-editorWarning-foreground);
}

.status-unknown {
  background: var(--vscode-editor-inactiveSelectionBackground, rgba(128, 128, 128, 0.16));
  color: var(--vscode-descriptionForeground);
}

.tool-list {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 16px 18px;
}

.tool-entry,
.response-viewer-review-block,
.response-viewer-review-meta {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.response-viewer-review-card {
  width: 100%;
}

.response-viewer-review-meta {
  padding: 0 2px;
}

.tool-card {
  padding: 14px;
  border-radius: 6px;
  background: var(--vscode-editorWidget-background, rgba(128, 128, 128, 0.08));
  border: 1px solid var(--vscode-panel-border);
}

.tool-card-header {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.tool-card-header {
  justify-content: space-between;
  margin-bottom: 10px;
}

.tool-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--vscode-foreground);
}

.tool-summary-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 12px;
  line-height: 1.5;
  margin-top: 8px;
}

.summary-label {
  color: var(--vscode-descriptionForeground);
  min-width: 84px;
  flex-shrink: 0;
}

.summary-value {
  color: var(--vscode-foreground);
  font-size: 12px;
  line-height: 1.5;
}

.error-row .summary-value {
  color: var(--vscode-errorForeground);
}

.info-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 12px;
}

.section-body-grid {
  padding: 16px 18px;
}

.info-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.info-label {
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
}

.info-value {
  font-size: 12px;
  color: var(--vscode-foreground);
  word-break: break-word;
}

.section-actions {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 12px;
}

.section-action-btn {
  padding: 5px 12px;
  border-radius: 4px;
  border: 1px solid var(--vscode-panel-border);
  background: transparent;
  color: var(--vscode-foreground);
  font-size: 12px;
  cursor: pointer;
}

.section-action-btn:hover {
  background: var(--vscode-toolbar-hoverBackground);
}

.viewer-mode :deep(.viewer-markdown p:first-child),
.viewer-mode :deep(.thought-markdown p:first-child) {
  margin-top: 0;
}

.viewer-mode :deep(.viewer-markdown p:last-child),
.viewer-mode :deep(.thought-markdown p:last-child) {
  margin-bottom: 0;
}

.thought-markdown {
  --lim-md-font-style: italic;
  --lim-md-color: var(--vscode-descriptionForeground);
}

@media (max-width: 768px) {
  .tool-card-header {
    flex-direction: column;
    align-items: flex-start;
  }

  .section-actions {
    justify-content: flex-start;
  }
}
</style>
