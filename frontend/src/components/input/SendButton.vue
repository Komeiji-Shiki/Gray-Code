<script setup lang="ts">
/**
 * SendButton - 发送按钮
 * 使用纸飞机图标，扁平化设计
 * loading 状态下显示停止图标，点击可取消请求
 */

import { useI18n } from '../../i18n'

const { t } = useI18n()

defineProps<{
  disabled?: boolean
  loading?: boolean
}>()

const emit = defineEmits<{
  click: []
  preserveDynamicContextClick: []
  cancel: []
}>()

// 处理点击
function handleClick() {
  emit('click')
}

function handlePreserveDynamicContextClick() {
  emit('preserveDynamicContextClick')
}

// 处理取消
function handleCancel() {
  emit('cancel')
}
</script>

<template>
  <!-- 取消按钮 - loading 状态下显示 -->
  <button
    v-if="loading"
    class="send-button"
    :title="t('components.input.stopGenerating')"
    @click="handleCancel"
  >
    <i class="codicon codicon-primitive-square stop-icon"></i>
  </button>
  
  <div v-else class="send-button-group">
    <button
      class="send-button preserve-send-button"
      :disabled="disabled"
      :title="t('components.input.sendPreserveDynamicContext')"
      @click="handlePreserveDynamicContextClick"
    >
      <i class="codicon codicon-pinned preserve-send-icon"></i>
    </button>

    <button
      class="send-button"
      :disabled="disabled"
      :title="t('components.input.send')"
      @click="handleClick"
    >
      <i class="codicon codicon-send send-icon"></i>
    </button>
  </div>
</template>

<style scoped>
.send-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  background: transparent;
  color: var(--vscode-foreground);
  border: none;
  border-radius: var(--radius-sm, 2px);
  cursor: pointer;
  transition: background-color var(--transition-fast, 0.1s), opacity var(--transition-fast, 0.1s);
  flex-shrink: 0;
}

.send-button-group {
  display: inline-flex;
  align-items: center;
  gap: 2px;
}

.preserve-send-button {
  color: var(--vscode-descriptionForeground);
}

.preserve-send-button:hover:not(:disabled) {
  color: var(--vscode-foreground);
}

.send-button:hover:not(:disabled) {
  background: var(--vscode-toolbar-hoverBackground);
}

.send-button:active:not(:disabled) {
  background: var(--vscode-toolbar-activeBackground);
}

.send-button:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

.send-icon {
  font-size: 16px;
}

.preserve-send-icon {
  font-size: 15px;
}

.stop-icon {
  font-size: 25px;
}
</style>