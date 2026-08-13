<script setup lang="ts">
import { computed } from 'vue'
import { MarkdownRenderer } from '../../common'
import ReviewTaskCard from '../ReviewTaskCard.vue'
import ProgressTaskCard from '../ProgressTaskCard.vue'
import { useI18n } from '../../../i18n'
import type { ResponseViewerData } from '../responseViewer/buildResponseViewerData'
import {
  buildBasicInfoItems,
  buildMetadataExtra,
  buildMetadataKnownItems,
  buildResponseInfoItems,
  formatBytes,
  formatBoolean,
  formatDuration,
  formatInteger,
  formatJson,
  formatSourceMessage,
  formatStructuredValue,
  getCollapsedText,
  getPartFunctionCallArgs,
  getPartTypeLabel,
  getResultSourceLabel,
  getReviewCardStatus,
  getToolArgsValue,
  getToolStatusClass,
  getToolStatusLabel
} from './viewerFormat'

const props = defineProps<{
  value: ResponseViewerData
  expandedBlocks: Record<string, boolean>
}>()

const emit = defineEmits<{
  copyBody: [text: string]
  toggleExpanded: [key: string]
  openRawJson: []
}>()

const { t } = useI18n()

const parts = computed(() => props.value.advanced.parts)
const tools = computed(() => props.value.advanced.tools)
const attachments = computed(() => props.value.advanced.attachments)

const responseInfoItems = computed(() => buildResponseInfoItems(props.value))
const basicInfoItems = computed(() => buildBasicInfoItems(props.value))
const metadataKnownItems = computed(() => buildMetadataKnownItems(props.value))
const metadataExtra = computed(() => buildMetadataExtra(props.value))
const hasMetadata = computed(() =>
  responseInfoItems.value.length > 0 || metadataKnownItems.value.length > 0 || Boolean(metadataExtra.value)
)

function handleCopyBody(text: string): void {
  emit('copyBody', text)
}

function handleToggleExpanded(key: string): void {
  emit('toggleExpanded', key)
}

function handleOpenRawJson(): void {
  emit('openRawJson')
}

function isExpanded(key: string): boolean {
  return props.expandedBlocks[key] === true
}

function getExpandedLabel(key: string): string {
  return isExpanded(key) ? t('common.collapse') : t('common.expand')
}
</script>

