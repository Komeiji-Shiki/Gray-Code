<script setup lang="ts">
import { computed, ref } from 'vue';
import NavigationIcon from './navigation/NavigationIcon.vue';
import '../../../../frontend/src/styles/disclosure.css';
const props = defineProps<{ label: string; value: unknown }>();
const expanded = ref(false);
// 收起时不序列化正文，也不创建承载完整 JSON 的文本节点。
const text = computed(() => typeof props.value === 'string' ? props.value : JSON.stringify(props.value, null, 2));
</script>
<template>
  <details class="gc-disclosure" @toggle="expanded = ($event.currentTarget as HTMLDetailsElement).open">
    <summary><NavigationIcon name="chevron" class="gc-disclosure-chevron" />{{ label }}</summary>
    <pre v-if="expanded" class="gc-disclosure-content">{{ text }}</pre>
  </details>
</template>
<style scoped>
pre { margin: 10px 0; }
</style>
