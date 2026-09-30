<script setup lang="ts">
/**
 * SummaryBlock - 总结消息展示区块（从 MessageItem.vue 抽出，F-07）。
 * 内部维护展开状态；对外仅接收 content 与被压缩消息计数。
 */
import { ref } from 'vue'
import { MarkdownRenderer } from '../../common'
import { useI18n } from '../../../i18n'

const { t } = useI18n()

defineProps<{
  content: string
  summarizedMessageCount?: number
}>()

const isSummaryExpanded = ref(false)
</script>

<template>
  <div class="summary-block">
    <div
      class="summary-header"
      @click="isSummaryExpanded = !isSummaryExpanded"
    >
      <i class="codicon" :class="isSummaryExpanded ? 'codicon-chevron-down' : 'codicon-chevron-right'"></i>
      <i class="codicon codicon-fold summary-icon"></i>
      <span class="summary-label">{{ t('components.message.summary.title') }}</span>
      <span v-if="summarizedMessageCount" class="summary-count">
        {{ t('components.message.summary.compressed', { count: summarizedMessageCount }) }}
      </span>
    </div>
    <div v-if="isSummaryExpanded" class="summary-content">
      <MarkdownRenderer
        :content="content"
        :latex-only="false"
        class="summary-text"
      />
    </div>
  </div>
</template>

<style scoped>
.summary-block {
  border: 1px solid var(--gc-border-subtle);
  border-radius: var(--gc-radius-sm);
  background: var(--gc-surface-base);
  overflow: hidden;
}

.summary-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 12px;
  cursor: pointer;
  user-select: none;
  transition: background-color 0.15s;
  background: var(--gc-quote-bg);
}

.summary-header:hover {
  background: var(--gc-surface-hover);
}

.summary-header .codicon {
  font-size: 12px;
  color: var(--gc-link);
}

.summary-icon {
  color: var(--gc-link) !important;
}

.summary-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--gc-link);
}

.summary-count {
  font-size: 11px;
  color: var(--gc-text-muted);
  margin-left: 4px;
}

.summary-content {
  padding: 12px;
  border-top: 1px solid var(--gc-border-subtle);
}

.summary-text {
  font-size: 13px;
  color: var(--gc-text-primary);
  line-height: 1.5;
}

.summary-text :deep(p) {
  margin: 0.5em 0;
}

.summary-text :deep(p:first-child) {
  margin-top: 0;
}
</style>