<template>
  <div class="viewer-mode advanced-mode">
    <section class="viewer-section">
      <div class="section-title">{{ t('components.message.responseViewer.basicInfo') }}</div>
      <div class="section-content">
        <div class="info-grid">
          <div v-for="item in basicInfoItems" :key="`${item.label}-${item.value}`" class="info-item">
            <div class="info-label">{{ item.label }}</div>
            <div class="info-value">{{ item.value }}</div>
          </div>
        </div>
      </div>
    </section>

    <section class="viewer-section">
      <div class="section-title">{{ t('components.message.responseViewer.body') }}</div>
      <div v-if="props.value.advanced.answerText" class="section-content">
        <div class="section-actions">
          <button class="section-action-btn" type="button" @click="handleCopyBody(props.value.advanced.answerText)">
            {{ t('components.message.responseViewer.copyBody') }}
          </button>
        </div>
        <MarkdownRenderer :content="props.value.advanced.answerText" class="viewer-markdown" />
      </div>
      <div v-else class="empty-block">{{ t('components.message.emptyResponse') }}</div>
    </section>

    <section class="viewer-section">
      <div class="section-title">{{ t('components.message.responseViewer.thought') }}</div>
      <div v-if="props.value.advanced.thoughtText" class="section-content">
        <MarkdownRenderer :content="props.value.advanced.thoughtText" class="viewer-markdown thought-markdown" />
      </div>
      <div v-else class="empty-block">{{ t('components.message.responseViewer.noThought') }}</div>
    </section>

    <section class="viewer-section">
      <div class="section-title">{{ t('components.message.responseViewer.parts') }}</div>
      <div v-if="parts.length > 0" class="detail-list">
        <details
          v-for="part in parts"
          :key="`${part.type}-${part.index}`"
          class="detail-card"
        >
          <summary class="detail-summary">
            <div class="detail-summary-main">
              <span class="detail-index">#{{ part.index + 1 }}</span>
              <span class="detail-type">{{ getPartTypeLabel(part.type) }}</span>
              <span v-if="part.title" class="detail-title">{{ part.title }}</span>
            </div>
            <span v-if="part.preview" class="detail-preview">{{ part.preview }}</span>
          </summary>

          <div class="detail-body">
            <MarkdownRenderer v-if="part.text" :content="part.text" class="viewer-markdown" />

            <template v-if="part.functionCall">
              <div class="info-grid compact-grid">
                <div class="info-item">
                  <div class="info-label">{{ t('components.message.responseViewer.name') }}</div>
                  <div class="info-value">{{ part.functionCall.name }}</div>
                </div>
                <div v-if="part.functionCall.id" class="info-item">
                  <div class="info-label">{{ t('components.message.responseViewer.id') }}</div>
                  <div class="info-value">{{ part.functionCall.id }}</div>
                </div>
              </div>
              <div class="json-section">
                <div class="json-title">{{ t('components.message.tool.parameters') }}</div>
                <pre class="json-block">{{ formatStructuredValue(getPartFunctionCallArgs(part)) }}</pre>
              </div>

              <div v-if="part.pairedFunctionResponse" class="json-section">
                <div class="json-header">
                  <div class="json-title">{{ t('components.message.responseViewer.pairedFunctionResponse') }}</div>
                  <button
                    v-if="part.pairedFunctionResponse.hasLargeResponse"
                    class="inline-link-btn"
                    type="button"
                    @click="handleToggleExpanded(`part-paired-response-${part.index}`)"
                  >
                    {{ getExpandedLabel(`part-paired-response-${part.index}`) }}
                  </button>
                </div>

                <div class="info-grid compact-grid section-meta-grid">
                  <div class="info-item">
                    <div class="info-label">{{ t('components.message.responseViewer.name') }}</div>
                    <div class="info-value">{{ part.pairedFunctionResponse.name }}</div>
                  </div>
                  <div v-if="part.pairedFunctionResponse.id" class="info-item">
                    <div class="info-label">{{ t('components.message.responseViewer.id') }}</div>
                    <div class="info-value">{{ part.pairedFunctionResponse.id }}</div>
                  </div>
                  <div class="info-item">
                    <div class="info-label">{{ t('components.message.responseViewer.responseSource') }}</div>
                    <div class="info-value">{{ getResultSourceLabel(part.pairedFunctionResponse.source) }}</div>
                  </div>
                  <div
                    v-if="part.pairedFunctionResponse.sourceMessageId || typeof part.pairedFunctionResponse.sourceBackendIndex === 'number'"
                    class="info-item info-item-wide"
                  >
                    <div class="info-label">{{ t('components.message.responseViewer.sourceMessage') }}</div>
                    <div class="info-value">
                      {{ formatSourceMessage(part.pairedFunctionResponse.sourceMessageId, part.pairedFunctionResponse.sourceBackendIndex) }}
                    </div>
                  </div>
                </div>

                <pre
                  v-if="!part.pairedFunctionResponse.hasLargeResponse || isExpanded(`part-paired-response-${part.index}`)"
                  class="json-block"
                >{{ formatStructuredValue(part.pairedFunctionResponse.response) }}</pre>
                <pre v-else class="json-block json-preview-block">{{ getCollapsedText(part.pairedFunctionResponse.preview) }}</pre>
              </div>
            </template>

            <template v-if="part.functionResponse">
              <div class="info-grid compact-grid">
                <div class="info-item">
                  <div class="info-label">{{ t('components.message.responseViewer.name') }}</div>
                  <div class="info-value">{{ part.functionResponse.name }}</div>
                </div>
                <div v-if="part.functionResponse.id" class="info-item">
                  <div class="info-label">{{ t('components.message.responseViewer.id') }}</div>
                  <div class="info-value">{{ part.functionResponse.id }}</div>
                </div>
              </div>
              <div class="json-section">
                <div class="json-header">
                  <div class="json-title">{{ t('components.message.tool.result') }}</div>
                  <button
                    v-if="part.hasLargeResponse"
                    class="inline-link-btn"
                    type="button"
                    @click="handleToggleExpanded(`part-response-${part.index}`)"
                  >
                    {{ getExpandedLabel(`part-response-${part.index}`) }}
                  </button>
                </div>
                <pre
                  v-if="!part.hasLargeResponse || isExpanded(`part-response-${part.index}`)"
                  class="json-block"
                >{{ formatStructuredValue(part.functionResponse.response || {}) }}</pre>
                <pre v-else class="json-block json-preview-block">{{ getCollapsedText(part.responseSummary || part.preview) }}</pre>
              </div>
            </template>

            <template v-if="part.inlineData">
              <div class="info-grid compact-grid">
                <div class="info-item">
                  <div class="info-label">{{ t('components.message.responseViewer.mimeType') }}</div>
                  <div class="info-value">{{ part.inlineData.mimeType }}</div>
                </div>
                <div class="info-item">
                  <div class="info-label">{{ t('components.message.responseViewer.size') }}</div>
                  <div class="info-value">{{ formatInteger(part.inlineData.dataSize) }}</div>
                </div>
              </div>
            </template>

            <template v-if="part.fileData">
              <div class="info-grid compact-grid">
                <div v-if="part.fileData.displayName" class="info-item">
                  <div class="info-label">{{ t('components.message.responseViewer.name') }}</div>
                  <div class="info-value">{{ part.fileData.displayName }}</div>
                </div>
                <div class="info-item">
                  <div class="info-label">{{ t('components.message.responseViewer.mimeType') }}</div>
                  <div class="info-value">{{ part.fileData.mimeType }}</div>
                </div>
                <div class="info-item info-item-wide">
                  <div class="info-label">{{ t('components.message.responseViewer.fileUri') }}</div>
                  <div class="info-value">{{ part.fileData.fileUri }}</div>
                </div>
              </div>
            </template>

            <details class="nested-raw">
              <summary>{{ t('components.message.responseViewer.rawJson') }}</summary>
              <pre class="json-block">{{ formatJson(part.raw) }}</pre>
            </details>
          </div>
        </details>
      </div>
      <div v-else class="empty-block">{{ t('components.message.responseViewer.noParts') }}</div>
    </section>

    <section class="viewer-section">
      <div class="section-title">{{ t('components.message.responseViewer.toolCalls') }}</div>
      <div v-if="tools.length > 0" class="detail-list">
        <details
          v-for="(tool, index) in tools"
          :key="tool.id || `${tool.name}-${index}`"
          class="detail-card"
        >
          <summary class="detail-summary">
            <div class="detail-summary-main">
              <span class="detail-type">{{ tool.name }}</span>
              <span class="status-badge" :class="getToolStatusClass(tool.status)">
                {{ getToolStatusLabel(tool.status) }}
              </span>
            </div>
            <span v-if="tool.argsSummary" class="detail-preview">{{ tool.argsSummary }}</span>
          </summary>

          <div class="detail-body">
            <ReviewTaskCard
              v-if="tool.reviewCardData"
              class="response-viewer-review-card embedded"
              :card="tool.reviewCardData"
              :content="tool.reviewFallbackContent"
              :status="getReviewCardStatus(tool.status)"
              :show-raw-result="false"
            />
            <ProgressTaskCard
              v-else-if="tool.progressCardData"
              class="response-viewer-review-card embedded"
              :card="tool.progressCardData"
              :content="tool.progressFallbackContent"
              :status="getReviewCardStatus(tool.status)"
              :show-raw-result="false"
            />

            <div class="info-grid compact-grid">
              <div class="info-item">
                <div class="info-label">{{ t('components.message.responseViewer.name') }}</div>
                <div class="info-value">{{ tool.name }}</div>
              </div>
              <div class="info-item">
                <div class="info-label">{{ t('components.message.responseViewer.status') }}</div>
                <div class="info-value">{{ getToolStatusLabel(tool.status) }}</div>
              </div>
              <div v-if="tool.duration" class="info-item">
                <div class="info-label">{{ t('components.message.responseViewer.duration') }}</div>
                <div class="info-value">{{ formatDuration(tool.duration) }}</div>
              </div>
            </div>

            <div class="json-section">
              <div class="json-header">
                <div class="json-title">{{ t('components.message.tool.parameters') }}</div>
                <button
                  v-if="tool.hasLargeArgs"
                  class="inline-link-btn"
                  type="button"
                  @click="handleToggleExpanded(`tool-args-${tool.id || index}`)"
                >
                  {{ getExpandedLabel(`tool-args-${tool.id || index}`) }}
                </button>
              </div>
              <pre
                v-if="!tool.hasLargeArgs || isExpanded(`tool-args-${tool.id || index}`)"
                class="json-block"
              >{{ formatStructuredValue(getToolArgsValue(tool)) }}</pre>
              <pre v-else class="json-block json-preview-block">{{ getCollapsedText(tool.argsSummary) }}</pre>
            </div>

            <div v-if="tool.error" class="json-section">
              <div class="json-header">
                <div class="json-title">{{ t('components.message.tool.error') }}</div>
                <button
                  v-if="tool.hasLargeResult"
                  class="inline-link-btn"
                  type="button"
                  @click="handleToggleExpanded(`tool-result-${tool.id || index}`)"
                >
                  {{ getExpandedLabel(`tool-result-${tool.id || index}`) }}
                </button>
              </div>
              <pre
                v-if="!tool.hasLargeResult || isExpanded(`tool-result-${tool.id || index}`)"
                class="json-block error-json"
              >{{ tool.error }}</pre>
              <pre v-else class="json-block json-preview-block error-json">{{ getCollapsedText(tool.resultSummary || tool.error) }}</pre>
            </div>
            <div v-else-if="tool.result !== undefined" class="json-section">
              <div class="json-header">
                <div class="json-title">{{ t('components.message.tool.result') }}</div>
                <button
                  v-if="tool.hasLargeResult"
                  class="inline-link-btn"
                  type="button"
                  @click="handleToggleExpanded(`tool-result-${tool.id || index}`)"
                >
                  {{ getExpandedLabel(`tool-result-${tool.id || index}`) }}
                </button>
              </div>

              <div v-if="tool.resultSource" class="info-grid compact-grid section-meta-grid">
                <div class="info-item">
                  <div class="info-label">{{ t('components.message.responseViewer.responseSource') }}</div>
                  <div class="info-value">{{ getResultSourceLabel(tool.resultSource) }}</div>
                </div>
                <div
                  v-if="tool.resultSource === 'hiddenFunctionResponse' && (tool.sourceMessageId || typeof tool.sourceBackendIndex === 'number')"
                  class="info-item info-item-wide"
                >
                  <div class="info-label">{{ t('components.message.responseViewer.sourceMessage') }}</div>
                  <div class="info-value">{{ formatSourceMessage(tool.sourceMessageId, tool.sourceBackendIndex) }}</div>
                </div>
              </div>

              <pre
                v-if="!tool.hasLargeResult || isExpanded(`tool-result-${tool.id || index}`)"
                class="json-block"
              >{{ formatStructuredValue(tool.result) }}</pre>
              <pre v-else class="json-block json-preview-block">{{ getCollapsedText(tool.resultSummary) }}</pre>
            </div>
          </div>
        </details>
      </div>
      <div v-else class="empty-block">{{ t('components.message.responseViewer.noTools') }}</div>
    </section>

    <section class="viewer-section">
      <div class="section-title">{{ t('components.message.responseViewer.metadata') }}</div>
      <div v-if="hasMetadata" class="section-content metadata-section">
        <div v-if="responseInfoItems.length > 0" class="info-grid">
          <div v-for="item in responseInfoItems" :key="`${item.label}-${item.value}`" class="info-item">
            <div class="info-label">{{ item.label }}</div>
            <div class="info-value">{{ item.value }}</div>
          </div>
        </div>

        <div v-if="metadataKnownItems.length > 0" class="info-grid extra-info-grid">
          <div v-for="item in metadataKnownItems" :key="`${item.label}-${item.value}`" class="info-item">
            <div class="info-label">{{ item.label }}</div>
            <div class="info-value">{{ item.value }}</div>
          </div>
        </div>

        <details v-if="metadataExtra" class="nested-raw">
          <summary>{{ t('components.message.responseViewer.moreMetadata') }}</summary>
          <pre class="json-block">{{ formatJson(metadataExtra) }}</pre>
        </details>
      </div>
      <div v-else class="empty-block">{{ t('components.message.responseViewer.noMetadata') }}</div>
    </section>

    <section class="viewer-section">
      <div class="section-title">{{ t('components.message.responseViewer.attachments') }}</div>
      <div v-if="attachments.length > 0" class="attachment-list">
        <div
          v-for="attachment in attachments"
          :key="attachment.id"
          class="attachment-card"
        >
          <div class="attachment-name">{{ attachment.name }}</div>
          <div class="info-grid compact-grid attachment-info-grid">
            <div class="info-item">
              <div class="info-label">{{ t('components.message.responseViewer.attachmentType') }}</div>
              <div class="info-value">{{ attachment.type }}</div>
            </div>
            <div class="info-item">
              <div class="info-label">{{ t('components.message.responseViewer.size') }}</div>
              <div class="info-value">{{ formatBytes(attachment.size) }}</div>
            </div>
            <div class="info-item">
              <div class="info-label">{{ t('components.message.responseViewer.mimeType') }}</div>
              <div class="info-value">{{ attachment.mimeType }}</div>
            </div>
            <div class="info-item">
              <div class="info-label">{{ t('components.message.responseViewer.hasData') }}</div>
              <div class="info-value">{{ formatBoolean(attachment.hasData) }}</div>
            </div>
            <div class="info-item">
              <div class="info-label">{{ t('components.message.responseViewer.hasThumbnail') }}</div>
              <div class="info-value">{{ formatBoolean(attachment.hasThumbnail) }}</div>
            </div>
          </div>

          <div v-if="attachment.metadata" class="json-section">
            <div class="json-header">
              <div class="json-title">{{ t('components.message.responseViewer.metadata') }}</div>
              <button
                v-if="attachment.hasLargeMetadata"
                class="inline-link-btn"
                type="button"
                @click="handleToggleExpanded(`attachment-metadata-${attachment.id}`)"
              >
                {{ getExpandedLabel(`attachment-metadata-${attachment.id}`) }}
              </button>
            </div>
            <pre
              v-if="!attachment.hasLargeMetadata || isExpanded(`attachment-metadata-${attachment.id}`)"
              class="json-block"
            >{{ formatStructuredValue(attachment.metadata) }}</pre>
            <pre v-else class="json-block json-preview-block">{{ getCollapsedText(attachment.metadataSummary) }}</pre>
          </div>
        </div>
      </div>
      <div v-else class="empty-block">{{ t('components.message.responseViewer.noAttachments') }}</div>
    </section>

    <section class="viewer-section">
      <div class="section-title">{{ t('components.message.responseViewer.rawJson') }}</div>
      <div class="section-content raw-json-actions">
        <span class="raw-json-hint">{{ t('components.message.responseViewer.rawJsonHint') }}</span>
        <button class="dialog-btn confirm" type="button" @click="handleOpenRawJson()">
          {{ t('components.message.responseViewer.openRawJson') }}
        </button>
      </div>
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
.detail-card,
.attachment-card {
  border: 1px solid var(--vscode-panel-border);
  border-radius: 8px;
  background: var(--vscode-editor-background);
}

