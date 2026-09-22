<script setup lang="ts">
import { computed, ref } from 'vue';
const props = defineProps<{ label: string; value: unknown }>();
const expanded = ref(false);
// 收起时不序列化正文，也不创建承载完整 JSON 的文本节点。
const text = computed(() => typeof props.value === 'string' ? props.value : JSON.stringify(props.value, null, 2));
</script>
<template>
  <details @toggle="expanded = ($event.currentTarget as HTMLDetailsElement).open">
    <summary>{{ label }}</summary><pre v-if="expanded">{{ text }}</pre>
  </details>
</template>
<style scoped>
summary { cursor: pointer; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; font: 11px/1.6 monospace; }
</style>
