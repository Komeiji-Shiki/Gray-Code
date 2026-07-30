<script setup lang="ts">
/**
 * MemoryResult — 记忆系列工具的统一结果展示组件
 *
 * 覆盖 memory_wake / memory_note / memory_recall / memory_compress /
 *       memory_zoom / memory_forget / memory_config
 *
 * 展示模型传入的参数（args）和工具返回的文本结果（data.text），
 * 确保用户展开工具卡片后能看到完整的输入和输出。
 */
import { computed } from 'vue'

const props = defineProps<{
  args: Record<string, unknown>
  result?: Record<string, unknown>
  toolName: string
}>()

const isSuccess = computed(() => props.result?.success === true)
const errorMessage = computed(() => props.result?.error as string | undefined)
const data = computed(() => props.result?.data as Record<string, unknown> | undefined)
const textContent = computed(() => data.value?.text as string | undefined)

/** 参数摘要：提取 args 中有意义的字段 */
const paramEntries = computed(() => {
  const a = props.args
  if (!a || Object.keys(a).length === 0) return []
  const entries: { label: string; value: string }[] = []
  // 按工具名称提取关键参数
  for (const [key, val] of Object.entries(a)) {
    if (val === undefined || val === null) continue
    const str = typeof val === 'string' ? val : JSON.stringify(val)
    entries.push({ label: key, value: str })
  }
  return entries
})

/** 记忆块的统计标签 */
const stats = computed(() => {
  const s: { label: string; value: string }[] = []
  const d = data.value
  if (!d) return s

  if (d.totalMemories !== undefined) s.push({ label: 'Memories', value: String(d.totalMemories) })
  if (d.totalHits !== undefined) s.push({ label: 'Hits', value: String(d.totalHits) })
  if (d.truncated) s.push({ label: 'Truncated', value: '⚠' })
  if (d.part !== undefined && d.totalParts !== undefined && Number(d.totalParts) > 1) {
    s.push({ label: 'Part', value: `${d.part}/${d.totalParts}` })
  }
  if (d.id !== undefined) s.push({ label: 'ID', value: `#${d.id}` })
  if (d.awake !== undefined) s.push({ label: 'Awake', value: d.awake ? '✓' : '✗' })
  if (d.removed !== undefined) s.push({ label: 'Removed', value: String(d.removed) })
  if (d.gone !== undefined) s.push({ label: 'Gone', value: String(d.gone) })
  if (d.done !== undefined) s.push({ label: 'Done', value: String(d.done) })
  if (d.message !== undefined) s.push({ label: 'Status', value: truncate(String(d.message), 80) })
  return s
})

/** 工具标题 */
const toolTitle = computed(() => {
  const titles: Record<string, string> = {
    memory_wake: 'Memory Wake',
    memory_note: 'Memory Note',
    memory_recall: 'Memory Recall',
    memory_compress: 'Memory Compress',
    memory_zoom: 'Memory Zoom',
    memory_forget: 'Memory Forget',
    memory_config: 'Memory Config',
  }
  return titles[props.toolName] || props.toolName
})

/** 工具图标 */
const toolIcon = computed(() => {
  const icons: Record<string, string> = {
    memory_wake: 'codicon-bell',
    memory_note: 'codicon-edit',
    memory_recall: 'codicon-search',
    memory_compress: 'codicon-collapse-all',
    memory_zoom: 'codicon-zoom-in',
    memory_forget: 'codicon-trash',
    memory_config: 'codicon-settings-gear',
  }
  return icons[props.toolName] || 'codicon-database'
})

