<script setup lang="ts">
import { computed } from 'vue'
import type { SubAgentContextCompactionRecord } from '@shared/subAgentContextCompaction'
import { useI18n } from '../../i18n'

const props = defineProps<{
  record: SubAgentContextCompactionRecord
  variant: 'status' | 'boundary'
}>()

const { t } = useI18n()

function formatTokens(value: number | undefined): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.round(value)).toLocaleString()
    : '—'
}

const iconClass = computed(() => {
  if (props.variant === 'boundary') return 'codicon-fold'
  if (props.record.status === 'running') return 'codicon-sync codicon-modifier-spin'
  if (props.record.status === 'completed') return 'codicon-check'
  return 'codicon-warning'
})

const statusText = computed(() => {
  const record = props.record
  if (props.variant === 'boundary') {
    return t('components.subagents.monitor.compaction.boundary', {
      count: record.summarizedMessageCount ?? 0
    })
  }
  if (record.status === 'running') {
    return t('components.subagents.monitor.compaction.running', {
      before: formatTokens(record.estimatedTokensBefore),
      threshold: formatTokens(record.thresholdTokens)
    })
  }
  if (record.status === 'completed') {
    const after = record.providerPromptTokensAfter ?? record.estimatedTokensAfter
    return t(
      record.providerPromptTokensAfter !== undefined
        ? 'components.subagents.monitor.compaction.completedExact'
        : 'components.subagents.monitor.compaction.completed',
      {
        before: formatTokens(record.estimatedTokensBefore),
        after: formatTokens(after),
        count: record.summarizedMessageCount ?? 0
      }
    )
  }
  if (record.status === 'fallback') {
    return t('components.subagents.monitor.compaction.fallback', {
      before: formatTokens(record.estimatedTokensBefore),
      after: formatTokens(record.providerPromptTokensAfter ?? record.estimatedTokensAfter),
      count: record.summarizedMessageCount ?? 0
    })
  }
  return t('components.subagents.monitor.compaction.failed', {
    error: record.errorMessage || record.errorCode || t('components.subagents.monitor.compaction.unknownError')
  })
})

const titleText = computed(() => {
  const record = props.record
  if (props.variant === 'boundary') return t('components.subagents.monitor.compaction.boundaryTitle')
  if (record.status === 'running') return t('components.subagents.monitor.compaction.runningTitle')
  if (record.status === 'completed') return t('components.subagents.monitor.compaction.completedTitle')
  if (record.status === 'fallback') return t('components.subagents.monitor.compaction.fallbackTitle')
  return t('components.subagents.monitor.compaction.failedTitle')
})
</script>

<template>
  <div
    class="context-compaction"
    :class="[`variant-${variant}`, `status-${record.status}`]"
    role="status"
    :aria-live="record.status === 'running' ? 'polite' : 'off'"
  >
    <span class="codicon compaction-icon" :class="iconClass"></span>
    <div class="compaction-copy">
      <div class="compaction-title">{{ titleText }}</div>
      <div class="compaction-text">{{ statusText }}</div>
      <div v-if="variant === 'status' && record.previousProviderPromptTokens !== undefined" class="compaction-detail">
        {{ t('components.subagents.monitor.compaction.previousProviderTokens', {
          count: formatTokens(record.previousProviderPromptTokens)
        }) }}
      </div>
    </div>
  </div>
</template>

<style scoped>
.context-compaction {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin: 8px 16px;
  padding: 9px 11px;
  border: 1px solid var(--vscode-panel-border);
  border-left: 2px solid var(--vscode-charts-yellow, #ddb92f);
  border-radius: 4px;
  background: var(--vscode-textBlockQuote-background);
  color: var(--vscode-foreground);
}

.variant-boundary {
  margin-block: 10px;
  border-style: dashed;
  background: color-mix(in srgb, var(--vscode-textBlockQuote-background) 65%, transparent);
}

.status-failed,
.status-fallback {
  border-left-color: var(--vscode-editorWarning-foreground, #cca700);
}

.compaction-icon {
  flex: 0 0 auto;
  margin-top: 2px;
  color: var(--vscode-charts-yellow, #ddb92f);
}

.compaction-copy {
  min-width: 0;
}

.compaction-title {
  font-size: 12px;
  font-weight: 600;
}

.compaction-text,
.compaction-detail {
  margin-top: 2px;
  overflow-wrap: anywhere;
  font-size: 11px;
  line-height: 1.45;
  color: var(--vscode-descriptionForeground);
}

.compaction-detail {
  opacity: 0.85;
}
</style>
