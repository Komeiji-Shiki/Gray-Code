<script setup lang="ts">
/**
 * web_search 工具的内容面板
 *
 * 显示查询词、结果统计和每条结果的标题、来源与摘要。
 */

import { computed } from 'vue'
import { useI18n } from '../../../composables/useI18n'

interface SearchItem {
  title?: string
  url?: string
  snippet?: string
  summary?: string
  content?: string
  siteName?: string
  date?: string
  authority?: number
}

interface SearchData {
  query?: string
  resultCount?: number
  needContent?: boolean
  results?: SearchItem[]
  contentTruncated?: boolean
}

const { t } = useI18n()

const props = defineProps<{
  args: Record<string, unknown>
  result?: Record<string, unknown>
  error?: string
}>()

const query = computed(() => {
  const value = props.result?.data as SearchData | undefined
  return value?.query || (typeof props.args.query === 'string' ? props.args.query : '')
})

const data = computed(() => props.result?.data as SearchData | undefined)
const results = computed(() => Array.isArray(data.value?.results) ? data.value.results : [])
const resultError = computed(() => props.error || (typeof props.result?.error === 'string' ? props.result.error : ''))

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

function date(value?: string): string {
  if (!value) return ''
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleDateString()
}

function authorityLabel(value?: number): string {
  if (value === undefined) return ''
  if (value < 0) return ''
  return t('components.tools.webSearch.authority', { level: value })
}
</script>

<template>
  <div class="web-search-result">
    <div class="search-summary">
      <i class="codicon codicon-globe"></i>
      <span class="search-query">{{ query }}</span>
      <span v-if="data" class="search-count">
        {{ t('components.tools.webSearch.resultCount', { count: data.resultCount ?? results.length }) }}
      </span>
    </div>

    <div v-if="resultError" class="search-error">
      <i class="codicon codicon-error"></i>
      <span>{{ resultError }}</span>
    </div>

    <ol v-else-if="results.length" class="result-list">
      <li v-for="(item, index) in results" :key="item.url || index" class="result-item">
        <a
          v-if="link(item.url)"
          class="result-title"
          :href="link(item.url)"
          target="_blank"
          rel="noopener noreferrer"
        >{{ item.title || item.url }}</a>
        <span v-else class="result-title">{{ item.title || item.url }}</span>

        <div class="result-meta">
          <span v-if="item.siteName || item.url" class="result-source">{{ item.siteName || host(item.url) }}</span>
          <span v-if="item.date" class="result-date">{{ date(item.date) }}</span>
          <span v-if="authorityLabel(item.authority)" class="result-authority">{{ authorityLabel(item.authority) }}</span>
        </div>

        <p v-if="item.snippet" class="result-snippet">{{ item.snippet }}</p>
        <p v-else-if="item.summary" class="result-snippet">{{ item.summary }}</p>
      </li>
    </ol>

    <div v-else-if="!resultError && props.result" class="search-empty">
      <i class="codicon codicon-info"></i>
      <span>{{ t('components.tools.webSearch.empty') }}</span>
    </div>
  </div>
</template>

<style scoped>
.web-search-result {
  display: flex;
  flex-direction: column;
  gap: 10px;
  font-size: 12px;
}

.search-summary {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  color: var(--gc-text-secondary);
}

.search-summary .codicon {
  color: var(--gc-chart-blue);
}

.search-query {
  overflow: hidden;
  font-weight: 500;
  color: var(--gc-text-primary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.search-count {
  flex: none;
  color: var(--gc-text-muted);
}

.search-error {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  line-height: 1.6;
  color: var(--gc-danger);
}

.result-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.result-item {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding-left: 10px;
  border-left: 2px solid var(--gc-border-subtle);
}

.result-title {
  color: var(--gc-text-primary);
  font-weight: 500;
  line-height: 1.5;
  text-decoration: none;
}

a.result-title:hover {
  color: var(--gc-accent);
  text-decoration: underline;
}

.result-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  color: var(--gc-text-muted);
  font-size: 11px;
}

.result-snippet {
  margin: 0;
  color: var(--gc-text-secondary);
  line-height: 1.65;
  white-space: pre-wrap;
  word-break: break-word;
}

.search-empty {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--gc-text-muted);
}
</style>
