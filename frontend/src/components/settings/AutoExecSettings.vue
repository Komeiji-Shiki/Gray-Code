<script setup lang="ts">
/**
 * AutoExecSettings - 自动执行设置面板
 *
 * 功能：
 * 1. 显示所有可用工具列表
 * 2. 允许配置每个工具是否自动执行（无需用户确认）
 * 3. 默认情况下，危险工具（如 delete_file, execute_command）需要确认
 */

import { ref, computed, onMounted } from 'vue'
import { CustomCheckbox } from '../common'
import { sendToExtension } from '@/utils/vscode'
import { t } from '@/i18n'
import { decodeMcpToolName } from '@/utils/tools/mcp/mcpToolNameCodec'

// 工具信息接口
interface ToolInfo {
  name: string
  description: string
  enabled: boolean
  category?: string
  serverId?: string
  serverName?: string
}

// 工具自动执行配置
interface ToolAutoExecConfig {
  [toolName: string]: boolean
}

// 工具列表
const tools = ref<ToolInfo[]>([])

// 自动执行配置
const autoExecConfig = ref<ToolAutoExecConfig>({})

// 加载状态
const isLoading = ref(false)

// 保存状态
const savingTools = ref<Set<string>>(new Set())

// 按分类分组的工具
const toolsByCategory = computed(() => {
  const grouped: Record<string, ToolInfo[]> = {}
  
  for (const tool of tools.value) {
    const category = tool.category || '其他'
    if (!grouped[category]) {
      grouped[category] = []
    }
    grouped[category].push(tool)
  }
  
  return grouped
})

// 获取分类显示名称
function getCategoryDisplayName(category: string): string {
  const key = `components.settings.autoExec.categories.${category}` as const
  return t(key)
}

// 分类图标映射
const categoryIcons: Record<string, string> = {
  'file': 'codicon-file',
  'search': 'codicon-search',
  'terminal': 'codicon-terminal',
  'lsp': 'codicon-symbol-class',
  'media': 'codicon-file-media',
  'plan': 'codicon-notebook',
  'mcp': 'codicon-plug',
  'todo': 'codicon-checklist',
  'history': 'codicon-history',
  'memory': 'codicon-database',
  'review': 'codicon-eye',
  'progress': 'codicon-graph-line',
  'skills': 'codicon-lightbulb',
  'design': 'codicon-paintcan',
  'notification': 'codicon-bell',
  'agents': 'codicon-account',
  '其他': 'codicon-extensions',
  'other': 'codicon-extensions'
}

// 加载工具列表和配置
async function loadData() {
  isLoading.value = true
  
  try {
    // 获取内置工具列表
    const toolsResponse = await sendToExtension<{ tools: ToolInfo[] }>('tools.getTools', {})
    let allTools: ToolInfo[] = []
    if (toolsResponse?.tools) {
      allTools = toolsResponse.tools
    }
    
    // 获取 MCP 工具列表
    try {
      const mcpToolsResponse = await sendToExtension<{ tools: ToolInfo[] }>('tools.getMcpTools', {})
      if (mcpToolsResponse?.tools) {
        allTools = [...allTools, ...mcpToolsResponse.tools]
      }
    } catch (mcpError) {
      console.warn('Failed to load MCP tools:', mcpError)
    }
    
    tools.value = allTools
    
    // 获取自动执行配置
    const configResponse = await sendToExtension<{ config: ToolAutoExecConfig }>('tools.getAutoExecConfig', {})
    if (configResponse?.config) {
      autoExecConfig.value = configResponse.config
    }
  } catch (error) {
    console.error('Failed to load data:', error)
  } finally {
    isLoading.value = false
  }
}

// 检查工具是否自动执行
function isAutoExec(toolName: string): boolean {
  // 如果未配置，默认自动执行
  if (autoExecConfig.value[toolName] === undefined) {
    return true
  }
  return autoExecConfig.value[toolName]
}

