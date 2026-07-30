<script setup lang="ts">
/**
 * ChatHeader - 聊天头部组件
 * 包含新建对话、历史、设置按钮
 */

import { IconButton, Tooltip } from '../common'
import { t } from '../../i18n'

defineEmits<{
  newChat: []
  showHistory: []
  showSettings: []
}>()
</script>

<template>
  <header class="chat-header">
    <div class="header-left">
      <span class="header-title">GrayCode</span>
    </div>

    <div class="header-right">
      <!-- 新建对话 -->
      <Tooltip :content="t('components.header.newChat')" placement="bottom">
        <IconButton
          icon="codicon-add"
          size="medium"
          @click="$emit('newChat')"
        />
      </Tooltip>

      <!-- 对话历史 -->
      <Tooltip :content="t('components.header.history')" placement="bottom">
        <IconButton
          icon="codicon-history"
          size="medium"
          @click="$emit('showHistory')"
        />
      </Tooltip>

      <!-- 设置 -->
      <Tooltip :content="t('components.header.settings')" placement="bottom">
        <IconButton
          icon="codicon-settings-gear"
          size="medium"
          @click="$emit('showSettings')"
        />
      </Tooltip>
    </div>
  </header>
</template>

<style scoped>
.chat-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--spacing-sm, 8px) var(--spacing-md, 16px);
  border-bottom: 1px solid var(--vscode-panel-border);
  background: var(--vscode-editor-background);
  flex-shrink: 0;
}

.header-left {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm, 8px);
}

.header-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--vscode-foreground);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.header-right {
  display: flex;
  align-items: center;
  gap: var(--spacing-xs, 4px);
}
</style>