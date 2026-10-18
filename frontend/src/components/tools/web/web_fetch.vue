<script setup lang="ts">
/**
 * web_fetch 工具的内容面板
 *
 * 显示页面标题、地址、正文长度与 Markdown 正文预览。
 */

import { computed } from 'vue'
import { useI18n } from '../../../composables/useI18n'

interface FetchData {
  url?: string
  title?: string
  content?: string
  contentLength?: number
  truncated?: boolean
}

const { t } = useI18n()

const props = defineProps<{
  args: Record<string, unknown>
  result?: Record<string, unknown>
  error?: string
}>()

const data = computed(() => props.result?.data as FetchData | undefined)
const url = computed(() => data.value?.url || (typeof props.args.url === 'string' ? props.args.url : ''))
const resultError = computed(() => props.error || (typeof props.result?.error === 'string' ? props.result.error : ''))
const content = computed(() => data.value?.content || '')
const contentLength = computed(() => data.value?.contentLength ?? content.value.length)

function link(value?: string): string | undefined {
  return value && /^https?:\/\//i.test(value) ? value : undefined
}

function host(value?: string): string {
  if (!value) return ''
  try {
    return new URL(value).host
  } catch {
    return value
  }
}
</script>

<template>
  <div class="web-fetch-result">
    <div class="fetch-summary">
      <i class="codicon codicon-file-text"></i>
      <a
        v-if="link(url)"
        class="fetch-title"
        :href="link(url)"
        target="_blank"
        rel="noopener noreferrer"
      >{{ data?.title || host(url) || url }}</a>
      <span v-else class="fetch-title">{{ data?.title || host(url) || url }}</span>
      <span v-if="data" class="fetch-count">{{ t('components.tools.webFetch.contentLength', { count: contentLength }) }}</span>
    </div>

    <div v-if="resultError" class="fetch-error">
      <i class="codicon codicon-error"></i>
      <span>{{ resultError }}</span>
    </div>

    <template v-else-if="content">
      <div v-if="data?.truncated" class="fetch-truncated">
        <i class="codicon codicon-warning"></i>
        <span>{{ t('components.tools.webFetch.truncated', { count: contentLength }) }}</span>
      </div>
      <pre class="fetch-content">{{ content }}</pre>
    </template>

    <div v-else-if="props.result" class="fetch-empty">
      <i class="codicon codicon-info"></i>
      <span>{{ t('components.tools.webFetch.empty') }}</span>
    </div>
  </div>
</template>

<style scoped>
.web-fetch-result {
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-size: 12px;
}

.fetch-summary {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  color: var(--gc-text-secondary);
}

.fetch-summary .codicon {
  color: var(--gc-chart-blue);
}

.fetch-title {
  overflow: hidden;
  font-weight: 500;
  color: var(--gc-text-primary);
  text-overflow: ellipsis;
  white-space: nowrap;
  text-decoration: none;
}

a.fetch-title:hover {
  color: var(--gc-accent);
  text-decoration: underline;
}

.fetch-count {
  flex: none;
  color: var(--gc-text-muted);
}

.fetch-error,
.fetch-truncated {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  line-height: 1.6;
}

.fetch-error {
  color: var(--gc-danger);
}

.fetch-truncated {
  color: var(--gc-warning);
}

.fetch-content {
  max-height: 360px;
  margin: 0;
  padding: 8px 10px;
  overflow: auto;
  color: var(--gc-text-secondary);
  background: var(--gc-surface-muted);
  border-left: 2px solid var(--gc-border-subtle);
  font-family: var(--gc-font-code), monospace;
  font-size: 11px;
  line-height: 1.65;
  white-space: pre-wrap;
  word-break: break-word;
}

.fetch-empty {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--gc-text-muted);
}
</style>