// 切换工具自动执行状态
async function toggleAutoExec(toolName: string, autoExec: boolean) {
  savingTools.value.add(toolName)
  
  try {
    await sendToExtension('tools.setToolAutoExec', {
      toolName,
      autoExec
    })
    
    // 更新本地状态
    autoExecConfig.value[toolName] = autoExec
  } catch (error) {
    console.error(`Failed to toggle auto exec for ${toolName}:`, error)
    // 保存失败：恢复原勾选状态（读当前派生值回写，强制受控勾选框回滚到保存前状态）
    autoExecConfig.value[toolName] = isAutoExec(toolName)
  } finally {
    savingTools.value.delete(toolName)
  }
}

// 全部自动执行（Diff 审阅类工具不受本页控制，跳过）
async function enableAllAutoExec() {
  for (const tool of tools.value) {
    if (isDiffReviewTool(tool.name)) {
      continue
    }
    if (!isAutoExec(tool.name)) {
      await toggleAutoExec(tool.name, true)
    }
  }
}

// 全部需要确认（Diff 审阅类工具不受本页控制，跳过）
async function disableAllAutoExec() {
  for (const tool of tools.value) {
    if (isDiffReviewTool(tool.name)) {
      continue
    }
    if (isAutoExec(tool.name)) {
      await toggleAutoExec(tool.name, false)
    }
  }
}