.attachment-card {
  padding: 16px 18px;
}

.section-title {
  padding: 14px 18px;
  font-size: 13px;
  font-weight: 600;
  border-bottom: 1px solid var(--vscode-panel-border);
}

.section-content,
.detail-body {
  padding: 16px 18px;
}

.empty-block {
  padding: 16px 18px;
  color: var(--vscode-descriptionForeground);
  font-size: 12px;
}

.detail-summary,
.nested-raw summary {
  cursor: pointer;
  list-style: none;
}

.detail-summary::-webkit-details-marker,
.nested-raw summary::-webkit-details-marker {
  display: none;
}

.status-badge,
.detail-index,
.detail-type {
  display: inline-flex;
  align-items: center;
  border-radius: 999px;
  padding: 2px 8px;
  font-size: 11px;
  font-weight: 500;
}

.detail-index {
  background: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
}

.status-badge,
.detail-type {
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

.detail-list,
.attachment-list {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 16px 18px;
}

.response-viewer-review-card {
  width: 100%;
}

.response-viewer-review-card.embedded {
  margin-bottom: 14px;
}

.detail-summary-main {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.attachment-name,
.detail-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--vscode-foreground);
}

.detail-preview,
.raw-json-hint {
  color: var(--vscode-foreground);
  font-size: 12px;
  line-height: 1.5;
}

