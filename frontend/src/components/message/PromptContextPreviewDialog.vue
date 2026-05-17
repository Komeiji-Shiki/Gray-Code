<script setup lang="ts">
import { computed, ref } from 'vue'
import { Modal } from '../common'
import type { PromptContextPreview, PromptContextPreviewSection } from '../../types'
import { copyToClipboard } from '../../utils/format'

const props = withDefaults(defineProps<{
  modelValue: boolean
  preview?: PromptContextPreview
}>(), {
  modelValue: false,
  preview: undefined
})

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
}>()

const copiedId = ref<string | null>(null)

const visible = computed({
  get: () => props.modelValue,
  set: value => emit('update:modelValue', value)
})

const sections = computed(() => props.preview?.sections || [])

const totalChars = computed(() => sections.value.reduce((sum, section) => sum + section.charCount, 0))
const totalTokens = computed(() => sections.value.reduce((sum, section) => sum + section.estimatedTokens, 0))
const totalMessages = computed(() => sections.value.reduce((sum, section) => sum + (section.messageCount || 0), 0))

function formatInteger(value: number | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '0'
  return value.toLocaleString()
}

function formatTime(timestamp?: number): string {
  if (!timestamp) return '-'
  return new Date(timestamp).toLocaleString()
}

function roleLabel(role?: PromptContextPreviewSection['role']): string {
  if (!role) return 'mixed'
  if (role === 'model') return 'assistant/model'
  return role
}

function buildSectionCopyText(section: PromptContextPreviewSection): string {
  return [
    `# ${section.title}`,
    `role: ${roleLabel(section.role)}`,
    `chars: ${section.charCount}`,
    `estimatedTokens: ${section.estimatedTokens}`,
    typeof section.messageCount === 'number' ? `messages: ${section.messageCount}` : undefined,
    section.truncated ? 'truncated: true' : undefined,
    '',
    section.text
  ].filter(line => line !== undefined).join('\n')
}

function buildAllCopyText(): string {
  if (!props.preview) return ''
  const header = [
    '# Prompt Context Preview',
    `generatedAt: ${formatTime(props.preview.generatedAt)}`,
    `iteration: ${props.preview.iteration}`,
    `strategy: ${props.preview.strategy}`,
    `historyPlacement: ${props.preview.historyPlacement}`,
    `trimStartIndex: ${props.preview.trim.trimStartIndex ?? '-'}`,
    `historyLength: ${props.preview.trim.historyLength}`,
    `needsAutoSummarize: ${props.preview.trim.needsAutoSummarize === true}`,
    ''
  ].join('\n')

  return `${header}${sections.value.map(buildSectionCopyText).join('\n\n---\n\n')}`
}

async function copySection(section: PromptContextPreviewSection): Promise<void> {
  const ok = await copyToClipboard(buildSectionCopyText(section))
  if (ok) {
    copiedId.value = section.id
    window.setTimeout(() => {
      if (copiedId.value === section.id) copiedId.value = null
    }, 1200)
  }
}

async function copyAll(): Promise<void> {
  const ok = await copyToClipboard(buildAllCopyText())
  if (ok) {
    copiedId.value = '__all__'
    window.setTimeout(() => {
      if (copiedId.value === '__all__') copiedId.value = null
    }, 1200)
  }
}
</script>