// 获取工具显示名称（优先 i18n，fallback 机械转换）
function getToolDisplayName(tool: ToolInfo): string {
  // 如果是 MCP 工具，提取原始工具名（codec 解码，serverId/toolName 含下划线也能正确解析）
  if (isMcpTool(tool)) {
    const decoded = decodeMcpToolName(tool.name)
    if (decoded) {
      return decoded.toolName.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
    }
  }
  const i18nKey = `components.settings.toolsSettings.toolDisplayNames.${tool.name}`
  const translated = t(i18nKey)
  if (translated !== i18nKey) return translated
  return tool.name.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

// 获取工具描述（优先 i18n，fallback 后端原文）
function getToolDescription(tool: ToolInfo): string {
  if (tool.category === 'mcp') return tool.description
  const i18nKey = `components.settings.toolsSettings.toolDescriptions.${tool.name}`
  const translated = t(i18nKey)
  if (translated !== i18nKey) return translated
  return tool.description
}

// 获取分类图标
function getCategoryIcon(category: string): string {
  return categoryIcons[category] || 'codicon-extensions'
}

// 检查工具是否是危险工具（默认需要确认）
function isDangerousTool(toolName: string): boolean {
  const dangerousTools = ['delete_file', 'execute_command', 'create_plan']
  return dangerousTools.includes(toolName)
}

// Diff 审阅类工具：确认行为由 Diff 审阅机制管理（Apply Diff 工具设置中的“自动应用”），
// 本页的勾选对它们不生效。与后端 services/diffReviewTools.ts 的 DIFF_REVIEW_TOOL_NAMES 保持一致。
const DIFF_REVIEW_TOOLS = new Set(['write_file', 'apply_diff', 'insert_code', 'delete_code'])

function isDiffReviewTool(toolName: string): boolean {
  return DIFF_REVIEW_TOOLS.has(toolName)
}

// 检查工具是否是 MCP 工具
function isMcpTool(tool: ToolInfo): boolean {
  return tool.category === 'mcp'
}

// 组件挂载
onMounted(() => {
  loadData()
})
</script>

<template>
  <div class="auto-exec-settings">
    <!-- 说明文字 -->
    <div class="settings-intro" data-search-anchor="auto-exec-intro">
      <i class="codicon codicon-shield"></i>
      <div class="intro-content">
        <p class="intro-title">{{ t('components.settings.autoExec.intro.title') }}</p>
        <p class="intro-desc">{{ t('components.settings.autoExec.intro.description') }}</p>
      </div>
    </div>
    
    <!-- 操作按钮 -->
    <div class="auto-exec-actions">
      <button class="action-btn" @click="loadData" :disabled="isLoading">
        <i class="codicon" :class="isLoading ? 'codicon-loading codicon-modifier-spin' : 'codicon-refresh'"></i>
        {{ t('components.settings.autoExec.actions.refresh') }}
      </button>
      <button class="action-btn" @click="enableAllAutoExec">
        <i class="codicon codicon-check-all"></i>
        {{ t('components.settings.autoExec.actions.enableAll') }}
      </button>
      <button class="action-btn" @click="disableAllAutoExec">
        <i class="codicon codicon-shield"></i>
        {{ t('components.settings.autoExec.actions.disableAll') }}
      </button>
    </div>
    
    <!-- 加载状态 -->
    <div v-if="isLoading" class="loading-state">
      <i class="codicon codicon-loading codicon-modifier-spin"></i>
      <span>{{ t('components.settings.autoExec.status.loading') }}</span>
    </div>
    
    <!-- 空状态 -->
    <div v-else-if="tools.length === 0" class="empty-state">
      <i class="codicon codicon-tools"></i>
      <span>{{ t('components.settings.autoExec.status.empty') }}</span>
    </div>
    
    <!-- 工具列表 -->
    <div v-else class="tools-list" data-search-anchor="auto-exec-list">
      <div 
        v-for="(categoryTools, category) in toolsByCategory" 
        :key="category"
        class="tool-category"
      >
        <div class="category-header">
          <i :class="['codicon', getCategoryIcon(category)]"></i>
          <span>{{ getCategoryDisplayName(category) }}</span>
          <span class="category-count">{{ categoryTools.length }}</span>
        </div>
        
        <div class="category-tools">
          <div
            v-for="tool in categoryTools"
            :key="tool.name"
            class="tool-item"
            :class="{ dangerous: isDangerousTool(tool.name), 'mcp-tool': isMcpTool(tool) }"
          >
            <div class="tool-info">
              <div class="tool-name-row">
                <span class="tool-name">{{ getToolDisplayName(tool) }}</span>
                <span v-if="isDangerousTool(tool.name)" class="danger-badge">
                  <i class="codicon codicon-warning"></i>
                  {{ t('components.settings.autoExec.badges.dangerous') }}
                </span>
                <span v-if="isMcpTool(tool)" class="mcp-badge">
                  <i class="codicon codicon-plug"></i>
                  {{ tool.serverName }}
                </span>
              </div>
              <div class="tool-description">{{ getToolDescription(tool) }}</div>
            </div>
            
            <!-- Diff 审阅类工具：显示真实生效状态而非误导性勾选框 -->
            <div v-if="isDiffReviewTool(tool.name)" class="tool-toggle">
              <span class="diff-review-badge" :title="t('components.settings.autoExec.diffReview.tooltip')">
                <i class="codicon codicon-git-compare"></i>
                {{ t('components.settings.autoExec.diffReview.label') }}
              </span>
            </div>
            <div v-else class="tool-toggle" :class="{ saving: savingTools.has(tool.name) }">
              <span class="toggle-label" :class="{ 'auto-exec': isAutoExec(tool.name) }">
                {{ isAutoExec(tool.name) ? t('components.settings.autoExec.status.autoExecute') : t('components.settings.autoExec.status.needConfirm') }}
              </span>
              <CustomCheckbox
                :modelValue="isAutoExec(tool.name)"
                :disabled="savingTools.has(tool.name)"
                @update:modelValue="(val: boolean) => toggleAutoExec(tool.name, val)"
              />
            </div>
          </div>
        </div>
      </div>
    </div>
    
    <!-- 提示信息 -->
    <div class="settings-tips" data-search-anchor="auto-exec-tips">
      <i class="codicon codicon-info"></i>
      <div class="tips-content">
        <p>{{ t('components.settings.autoExec.tips.diffReviewNote') }}</p>
        <p>{{ t('components.settings.autoExec.tips.dangerousDefault') }}</p>
        <p>{{ t('components.settings.autoExec.tips.deleteFileWarning') }}</p>
        <p>{{ t('components.settings.autoExec.tips.executeCommandWarning') }}</p>
        <p>{{ t('components.settings.autoExec.tips.mcpToolsDefault') }}</p>
        <p>{{ t('components.settings.autoExec.tips.useWithCheckpoint') }}</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.auto-exec-settings {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* 介绍区域 */
.settings-intro {
  display: flex;
  gap: 12px;
  padding: 12px;
  background: var(--vscode-editor-background);
  border: 1px solid var(--vscode-panel-border);
  border-radius: 6px;
}

.settings-intro .codicon {
  font-size: 24px;
  color: var(--vscode-textLink-foreground);
  flex-shrink: 0;
}

.intro-content {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.intro-title {
  margin: 0;
  font-size: 13px;
  font-weight: 500;
  color: var(--vscode-foreground);
}

.intro-desc {
  margin: 0;
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
  line-height: 1.4;
}

/* 操作按钮 */
.auto-exec-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.action-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
  border: none;
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
  transition: background-color 0.15s;
}

.action-btn:hover:not(:disabled) {
  background: var(--vscode-button-secondaryHoverBackground);
}

.action-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.action-btn .codicon {
  font-size: 14px;
}

/* 加载和空状态 */
.loading-state,
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 32px;
  color: var(--vscode-descriptionForeground);
}

.loading-state .codicon,
.empty-state .codicon {
  font-size: 24px;
}

/* 工具列表 */
.tools-list {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* 分类 */
.tool-category {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.category-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: var(--vscode-editor-background);
  border: 1px solid var(--vscode-panel-border);
  border-radius: 4px;
  font-size: 13px;
  font-weight: 500;
}

.category-header .codicon {
  font-size: 14px;
  color: var(--vscode-foreground);
}

.category-count {
  margin-left: auto;
  padding: 2px 8px;
  background: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
  border-radius: 10px;
  font-size: 11px;
  font-weight: 500;
}

/* 工具项 */
.category-tools {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-left: 12px;
}

.tool-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  background: var(--vscode-editor-background);
  border: 1px solid var(--vscode-panel-border);
  border-radius: 4px;
  transition: background-color 0.15s;
}

.tool-item:hover {
  background: var(--vscode-list-hoverBackground);
}

.tool-item.dangerous {
  border-left: 3px solid var(--vscode-inputValidation-warningBorder);
}

.tool-info {
  flex: 1;
  min-width: 0;
}

.tool-name-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.tool-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--vscode-foreground);
}

