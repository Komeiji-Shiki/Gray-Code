<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { MonitorRunStatus } from './monitorSoundCues'

const props = defineProps<{ createdAt: number; updatedAt: number; status: MonitorRunStatus; ticking: boolean }>()
const now = ref(Date.now())
let timer: ReturnType<typeof setInterval> | undefined
const ongoing = computed(() => ['queued', 'running', 'paused', 'awaiting_monitor_action'].includes(props.status))
// 计时变化只更新这个文本节点；已结束的运行不申请计时器。
watch(() => props.ticking && ongoing.value, enabled => {
  clearInterval(timer)
  timer = undefined
  if (enabled) {
    now.value = Date.now()
    timer = setInterval(() => { now.value = Date.now() }, 1000)
  }
}, { immediate: true })
const elapsed = computed(() => {
  if (!props.createdAt) return ''
  const seconds = Math.max(0, Math.floor(((ongoing.value ? now.value : props.updatedAt) - props.createdAt) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return minutes < 60 ? `${minutes}m${seconds % 60}s` : `${Math.floor(minutes / 60)}h${minutes % 60}m`
})
onBeforeUnmount(() => clearInterval(timer))
</script>

<template><span>{{ elapsed }}</span></template>
