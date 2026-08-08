<script setup lang="ts">
/**
 * 图标按钮组件
 */

import { computed } from 'vue'

const props = withDefaults(defineProps<{
  icon?: string
  tooltip?: string
  disabled?: boolean
  loading?: boolean
  variant?: 'default' | 'primary' | 'danger'
  size?: 'small' | 'medium' | 'large'
}>(), {
  variant: 'default',
  size: 'medium'
})

const emit = defineEmits<{
  click: [event: MouseEvent]
}>()

const buttonClass = computed(() => {
  return [
    'icon-button',
    props.variant,
    props.size,
    {
      disabled: props.disabled,
      loading: props.loading
    }
  ]
})

// 判断是否为 codicon 图标
const isCodiconIcon = computed(() =>
  props.icon?.startsWith('codicon-')
)

// codicon 类名
const codiconClass = computed(() =>
  isCodiconIcon.value ? `codicon ${props.icon}` : ''
)

function handleClick(event: MouseEvent) {
  if (!props.disabled && !props.loading) {
    emit('click', event)
  }
}
</script>

<template>
  <button
    :class="buttonClass"
    :disabled="disabled || loading"
    :title="tooltip"
    :aria-label="tooltip || icon || 'button'"
    type="button"
    @click="handleClick"
  >
    <span v-if="loading" class="spinner"></span>
    <i v-else-if="isCodiconIcon" :class="codiconClass"></i>
    <span v-else-if="icon" class="icon">{{ icon }}</span>
    <slot v-else />
  </button>
</template>

<style scoped>
/* 扁平化图标按钮 */
.icon-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: var(--radius-sm, 2px);
  cursor: pointer;
  transition: opacity var(--transition-fast, 0.1s);
  font-family: inherit;
  flex-shrink: 0;
  background: transparent;
  box-sizing: border-box;
}

/* 尺寸 */
.icon-button.small {
  width: 24px;
  height: 24px;
  font-size: 14px;
}

.icon-button.medium {
  width: 28px;
  height: 28px;
  font-size: 16px;
}

.icon-button.large {
  width: 32px;
  height: 32px;
  font-size: 18px;
}

/* 变体 - 扁平化设计 */
.icon-button.default {
  color: var(--vscode-foreground);
  opacity: 0.7;
}

.icon-button.default:hover:not(:disabled) {
  opacity: 1;
}

.icon-button.primary {
  background: var(--vscode-foreground);
  color: var(--vscode-editor-background);
}

.icon-button.primary:hover:not(:disabled) {
  opacity: 0.85;
}

.icon-button.danger {
  color: var(--vscode-foreground);
  opacity: 0.7;
}

.icon-button.danger:hover:not(:disabled) {
  opacity: 1;
}

/* 状态 */
.icon-button:disabled,
.icon-button.loading {
  opacity: 0.3;
  cursor: not-allowed;
}

/* 图标 */
.icon {
  display: flex;
  align-items: center;
  justify-content: center;
}

/* codicon 图标样式 */
.icon-button i.codicon {
  font-size: inherit;
  line-height: 1;
}

/* 加载动画 - 简洁横线 */
.spinner {
  width: 12px;
  height: 2px;
  background: currentColor;
  animation: pulse-line 1s ease-in-out infinite;
}

@keyframes pulse-line {
  0%, 100% {
    opacity: 0.3;
    transform: scaleX(0.6);
  }
  50% {
    opacity: 1;
    transform: scaleX(1);
  }
}

@media (prefers-reduced-motion: reduce) {
  .spinner {
    animation: none;
    opacity: 0.6;
  }
}
</style>