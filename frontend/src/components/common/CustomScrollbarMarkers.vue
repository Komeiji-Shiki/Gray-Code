<script lang="ts">
export interface MarkerItem {
  top: number
  contentPreview: string
  element?: HTMLElement
  /** 虚拟轨道的全局消息索引，用于跳转。 */
  targetIndex?: number
  /** 原用户消息序号，抽样后仍用于提示。 */
  index: number
  color: string
  tooltipPrefix: string
}
</script>

<script setup lang="ts">
// 独立渲染边界：滑块和提示位置变化时，不再遍历整张标记列表。
defineProps<{
  markers: MarkerItem[]
  height: number
  baseColor: string
  opacity: number
}>()
const emit = defineEmits<{
  click: [marker: MarkerItem, event: MouseEvent]
  enter: [marker: MarkerItem, event: MouseEvent]
  leave: []
}>()
</script>

<template>
  <div
    v-for="marker in markers"
    :key="`${marker.index}:${marker.contentPreview}`"
    class="scroll-marker"
    :style="{
      top: `${marker.top}px`,
      height: `${height}px`,
      background: marker.color || baseColor,
      opacity,
    }"
    @click.stop="emit('click', marker, $event)"
    @mouseenter="emit('enter', marker, $event)"
    @mouseleave="emit('leave')"
  />
</template>

<style scoped>
.scroll-marker {
  position: absolute;
  left: 0;
  width: 100%;
  border-radius: 0;
  cursor: pointer;
  z-index: 3;
  transition: opacity 0.18s ease, box-shadow 0.18s ease;
  /* 允许指针事件穿透到轨道（除了 marker 自身） */
  pointer-events: auto;
}

.scroll-marker:hover {
  opacity: 1 !important;
  box-shadow: 0 0 3px rgba(100, 160, 255, 0.6);
}

@media (prefers-reduced-motion: reduce) {
  .scroll-marker { transition: none !important; }
}
</style>