/** 记忆块行样式：区分原始记忆（#N）和摘要（#N-M） */
function getBlockClass(line: string): string {
  if (/^#\d+ /.test(line)) return 'raw-block'
  if (/^#\d+-\d+ /.test(line)) return 'summary-block'
  if (line.startsWith('You are awake')) return 'awake-line'
  if (line.startsWith('No memories yet')) return 'empty-line'
  if (line.startsWith('No match')) return 'empty-line'
  return ''
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max) + '…'
}
</script>

<template>
  <div class="memory-result">
    <!-- 等待结果 -->
    <div v-if="!result" class="section pending">
      <div class="section-title">
        <i class="codicon codicon-loading codicon-modifier-spin"></i>
        {{ toolTitle }}…
      </div>
    </div>

    <!-- 错误 -->
    <div v-else-if="!isSuccess" class="section error">
      <div class="section-title">
        <i class="codicon codicon-error"></i>
        {{ toolTitle }} failed
      </div>
      <div v-if="errorMessage" class="error-detail">{{ errorMessage }}</div>
    </div>

    <!-- 成功 -->
    <div v-else class="section success">
      <!-- 头部统计 -->
      <div class="result-header">
        <i :class="['codicon', toolIcon]"></i>
        <span class="header-title">{{ toolTitle }}</span>
        <span v-if="stats.length > 0" class="header-stats">
          <span v-for="s in stats" :key="s.label" class="stat-tag">
            <span class="stat-label">{{ s.label }}</span>
            <span class="stat-value">{{ s.value }}</span>
          </span>
        </span>
      </div>

      <!-- 模型传入参数 -->
      <div v-if="paramEntries.length > 0" class="args-section">
        <div class="args-header">
          <i class="codicon codicon-arrow-small-right"></i>
          <span>Parameters</span>
        </div>
        <div class="args-body">
          <div v-for="p in paramEntries" :key="p.label" class="arg-row">
            <span class="arg-label">{{ p.label }}</span>
            <pre class="arg-value">{{ p.value }}</pre>
          </div>
        </div>
      </div>

      <!-- 返回文本内容 -->
      <div v-if="textContent" class="result-body">
        <div class="result-body-header">
          <i class="codicon codicon-output"></i>
          <span>Result</span>
        </div>
        <pre class="memory-text"><code><template v-for="(line, i) in textContent.split('\n')" :key="i"><span :class="getBlockClass(line)">{{ line }}</span>
</template></code></pre>
      </div>
    </div>
  </div>
</template>

<style scoped>
.memory-result {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 4px 0;
}

.section {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.section-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 500;
}

.section.success .section-title { color: var(--vscode-terminal-ansiGreen); }
.section.error .section-title   { color: var(--vscode-errorForeground); }
.section.pending .section-title { color: var(--vscode-descriptionForeground); }

.result-header {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 6px 10px;
  background: var(--vscode-editor-background);
  border-radius: 4px;
  border-left: 3px solid var(--vscode-terminal-ansiGreen);
}

.header-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--vscode-foreground);
}

.header-stats {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
  margin-left: auto;
}

.stat-tag {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 1px 6px;
  border-radius: 3px;
  background: var(--vscode-badge-background);
  font-size: 10px;
  line-height: 1.4;
}

.stat-label {
  color: var(--vscode-badge-foreground);
  opacity: 0.7;
}

.stat-value {
  color: var(--vscode-badge-foreground);
  font-weight: 600;
  font-family: var(--vscode-editor-font-family), monospace;
}

/* ——— 参数区域 ——— */
.args-section {
  padding: 6px 10px;
  background: var(--vscode-editor-background);
  border-radius: 4px;
}

.args-header {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-bottom: 6px;
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.4px;
  color: var(--vscode-descriptionForeground);
}

.args-body {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.arg-row {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.arg-label {
  font-size: 10px;
  font-weight: 500;
  color: var(--vscode-charts-blue);
}

.arg-value {
  margin: 0;
  padding: 4px 8px;
  background: var(--vscode-editor-inactiveSelectionBackground);
  border: 1px solid var(--vscode-panel-border);
  border-radius: 2px;
  font-family: var(--vscode-editor-font-family), monospace;
  font-size: 11px;
  line-height: 1.45;
  color: var(--vscode-foreground);
  white-space: pre-wrap;
  word-break: break-word;
}

/* ——— 结果文本区域 ——— */
.result-body {
  padding: 8px 10px;
  background: var(--vscode-editor-background);
  border-radius: 4px;
}

.result-body-header {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-bottom: 6px;
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.4px;
  color: var(--vscode-descriptionForeground);
}

.memory-text {
  margin: 0;
  font-family: var(--vscode-editor-font-family), 'Cascadia Code', 'Fira Code', 'JetBrains Mono', monospace;
  font-size: 11px;
  line-height: 1.55;
  color: var(--vscode-foreground);
  white-space: pre;
  tab-size: 2;
}

.memory-text code {
  font-family: inherit;
  font-size: inherit;
  color: inherit;
}

/* 记忆块样式 */
.raw-block {
  color: var(--vscode-terminal-ansiCyan);
}

.summary-block {
  color: var(--vscode-terminal-ansiYellow);
  opacity: 0.85;
}

.awake-line {
  color: var(--vscode-terminal-ansiGreen);
  font-weight: 600;
}

.empty-line {
  color: var(--vscode-descriptionForeground);
  font-style: italic;
}

.error-detail {
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  padding: 4px 10px;
}
</style>