<template>
  <Modal v-model="visible" title="Prompt Context 预览" width="960px">
    <div v-if="preview" class="prompt-preview">
      <div class="preview-summary">
        <div class="summary-item">
          <span class="summary-label">生成时间</span>
          <span class="summary-value">{{ formatTime(preview.generatedAt) }}</span>
        </div>
        <div class="summary-item">
          <span class="summary-label">迭代</span>
          <span class="summary-value">#{{ preview.iteration }}</span>
        </div>
        <div class="summary-item">
          <span class="summary-label">策略</span>
          <span class="summary-value">{{ preview.strategy }}</span>
        </div>
        <div class="summary-item">
          <span class="summary-label">历史放置</span>
          <span class="summary-value">{{ preview.historyPlacement }}</span>
        </div>
        <div class="summary-item">
          <span class="summary-label">裁剪起点</span>
          <span class="summary-value">{{ preview.trim.trimStartIndex ?? '-' }}</span>
        </div>
        <div class="summary-item">
          <span class="summary-label">历史消息</span>
          <span class="summary-value">{{ formatInteger(preview.trim.historyLength) }}</span>
        </div>
        <div class="summary-item">
          <span class="summary-label">总字符</span>
          <span class="summary-value">{{ formatInteger(totalChars) }}</span>
        </div>
        <div class="summary-item">
          <span class="summary-label">估算 Token</span>
          <span class="summary-value">≈ {{ formatInteger(totalTokens) }}</span>
        </div>
        <div class="summary-item">
          <span class="summary-label">分区消息</span>
          <span class="summary-value">{{ formatInteger(totalMessages) }}</span>
        </div>
      </div>

      <div class="preview-toolbar">
        <span v-if="preview.trim.needsAutoSummarize" class="summarize-badge">
          触发自动总结检测
        </span>
        <button class="copy-button" type="button" @click="copyAll">
          <i class="codicon codicon-copy"></i>
          {{ copiedId === '__all__' ? '已复制' : '复制全部' }}
        </button>
      </div>

      <div class="section-list">
        <section
          v-for="section in sections"
          :key="section.id"
          class="preview-section"
        >
          <header class="section-header">
            <div class="section-title-wrap">
              <h4 class="section-title">{{ section.title }}</h4>
              <span class="section-role">{{ roleLabel(section.role) }}</span>
              <span v-if="section.truncated" class="truncated-badge">已截断</span>
            </div>
            <button class="copy-button copy-button--small" type="button" @click="copySection(section)">
              <i class="codicon codicon-copy"></i>
              {{ copiedId === section.id ? '已复制' : '复制' }}
            </button>
          </header>

          <div class="section-stats">
            <span>{{ formatInteger(section.charCount) }} chars</span>
            <span>≈ {{ formatInteger(section.estimatedTokens) }} tokens</span>
            <span v-if="typeof section.messageCount === 'number'">
              {{ formatInteger(section.messageCount) }} messages
            </span>
          </div>

          <pre class="section-text">{{ section.text || '(empty)' }}</pre>
        </section>
      </div>
    </div>

    <div v-else class="empty-preview">
      暂无 Prompt Context 预览数据。
    </div>
  </Modal>
</template>

<style scoped>
.prompt-preview {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.preview-summary {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 8px;
  padding: 10px;
  border: 1px solid var(--vscode-panel-border);
  border-radius: 8px;
  background: var(--vscode-editor-inactiveSelectionBackground, rgba(127, 127, 127, 0.08));
}

.summary-item {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.summary-label {
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
}

.summary-value {
  font-size: 12px;
  color: var(--vscode-foreground);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.preview-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}

.summarize-badge,
.truncated-badge {
  display: inline-flex;
  align-items: center;
  padding: 2px 6px;
  border-radius: 999px;
  font-size: 11px;
  color: var(--vscode-charts-orange);
  background: color-mix(in srgb, var(--vscode-charts-orange) 14%, transparent);
}

.section-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.preview-section {
  border: 1px solid var(--vscode-panel-border);
  border-radius: 8px;
  overflow: hidden;
  background: var(--vscode-editor-background);
}

.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--vscode-panel-border);
  background: var(--vscode-editor-inactiveSelectionBackground, rgba(127, 127, 127, 0.08));
}

.section-title-wrap {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.section-title {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--vscode-foreground);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.section-role {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  border: 1px solid var(--vscode-panel-border);
  border-radius: 999px;
  padding: 1px 6px;
}

.section-stats {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 8px 12px 0;
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
}

.section-text {
  margin: 8px 12px 12px;
  max-height: 360px;
  overflow: auto;
  padding: 10px;
  border-radius: 6px;
  border: 1px solid var(--vscode-panel-border);
  background: var(--vscode-textCodeBlock-background, rgba(127, 127, 127, 0.08));
  color: var(--vscode-editor-foreground);
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 12px;
  line-height: 1.45;
  white-space: pre-wrap;
  word-break: break-word;
}

.copy-button {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border: 1px solid var(--vscode-button-border, transparent);
  border-radius: 5px;
  padding: 5px 9px;
  cursor: pointer;
  color: var(--vscode-button-foreground);
  background: var(--vscode-button-background);
  font-size: 12px;
}

.copy-button:hover {
  background: var(--vscode-button-hoverBackground);
}

.copy-button--small {
  padding: 3px 7px;
  font-size: 11px;
}

.empty-preview {
  padding: 20px;
  color: var(--vscode-descriptionForeground);
  text-align: center;
}
</style>
