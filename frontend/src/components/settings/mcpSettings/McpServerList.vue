<script setup lang="ts">
/**
 * McpServerList - MCP 服务器列表视图（工具栏 + 服务器卡片列表）
 *
 * 从 McpSettings.vue 模板拆分（纯结构性拆分，行为零变化）：
 * - 纯展示组件：服务器列表 / 加载态 / 连接错误由父组件注入，自身不持有业务状态；
 * - 仅内聚纯展示逻辑：状态颜色 / 状态文案 / 本地 connecting 叠加状态。
 */
import { CustomCheckbox } from '../../common'
import { useI18n } from '@/i18n'
import type { McpServerInfo, McpServerStatus } from '@/types'

const { t } = useI18n()

const props = defineProps<{
  servers: McpServerInfo[]
  isLoading: boolean
  hasServers: boolean
  connectionError: string
  connectingIds: Set<string>
}>()

const emit = defineEmits<{
  (e: 'start-create'): void
  (e: 'open-config-file'): void
  (e: 'refresh'): void
  (e: 'toggle-enabled', server: McpServerInfo): void
  (e: 'toggle-connection', server: McpServerInfo): void
  (e: 'start-edit', server: McpServerInfo): void
  (e: 'show-delete', server: McpServerInfo): void
}>()

const statusColor = (status: McpServerStatus) => {
  switch (status) {
    case 'connected': return 'var(--vscode-terminal-ansiGreen)'
    case 'connecting': return 'var(--vscode-terminal-ansiYellow)'
    case 'error': return 'var(--vscode-terminal-ansiRed)'
    default: return 'var(--vscode-descriptionForeground)'
  }
}

const statusText = (status: McpServerStatus) => {
  switch (status) {
    case 'connected': return t('components.settings.mcpSettings.status.connected')
    case 'connecting': return t('components.settings.mcpSettings.status.connecting')
    case 'error': return t('components.settings.mcpSettings.status.error')
    default: return t('components.settings.mcpSettings.status.disconnected')
  }
}

// 获取服务器的显示状态（考虑本地 connecting 状态）
function getDisplayStatus(server: McpServerInfo): McpServerStatus {
  if (props.connectingIds.has(server.config.id)) {
    return 'connecting'
  }
  return server.status
}
</script>

<template>
  <div class="mcp-list-view">
    <!-- 工具栏 -->
    <div class="mcp-toolbar" data-search-anchor="mcp-toolbar">
      <button class="toolbar-btn primary" @click="emit('start-create')">
        <i class="codicon codicon-add"></i>
        <span>{{ t('components.settings.mcpSettings.toolbar.addServer') }}</span>
      </button>
      <button class="toolbar-btn" @click="emit('open-config-file')">
        <i class="codicon codicon-json"></i>
        <span>{{ t('components.settings.mcpSettings.toolbar.editJson') }}</span>
      </button>
      <button class="toolbar-btn" @click="emit('refresh')" :disabled="isLoading" :title="t('components.settings.mcpSettings.toolbar.refresh')">
        <i class="codicon" :class="isLoading ? 'codicon-loading codicon-modifier-spin' : 'codicon-refresh'"></i>
      </button>
    </div>

    <!-- 连接/断开操作错误提示 -->
    <div v-if="connectionError" class="form-error" style="margin-bottom: 8px;">
      <i class="codicon codicon-error"></i>
      {{ connectionError }}
    </div>

    <!-- 服务器列表 -->
    <div v-if="isLoading && !hasServers" class="loading-state">
      <i class="codicon codicon-loading codicon-modifier-spin"></i>
      <span>{{ t('components.settings.mcpSettings.loading') }}</span>
    </div>

    <div v-else-if="!hasServers" class="empty-state">
      <div class="empty-icon">
        <i class="codicon codicon-plug"></i>
      </div>
      <h4>{{ t('components.settings.mcpSettings.empty.title') }}</h4>
      <p>{{ t('components.settings.mcpSettings.empty.description') }}</p>
    </div>

    <div v-else class="server-list" data-search-anchor="mcp-server-list">
      <div
        v-for="server in servers"
        :key="server.config.id"
        class="server-card"
        :class="{ disabled: !server.config.enabled }"
      >
        <div class="server-checkbox">
          <CustomCheckbox
            :model-value="server.config.enabled"
            @update:model-value="emit('toggle-enabled', server)"
          />
        </div>
        <div class="server-content">
          <div class="server-header">
            <div class="server-info">
              <div class="server-name">{{ server.config.name }}</div>
              <div class="server-type">
                <span class="transport-badge">{{ server.config.transport.type.toUpperCase() }}</span>
                <span class="status-dot" :style="{ backgroundColor: statusColor(getDisplayStatus(server)) }"></span>
                <span class="status-text">{{ statusText(getDisplayStatus(server)) }}</span>
              </div>
            </div>
            <div class="server-actions">
              <button
                class="action-btn"
                :title="getDisplayStatus(server) === 'connected' ? t('components.settings.mcpSettings.serverCard.disconnect') : getDisplayStatus(server) === 'connecting' ? t('components.settings.mcpSettings.serverCard.connecting') : t('components.settings.mcpSettings.serverCard.connect')"
                @click="emit('toggle-connection', server)"
                :disabled="!server.config.enabled || getDisplayStatus(server) === 'connecting'"
              >
                <i class="codicon" :class="getDisplayStatus(server) === 'connected' ? 'codicon-debug-disconnect' : getDisplayStatus(server) === 'connecting' ? 'codicon-loading codicon-modifier-spin' : 'codicon-plug'"></i>
              </button>
              <button class="action-btn" :title="t('components.settings.mcpSettings.serverCard.edit')" @click="emit('start-edit', server)">
                <i class="codicon codicon-edit"></i>
              </button>
              <button class="action-btn danger" :title="t('components.settings.mcpSettings.serverCard.delete')" @click="emit('show-delete', server)">
                <i class="codicon codicon-trash"></i>
              </button>
            </div>
          </div>

          <div v-if="server.config.description" class="server-description">
            {{ server.config.description }}
          </div>

          <div class="server-details">
            <template v-if="server.config.transport.type === 'stdio'">
              <code class="transport-detail">{{ server.config.transport.command }}</code>
            </template>
            <template v-else>
              <code class="transport-detail">{{ server.config.transport.url }}</code>
            </template>
          </div>

          <!-- 能力显示 -->
          <div v-if="server.capabilities && server.status === 'connected'" class="server-capabilities">
            <span v-if="server.capabilities.tools?.length" class="capability-badge">
              <i class="codicon codicon-tools"></i>
              {{ server.capabilities.tools.length }} {{ t('components.settings.mcpSettings.serverCard.tools') }}
            </span>
            <span v-if="server.capabilities.resources?.length" class="capability-badge">
              <i class="codicon codicon-file"></i>
              {{ server.capabilities.resources.length }} {{ t('components.settings.mcpSettings.serverCard.resources') }}
            </span>
            <span v-if="server.capabilities.prompts?.length" class="capability-badge">
              <i class="codicon codicon-comment"></i>
              {{ server.capabilities.prompts.length }} {{ t('components.settings.mcpSettings.serverCard.prompts') }}
            </span>
          </div>

          <div v-if="server.lastError" class="server-error">
            <i class="codicon codicon-error"></i>
            {{ server.lastError }}
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 工具栏 */
.mcp-toolbar {
  display: flex;
  gap: 8px;
  margin-bottom: 16px;
}

