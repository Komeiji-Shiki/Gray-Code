<script setup lang="ts">
/**
 * 图标按钮组件
 */

import { computed, inject } from 'vue'
import { TOOLTIP_CONTENT_KEY } from './tooltipContext'

const props = withDefaults(defineProps<{
  icon?: string
  tooltip?: string
  ariaLabel?: string
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

const injectedTooltip = inject(TOOLTIP_CONTENT_KEY, undefined)
const accessibleLabel = computed(() => {
  const iconLabel = props.icon?.replace(/^codicon-/, '').replace(/-/g, ' ')
  return props.ariaLabel || props.tooltip || injectedTooltip?.value || iconLabel || 'button'
})

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
    :aria-label="accessibleLabel"
    :aria-busy="loading || undefined"
    type="button"
    @click="handleClick"
  >
    <span v-if="loading" class="spinner" aria-hidden="true"></span>
    <i v-else-if="isCodiconIcon" :class="codiconClass" aria-hidden="true"></i>
    <span v-else-if="icon" class="icon" aria-hidden="true">{{ icon }}</span>
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
  border-radius: var(--gc-radius-sm);
  cursor: pointer;
  transition:
    color var(--gc-duration-fast) var(--gc-ease-standard),
    background-color var(--gc-duration-fast) var(--gc-ease-standard),
    opacity var(--gc-duration-fast) var(--gc-ease-standard);
  font-family: inherit;
  flex-shrink: 0;
  background: transparent;
  box-sizing: border-box;
}

/* 尺寸 */
.icon-button.small {
  width: var(--gc-control-height-sm);
  height: var(--gc-control-height-sm);
  font-size: var(--gc-icon-size-sm);
}

.icon-button.medium {
  width: var(--gc-control-height-md);
  height: var(--gc-control-height-md);
  font-size: var(--gc-icon-size-md);
}

.icon-button.large {
  width: var(--gc-control-height-lg);
  height: var(--gc-control-height-lg);
  font-size: var(--gc-icon-size-lg);
}

/* 变体 - 扁平化设计 */
.icon-button.default {
  color: var(--gc-text-primary);
  opacity: var(--gc-opacity-muted);
}

.icon-button.default:hover:not(:disabled) {
  opacity: 1;
}

.icon-button.primary {
  background: var(--gc-accent);
  color: var(--gc-text-on-accent);
}

.icon-button.primary:hover:not(:disabled) {
  opacity: 0.85;
}

.icon-button.danger {
  color: var(--gc-danger);
  opacity: var(--gc-opacity-muted);
}

.icon-button.danger:hover:not(:disabled) {
  opacity: 1;
}

/* 状态 */
.icon-button:disabled,
.icon-button.loading {
  opacity: var(--gc-opacity-disabled);
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