.error-json {
  color: var(--vscode-errorForeground);
}

.info-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 12px;
}

.compact-grid {
  margin-bottom: 12px;
}

.extra-info-grid {
  margin-top: 12px;
}

.section-meta-grid {
  margin-top: 0;
}

.attachment-info-grid {
  margin-top: 12px;
}

.info-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.info-item-wide {
  grid-column: 1 / -1;
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

.detail-summary {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 18px;
}

.detail-preview {
  flex: 1;
  text-align: right;
  color: var(--vscode-descriptionForeground);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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

.json-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 14px;
}

.json-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.json-title {
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
}

.inline-link-btn {
  padding: 0;
  border: none;
  background: transparent;
  color: var(--vscode-textLink-foreground);
  font-size: 12px;
  cursor: pointer;
}

.inline-link-btn:hover {
  text-decoration: underline;
}

.json-block {
  margin: 0;
  padding: 12px;
  border-radius: 6px;
  border: 1px solid var(--vscode-panel-border);
  background: rgba(0, 0, 0, 0.15);
  color: var(--vscode-foreground);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  overflow-x: auto;
}

.json-preview-block {
  color: var(--vscode-descriptionForeground);
}

.nested-raw {
  margin-top: 12px;
}

.nested-raw summary {
  color: var(--vscode-textLink-foreground);
  font-size: 12px;
}

.raw-json-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.dialog-btn {
  padding: 6px 14px;
  border-radius: 4px;
  font-size: 13px;
  cursor: pointer;
  border: none;
  transition: background-color 0.15s, opacity 0.15s;
}

.dialog-btn.cancel {
  background: transparent;
  color: var(--vscode-foreground);
  border: 1px solid var(--vscode-panel-border);
}

.dialog-btn.cancel:hover {
  background: var(--vscode-toolbar-hoverBackground);
}

.dialog-btn.confirm {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
}

.dialog-btn.confirm:hover {
  background: var(--vscode-button-hoverBackground);
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
  .detail-summary,
  .raw-json-actions {
    flex-direction: column;
    align-items: flex-start;
  }

  .detail-preview {
    width: 100%;
    text-align: left;
    white-space: normal;
  }

  .section-actions {
    justify-content: flex-start;
  }

  .json-header {
    align-items: flex-start;
    flex-direction: column;
  }
}
</style>