.toolbar-btn {
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

.toolbar-btn:hover:not(:disabled) {
  background: var(--vscode-button-secondaryHoverBackground);
}

.toolbar-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.toolbar-btn.primary {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
}

.toolbar-btn.primary:hover:not(:disabled) {
  background: var(--vscode-button-hoverBackground);
}

/* 加载和空状态 */
.loading-state,
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 40px 20px;
  text-align: center;
  color: var(--vscode-descriptionForeground);
}

.loading-state {
  flex-direction: row;
  gap: 8px;
}

.empty-icon {
  width: 64px;
  height: 64px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--vscode-button-background);
  border-radius: 50%;
  margin-bottom: 16px;
}

.empty-icon .codicon {
  font-size: 28px;
  color: var(--vscode-button-foreground);
}

.empty-state h4 {
  margin: 0 0 8px 0;
  color: var(--vscode-foreground);
}

.empty-state p {
  margin: 0;
  font-size: 13px;
}

/* 服务器列表 */
.server-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.server-card {
  display: flex;
  align-items: center;
  background: var(--vscode-editor-background);
  border: 1px solid var(--vscode-panel-border);
  border-radius: 8px;
  padding: 12px 16px;
  transition: border-color 0.15s;
}

.server-card:hover {
  border-color: var(--vscode-focusBorder);
}

.server-card.disabled {
  opacity: 0.6;
}

.server-checkbox {
  display: flex;
  align-items: center;
  flex-shrink: 0;
  margin-right: 12px;
}

.server-content {
  flex: 1;
  min-width: 0;
}

.server-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 8px;
}

.server-info {
  flex: 1;
  min-width: 0;
}

.server-name {
  font-size: 14px;
  font-weight: 500;
  color: var(--vscode-foreground);
  margin-bottom: 4px;
}

.server-type {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}

.transport-badge {
  padding: 2px 6px;
  background: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
  border-radius: 3px;
  font-size: 10px;
  font-weight: 500;
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.status-text {
  color: var(--vscode-descriptionForeground);
}

.server-actions {
  display: flex;
  gap: 4px;
}

.action-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  background: transparent;
  border: none;
  border-radius: 4px;
  color: var(--vscode-foreground);
  cursor: pointer;
  opacity: 0.7;
  transition: opacity 0.15s, background-color 0.15s;
}

.action-btn:hover:not(:disabled) {
  opacity: 1;
  background: var(--vscode-toolbar-hoverBackground);
}

.action-btn:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

.action-btn.danger:hover:not(:disabled) {
  color: var(--vscode-errorForeground);
}

.server-description {
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
  margin-bottom: 8px;
}

.server-details {
  margin-bottom: 8px;
}

.transport-detail {
  font-size: 11px;
  padding: 4px 8px;
  background: var(--vscode-textBlockQuote-background);
  border-radius: 4px;
  color: var(--vscode-foreground);
  display: inline-block;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.server-capabilities {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.capability-badge {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  padding: 2px 8px;
  background: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
  border-radius: 10px;
}

.capability-badge .codicon {
  font-size: 12px;
}

.server-error {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
  padding: 8px;
  background: var(--vscode-inputValidation-errorBackground);
  border: 1px solid var(--vscode-inputValidation-errorBorder);
  border-radius: 4px;
  font-size: 12px;
  color: var(--vscode-errorForeground);
}

.form-error {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  margin-bottom: 16px;
  background: var(--vscode-inputValidation-errorBackground);
  border: 1px solid var(--vscode-inputValidation-errorBorder);
  border-radius: 4px;
  font-size: 12px;
  color: var(--vscode-errorForeground);
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