.danger-badge {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 2px 6px;
  background: var(--vscode-inputValidation-warningBackground);
  color: var(--vscode-inputValidation-warningForeground);
  border: 1px solid var(--vscode-inputValidation-warningBorder);
  border-radius: 4px;
  font-size: 10px;
}

.danger-badge .codicon {
  font-size: 10px;
}

.mcp-badge {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 2px 6px;
  background: var(--vscode-textLink-activeForeground);
  background: rgba(var(--vscode-textLink-foreground), 0.1);
  color: var(--vscode-textLink-foreground);
  border: 1px solid var(--vscode-textLink-foreground);
  border-radius: 4px;
  font-size: 10px;
  opacity: 0.8;
}

.mcp-badge .codicon {
  font-size: 10px;
}

.tool-item.mcp-tool {
  border-left: 3px solid var(--vscode-textLink-foreground);
}

.tool-description {
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  margin-top: 2px;
  white-space: pre-wrap;
  word-break: break-word;
  overflow-wrap: anywhere;
}

/* 工具操作区 */
.tool-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.tool-toggle.saving {
  opacity: 0.6;
  pointer-events: none;
}

.toggle-label {
  font-size: 11px;
  color: var(--vscode-errorForeground);
  min-width: 50px;
  text-align: right;
}

.toggle-label.auto-exec {
  color: var(--vscode-terminal-ansiGreen);
}

/* Diff 审阅类工具的状态徽标 */
.diff-review-badge {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  background: var(--vscode-textBlockQuote-background);
  color: var(--vscode-textLink-foreground);
  border: 1px solid var(--vscode-textLink-foreground);
  border-radius: 4px;
  font-size: 11px;
  cursor: help;
  white-space: nowrap;
}

.diff-review-badge .codicon {
  font-size: 12px;
}

/* 提示信息 */
.settings-tips {
  display: flex;
  gap: 8px;
  padding: 8px 10px;
  background: var(--vscode-textBlockQuote-background);
  border-left: 3px solid var(--vscode-textLink-foreground);
  border-radius: 0 4px 4px 0;
}

.settings-tips .codicon {
  flex-shrink: 0;
  color: var(--vscode-textLink-foreground);
  font-size: 14px;
}

.tips-content {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.tips-content p {
  margin: 0;
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  line-height: 1.4;
}

/* Loading 动画 */
.codicon-modifier-spin {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
</style>