<script setup lang="ts">
/**
 * get_symbols 工具内容组件
 * 
 * 显示文件符号列表（支持多文件）
 */

import { computed, ref } from 'vue'
import CustomScrollbar from '../../common/CustomScrollbar.vue'

const props = defineProps<{
  args: Record<string, unknown>
  result?: Record<string, unknown>
  error?: string
  status?: string
  toolId?: string
}>()

interface SymbolInfo {
  name: string
  kind: string
  line: number
  endLine: number
  detail?: string
  children?: SymbolInfo[]
}

interface FileSymbolResult {
  path: string
  success: boolean
  symbolCount?: number
  symbols?: SymbolInfo[]
  error?: string
}

// 获取符号图标
function getSymbolIcon(kind: string): string {
  const iconMap: Record<string, string> = {
    'class': 'codicon-symbol-class',
    'interface': 'codicon-symbol-interface',
    'function': 'codicon-symbol-method',
    'method': 'codicon-symbol-method',
    'constructor': 'codicon-symbol-method',
    'property': 'codicon-symbol-property',
    'field': 'codicon-symbol-field',
    'variable': 'codicon-symbol-variable',
    'constant': 'codicon-symbol-constant',
    'enum': 'codicon-symbol-enum',
    'enum_member': 'codicon-symbol-enum-member',
    'module': 'codicon-symbol-module',
    'namespace': 'codicon-symbol-namespace',
    'struct': 'codicon-symbol-struct',
    'type_parameter': 'codicon-symbol-type-parameter',
  }
  return iconMap[kind] || 'codicon-symbol-misc'
}

// 获取符号颜色类
function getSymbolColorClass(kind: string): string {
  const colorMap: Record<string, string> = {
    'class': 'symbol-class',
    'interface': 'symbol-interface',
    'function': 'symbol-function',
    'method': 'symbol-function',
    'constructor': 'symbol-function',
    'property': 'symbol-property',
    'field': 'symbol-property',
    'variable': 'symbol-variable',
    'constant': 'symbol-constant',
    'enum': 'symbol-enum',
  }
  return colorMap[kind] || ''
}

// 解析结果数据
const resultData = computed(() => {
  if (!props.result?.data) return null
  const data = props.result.data as {
    results?: FileSymbolResult[]
    successCount?: number
    failCount?: number
    totalCount?: number
    totalSymbolCount?: number
  }
  return data
})

// 展开的文件
const expandedFiles = ref<Set<string>>(new Set())

function toggleFile(path: string) {
  if (expandedFiles.value.has(path)) {
    expandedFiles.value.delete(path)
  } else {
    expandedFiles.value.add(path)
  }
}

function isFileExpanded(path: string): boolean {
  return expandedFiles.value.has(path)
}

// 扁平化符号列表（带缩进级别）
interface FlatSymbol extends SymbolInfo {
  level: number
}

function flattenSymbols(symbols: SymbolInfo[], level = 0): FlatSymbol[] {
  const result: FlatSymbol[] = []
  for (const symbol of symbols) {
    result.push({ ...symbol, level })
    if (symbol.children) {
      result.push(...flattenSymbols(symbol.children, level + 1))
    }
  }
  return result
}
</script>

