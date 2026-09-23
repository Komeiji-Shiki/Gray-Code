<script setup lang="ts">
import { ref, watch } from 'vue';
import { call } from '../api';

const props = defineProps<{ message: string }>();
const emit = defineEmits<{ dismiss: [] }>();
const feedback = ref('');
const copying = ref(false);
watch(() => props.message, () => { feedback.value = ''; });
async function copy() {
  const message = props.message;
  copying.value = true;
  try {
    if (window.graycode.kind === 'web') await navigator.clipboard.writeText(message);
    else await call('desktop.clipboard.writeText', { text: message });
    if (props.message === message) feedback.value = '已复制';
  } catch {
    if (props.message === message) feedback.value = '复制失败';
  } finally { copying.value = false; }
}
</script>

<template>
  <div class="error-banner" role="alert">
    <span class="error-banner-message">{{ message }}</span>
    <div class="error-banner-actions">
      <button type="button" :disabled="copying" @click="copy">复制错误</button>
      <span role="status">{{ feedback }}</span>
      <button type="button" @click="emit('dismiss')">关闭</button>
    </div>
  </div>
</template>

<style scoped>
.error-banner-message { flex: 1; min-width: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.error-banner-actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
.error-banner-actions button { margin-left: 0; }
.error-banner-actions [role="status"]:empty { display: none; }
</style>
