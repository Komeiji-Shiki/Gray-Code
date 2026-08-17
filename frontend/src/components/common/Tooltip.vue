<script setup lang="ts">
/**
 * 提示框组件
 */

import { ref, computed } from 'vue'

const props = withDefaults(defineProps<{
  content?: string
  placement?: 'top' | 'top-left' | 'top-right' | 'bottom' | 'left' | 'right'
  disabled?: boolean
  multiline?: boolean
  maxWidth?: string
}>(), {
  placement: 'top',
  disabled: false,
  multiline: false,
  maxWidth: '360px'
})

const visible = ref(false)

const tooltipClass = computed(() => {
  return ['tooltip', props.placement]
})

function show() {
  if (!props.disabled && props.content) {
    visible.value = true
  }
}

function hide() {
  visible.value = false
}
</script>

<template>
  <div class="tooltip-wrapper" @mouseenter="show" @mouseleave="hide" @focusin="show" @focusout="hide">
    <slot />
    <Transition name="tooltip-fade">
      <div
        v-if="visible"
        ref="tooltipRef"
        :class="[tooltipClass, { multiline }]"
        :style="{ maxWidth }"
      >
        <div class="tooltip-content">
          {{ content }}
        </div>
        <div class="tooltip-arrow"></div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.tooltip-wrapper {
  position: relative;
  display: inline-flex;
}

.tooltip {
  position: absolute;
  z-index: 1000;
  max-width: 360px;
  padding: 6px 10px;
  background: var(--vscode-editorHoverWidget-background);
  border: 1px solid var(--vscode-editorHoverWidget-border);
  border-radius: 4px;
  font-size: 12px;
  color: var(--vscode-editorHoverWidget-foreground);
  white-space: nowrap;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
  pointer-events: none;
}

.tooltip.multiline {
  /* containing block（.tooltip-wrapper）宽度只有触发器那么大，width:auto 会被 shrink-to-fit 压成几像素宽，
     导致 pre-line 长文本折成每行几个字的碎行；这里强制按内容撑开（仍受 max-width 约束） */
  width: max-content;
  white-space: pre-line;
  line-height: 1.45;
  text-align: left;
}

.tooltip-content {
  position: relative;
  z-index: 1;
}

.tooltip-arrow {
  position: absolute;
  width: 8px;
  height: 8px;
  background: var(--vscode-editorHoverWidget-background);
  border: 1px solid var(--vscode-editorHoverWidget-border);
  transform: rotate(45deg);
}

/* 位置 */
.tooltip.top {
  bottom: 100%;
  left: 50%;
  transform: translateX(-50%);
  margin-bottom: 8px;
}

.tooltip.top .tooltip-arrow {
  bottom: -5px;
  left: 50%;
  margin-left: -4px;
  border-top: none;
  border-left: none;
}

.tooltip.top-left {
  bottom: 100%;
  left: 0;
  margin-bottom: 8px;
}

.tooltip.top-left .tooltip-arrow {
  bottom: -5px;
  left: 8px;
  border-top: none;
  border-left: none;
}

.tooltip.top-right {
  bottom: 100%;
  right: 0;
  margin-bottom: 8px;
}

.tooltip.top-right .tooltip-arrow {
  bottom: -5px;
  right: 8px;
  border-top: none;
  border-left: none;
}

.tooltip.bottom {
  top: 100%;
  left: 50%;
  transform: translateX(-50%);
  margin-top: 8px;
}

.tooltip.bottom .tooltip-arrow {
  top: -5px;
  left: 50%;
  margin-left: -4px;
  border-bottom: none;
  border-right: none;
}

.tooltip.left {
  right: 100%;
  top: 50%;
  transform: translateY(-50%);
  margin-right: 8px;
}

.tooltip.left .tooltip-arrow {
  right: -5px;
  top: 50%;
  margin-top: -4px;
  border-left: none;
  border-bottom: none;
}

.tooltip.right {
  left: 100%;
  top: 50%;
  transform: translateY(-50%);
  margin-left: 8px;
}

.tooltip.right .tooltip-arrow {
  left: -5px;
  top: 50%;
  margin-top: -4px;
  border-right: none;
  border-top: none;
}

/* 动画 */
.tooltip-fade-enter-active,
.tooltip-fade-leave-active {
  transition: opacity 0.15s;
}

.tooltip-fade-enter-from,
.tooltip-fade-leave-to {
  opacity: 0;
}
</style>