<template>
  <div class="get-symbols-content">
    <!-- 错误显示 -->
    <div v-if="error" class="error-section">
      <span class="codicon codicon-error"></span>
      <span>{{ error }}</span>
    </div>
    
    <!-- 结果列表 -->
    <div v-else-if="resultData" class="results-section">
      <!-- 概要信息 -->
      <div class="summary">
        共 {{ resultData.totalCount }} 个文件，
        {{ resultData.totalSymbolCount }} 个符号
        <span v-if="resultData.failCount && resultData.failCount > 0" class="fail-count">
          （{{ resultData.failCount }} 个失败）
        </span>
      </div>
      
      <!-- 文件列表 -->
      <CustomScrollbar v-if="resultData.results && resultData.results.length > 0" :max-height="400" class="files-list">
        <div 
          v-for="fileResult in resultData.results" 
          :key="fileResult.path" 
          class="file-group"
        >
          <!-- 文件头部 -->
          <div 
            :class="['file-header', { 'has-error': !fileResult.success }]"
            @click="toggleFile(fileResult.path)"
          >
            <span :class="['expand-icon', 'codicon', isFileExpanded(fileResult.path) ? 'codicon-chevron-down' : 'codicon-chevron-right']"></span>
            <span class="codicon codicon-file"></span>
            <span class="file-path">{{ fileResult.path }}</span>
            <span v-if="fileResult.success" class="symbol-count">({{ fileResult.symbolCount }} 符号)</span>
            <span v-else class="error-badge">失败</span>
          </div>
          
          <!-- 符号列表 -->
          <div v-if="isFileExpanded(fileResult.path)" class="symbols-content">
            <!-- 错误信息 -->
            <div v-if="!fileResult.success" class="file-error">
              {{ fileResult.error }}
            </div>
            
            <!-- 符号列表 -->
            <div v-else-if="fileResult.symbols && fileResult.symbols.length > 0" class="symbols-list">
              <div 
                v-for="(symbol, index) in flattenSymbols(fileResult.symbols)" 
                :key="index" 
                class="symbol-item"
                :style="{ paddingLeft: `${symbol.level * 16 + 8}px` }"
              >
                <span :class="['symbol-icon', 'codicon', getSymbolIcon(symbol.kind), getSymbolColorClass(symbol.kind)]"></span>
                <span class="symbol-name">{{ symbol.name }}</span>
                <span class="symbol-kind">({{ symbol.kind }})</span>
                <span class="symbol-line">行 {{ symbol.line }}-{{ symbol.endLine }}</span>
              </div>
            </div>
            
            <!-- 无符号 -->
            <div v-else class="no-symbols">
              未找到符号
            </div>
          </div>
        </div>
      </CustomScrollbar>
    </div>
    
    <!-- 加载中 -->
    <div v-else class="loading">
      正在获取符号...
    </div>
  </div>
</template>

<style scoped>
.get-symbols-content {
  font-size: 12px;
  font-family: var(--gc-font-code);
}

.error-section {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--gc-danger);
  padding: 8px;
  background: var(--gc-danger-bg);
  border-radius: var(--gc-radius-sm);
}

.results-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.summary {
  font-size: 11px;
  color: var(--gc-text-muted);
  padding: 4px 8px;
}

.fail-count {
  color: var(--gc-danger);
}

.files-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.file-group {
  background: var(--gc-surface-base);
  border-radius: var(--gc-radius-xs);
  overflow: hidden;
}

.file-header {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 8px;
  cursor: pointer;
  transition: background 0.1s;
  background: var(--gc-surface-panel);
}

.file-header:hover {
  background: var(--gc-surface-hover);
}

.file-header.has-error {
  background: var(--gc-danger-bg);
}

.expand-icon {
  font-size: 12px;
  color: var(--gc-text-muted);
}

.file-path {
  color: var(--gc-link);
  font-weight: 500;
}

.symbol-count {
  color: var(--gc-text-muted);
  font-size: 11px;
  margin-left: auto;
}

.error-badge {
  color: var(--gc-danger);
  font-size: 10px;
  margin-left: auto;
  padding: 1px 4px;
  background: var(--gc-danger-bg);
  border-radius: var(--gc-radius-xs);
}

.symbols-content {
  border-top: 1px solid var(--gc-border-subtle);
}

.file-error {
  color: var(--gc-danger);
  padding: 8px;
  font-size: 11px;
}

.symbols-list {
  display: flex;
  flex-direction: column;
}

.symbol-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border-bottom: 1px solid var(--gc-border-subtle);
}

.symbol-item:last-child {
  border-bottom: none;
}

.symbol-item:hover {
  background: var(--gc-surface-hover);
}

.symbol-icon {
  font-size: 14px;
  flex-shrink: 0;
}

.symbol-class { color: var(--gc-chart-orange); }
.symbol-interface { color: var(--gc-chart-green); }
.symbol-function { color: var(--gc-chart-purple); }
.symbol-property { color: var(--gc-chart-blue); }
.symbol-variable { color: var(--gc-chart-blue); }
.symbol-constant { color: var(--gc-chart-yellow); }
.symbol-enum { color: var(--gc-chart-orange); }

.symbol-name {
  color: var(--gc-text-primary);
  font-weight: 500;
}

.symbol-kind {
  color: var(--gc-text-muted);
  font-size: 10px;
}

.symbol-line {
  margin-left: auto;
  color: var(--gc-text-muted);
  font-size: 10px;
}

.no-symbols {
  color: var(--gc-text-muted);
  padding: 8px;
  text-align: center;
}

.loading {
  color: var(--gc-text-muted);
  padding: 8px;
  text-align: center;
}
</style>
