<script setup lang="ts">
/**
 * 加载动画组件 - 扁平简洁设计
 * 使用横线脉冲动画替代旋转圆圈
 */

import { t } from '@/i18n'

withDefaults(defineProps<{
  size?: 'small' | 'medium' | 'large'
  text?: string
}>(), {
  size: 'medium'
})
</script>

<template>
  <div class="loading-spinner" role="status" :aria-label="text || t('common.loading')">
    <div :class="['spinner', size]">
      <div class="spinner-line"></div>
    </div>
    <span v-if="text" class="loading-text">{{ text }}</span>
  </div>
</template>

<style scoped>
.loading-spinner {
  display: inline-flex;
  align-items: center;
  gap: var(--spacing-sm, 8px);
}

.spinner {
  position: relative;
  display: inline-flex;
  align-items: center;
}

.spinner.small {
  width: 12px;
  height: 2px;
}

.spinner.medium {
  width: 16px;
  height: 2px;
}

.spinner.large {
  width: 24px;
  height: 2px;
}

.spinner-line {
  width: 100%;
  height: 100%;
  background: currentColor;
  animation: pulse-line 1s ease-in-out infinite;
}

.loading-text {
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
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
  .spinner-line {
    animation: none;
    opacity: 0.6;
    transform: scaleX(1);
  }
}
</style>