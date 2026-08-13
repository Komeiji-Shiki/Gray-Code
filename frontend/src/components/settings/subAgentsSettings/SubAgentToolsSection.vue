<script setup lang="ts">
/**
 * SubAgentToolsSection - 子代理「工具配置」区块
 *
 * 从 SubAgentsSettings.vue 模板拆分（S7 批次，纯结构性拆分，行为零变化）：
 * - 工具列表渲染与选中回调均由父组件注入；本地只保留纯展示/纯函数（MCP 识别、本地化）。
 */
import { useI18n } from '@/i18n'
import { CustomCheckbox, CustomSelect, type SelectOption } from '../../common'
import { getToolDisplayName, getToolDescription } from '@/utils/toolLocalization'
import { getCategoryName, getCategoryIcon } from '@/utils/toolCategory'
import { isMcpToolName } from '@/utils/tools/mcp/mcpToolNameCodec'
import type { SubAgentConfig, SubAgentToolsConfig } from '@/types/settingsConfig'
import type { ToolInfo } from './types'

const props = defineProps<{
  agent: SubAgentConfig
  toolModeOptions: SelectOption[]
  toolsByCategory: Record<string, ToolInfo[]>
  allTools: ToolInfo[]
  isToolSelected: (toolName: string) => boolean
  onUpdateTools: (tools: SubAgentToolsConfig) => void
  onToggleTool: (toolName: string, selected: boolean) => void
}>()

const { t } = useI18n()

// 判断是否为 MCP 工具（category 标记或编码名前缀均可识别）
function isMcpTool(tool: ToolInfo): boolean {
  return tool.category === 'mcp' || isMcpToolName(tool.name)
}

// 工具模式变更：保持原 { ...tools, mode } 字段级合并语义
function handleModeChange(mode: string) {
  props.onUpdateTools({ ...props.agent.tools, mode: mode as SubAgentToolsConfig['mode'] })
}
</script>

<template>
  <div class="config-section" data-search-anchor="subagents-tools">
    <h5>{{ t('components.settings.subagents.tools') }}</h5>
    <p class="section-description">{{ t('components.settings.subagents.toolsDescription') }}</p>

    <!-- 工具模式选择 -->
    <div class="form-group">
      <label>{{ t('components.settings.subagents.toolMode.label') }}</label>
      <CustomSelect
        :modelValue="agent.tools.mode"
        :options="toolModeOptions"
        @update:modelValue="handleModeChange"
      />
    </div>

    <!-- 工具列表（白名单/黑名单模式） -->
    <div
      v-if="agent.tools.mode === 'whitelist' || agent.tools.mode === 'blacklist'"
      class="tools-list"
    >
      <!-- 模式说明 -->
      <div class="tools-mode-hint">
        <i class="codicon codicon-info"></i>
        <span v-if="agent.tools.mode === 'whitelist'">{{ t('components.settings.subagents.whitelistHint') }}</span>
        <span v-else>{{ t('components.settings.subagents.blacklistHint') }}</span>
      </div>

      <!-- 按分类分组的工具列表 -->
      <div v-for="(categoryTools, category) in toolsByCategory" :key="category" class="tool-category">
        <div class="category-header">
          <i :class="['codicon', getCategoryIcon(category)]"></i>
          <span>{{ getCategoryName(category) }}</span>
          <span class="tool-count">{{ categoryTools.length }}</span>
        </div>
        <div class="tool-items">
          <div v-for="tool in categoryTools" :key="tool.name" class="tool-item" :title="getToolDescription(tool.name, tool.description)">
            <div class="tool-info">
              <div class="tool-name-row">
                <span class="tool-name" :title="isMcpTool(tool) ? tool.name : undefined">{{ getToolDisplayName(tool.name) }}</span>
                <span v-if="isMcpTool(tool)" class="mcp-badge">
                  <i class="codicon codicon-plug"></i>
                  {{ tool.serverName }}
                </span>
                <span v-if="!isMcpTool(tool)" class="tool-id">{{ tool.name }}</span>
              </div>
              <div class="tool-description">{{ getToolDescription(tool.name, tool.description) }}</div>
            </div>
            <CustomCheckbox
              :modelValue="isToolSelected(tool.name)"
              @update:modelValue="onToggleTool(tool.name, $event)"
            />
          </div>
        </div>
      </div>

      <!-- 空工具列表 -->
      <div v-if="allTools.length === 0" class="no-tools">
        <i class="codicon codicon-info"></i>
        <span>{{ t('components.settings.subagents.noTools') }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.config-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.config-section h5 {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--vscode-foreground);
}

.section-description {
  margin: 0;
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
}

.form-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.form-group label {
  font-size: 12px;
  color: var(--vscode-foreground);
}

/* 工具列表 */
.tools-list {
  display: flex;
  flex-direction: column;
  gap: 16px;
  margin-top: 12px;
  padding: 12px;
  background: var(--vscode-editor-background);
  border: 1px solid var(--vscode-widget-border);
  border-radius: 6px;
}

.tools-mode-hint {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: var(--vscode-textBlockQuote-background);
  border-left: 3px solid var(--vscode-textLink-foreground);
  border-radius: 0 4px 4px 0;
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
}

.tools-mode-hint i {
  color: var(--vscode-textLink-foreground);
}

.tool-category {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.category-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--vscode-foreground);
  border-bottom: 1px solid var(--vscode-widget-border);
}

.category-header i {
  font-size: 14px;
  color: var(--vscode-descriptionForeground);
}

.tool-count {
  margin-left: auto;
  padding: 2px 6px;
  background: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
  border-radius: 10px;
  font-size: 11px;
  font-weight: normal;
}

.tool-items {
  display: flex;
  flex-direction: column;
  gap: 2px;
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
  transition: background 0.15s;
}

.tool-item:hover {
  background: var(--vscode-list-hoverBackground);
}

.tool-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  min-width: 0;
}

.tool-name-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.tool-name {
  min-width: 0;
  overflow: hidden;
  font-size: 13px;
  font-weight: 600;
  color: var(--vscode-foreground);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tool-id {
  overflow: hidden;
  font-family: var(--vscode-editor-font-family), monospace;
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mcp-badge {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 2px 6px;
  background: rgba(var(--vscode-textLink-foreground), 0.1);
  color: var(--vscode-textLink-foreground);
  border: 1px solid var(--vscode-textLink-foreground);
  border-radius: 4px;
  font-size: 10px;
  opacity: 0.8;
  flex-shrink: 0;
}

.mcp-badge .codicon {
  font-size: 10px;
}

.tool-description {
  overflow: hidden;
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.no-tools {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 16px;
  color: var(--vscode-descriptionForeground);
  font-size: 12px;
}
</style>
