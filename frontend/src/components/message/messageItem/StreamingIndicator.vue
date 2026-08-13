<script setup lang="ts">
/**
 * StreamingIndicator - 流式输出「Loading 逐字波动」指示器（从 MessageItem.vue 抽出，F-07）。
 */
import { computed } from 'vue'

const props = defineProps<{
  text: string
}>()

// 使用 Array.from 以更好地支持中文等多字节字符
const chars = computed(() => Array.from(props.text))
</script>

<template>
  <span
    class="streaming-indicator"
    role="status"
    :aria-label="text"
    :style="{
      '--loading-duration': '2.8s',
      '--loading-idle-color': 'var(--vscode-descriptionForeground, #8a8a8a)',
      '--loading-active-color': 'var(--vscode-charts-blue, #0050b3)',
      '--loading-amp': '4px'
    }"
  >
    <span
      v-for="(ch, i) in chars"
      :key="i"
      class="streaming-indicator__char"
      :class="{
        'streaming-indicator__char--underline': true
      }"
      :style="{ '--loading-delay': `${i * 0.16}s` }"
    >
      {{ ch }}
    </span>
  </span>
</template>

<style scoped>
/* 流式指示器 - Loading 从左到右逐字波动 */
.streaming-indicator {
  display: inline-flex;
  align-items: flex-end;
  margin-left: 6px;
  line-height: 1;
  letter-spacing: 0.02em;
  user-select: none;
}

.streaming-indicator__char {
  position: relative;
  display: inline-block;
  padding: 0 0.5px;
  color: var(--loading-idle-color);
  opacity: 0.78;

  /* “播完停顿”的关键：每个字母在一整轮里只在前 22% 左右动，后面都静止 */
  animation: loading-wave var(--loading-duration) ease-in-out infinite;
  animation-delay: var(--loading-delay);
  will-change: transform, color, opacity;
}

/* 下划线胶囊：跟随每个字母的波动 */
.streaming-indicator__char--underline::after {
  content: '';
  position: absolute;
  left: 50%;
  bottom: -4px;
  width: 10px;
  height: 2px;
  border-radius: 999px;
  background: var(--loading-active-color);

  opacity: 0;
  transform: translateX(-50%) scaleX(0.35);

  animation: loading-underline var(--loading-duration) ease-in-out infinite;
  animation-delay: var(--loading-delay);
  will-change: transform, opacity;
}

@keyframes loading-wave {
  /* 0~22%：完成一次“跳一下”；22%~100%：保持静止 */
  0%, 22%, 100% {
    transform: translateY(0) scale(1);
    color: var(--loading-idle-color);
    opacity: 0.78;
  }
  11% {
    transform: translateY(calc(var(--loading-amp) * -1)) scale(1.06);
    color: var(--loading-active-color);
    opacity: 1;
  }
}

@keyframes loading-underline {
  0%, 22%, 100% {
    opacity: 0;
    transform: translateX(-50%) scaleX(0.35);
  }
  11% {
    opacity: 0.9;
    transform: translateX(-50%) scaleX(1);
  }
}

@media (prefers-reduced-motion: reduce) {
  .streaming-indicator__char,
  .streaming-indicator__char--underline::after {
    animation: none;
    opacity: 1;
  }

  .streaming-indicator__char--underline::after {
    opacity: 0;
  }
}
</style>
