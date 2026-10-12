<script setup lang="ts">
import { computed, ref } from 'vue';
import NavigationIcon from './navigation/NavigationIcon.vue';
const props = defineProps<{ label: string; value: unknown }>();
const expanded = ref(false);
// 收起时不序列化正文，也不创建承载完整 JSON 的文本节点。
const text = computed(() => typeof props.value === 'string' ? props.value : JSON.stringify(props.value, null, 2));
</script>
<template>
  <details class="json-details" @toggle="expanded = ($event.currentTarget as HTMLDetailsElement).open">
    <summary><NavigationIcon name="chevron" class="disclosure-chevron" />{{ label }}</summary>
    <pre v-if="expanded">{{ text }}</pre>
  </details>
</template>
<style scoped>
summary {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  line-height: 1.65;
  list-style: none;
  cursor: pointer;
}
summary::-webkit-details-marker { display: none; }
.disclosure-chevron { width: 14px; height: 14px; flex-shrink: 0; }
.json-details[open] > summary .disclosure-chevron { transform: rotate(90deg); }
pre { white-space: pre-wrap; overflow-wrap: anywhere; font: 12px/1.65 var(--gc-font-code); margin: 10px 0; }
</style>
