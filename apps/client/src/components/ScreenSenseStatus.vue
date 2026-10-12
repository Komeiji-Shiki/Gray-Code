<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import type { ScreenSenseStatus } from '@graycode/contracts';
import { call, subscribe } from '../api';
import { shellText as t } from '../i18n';
const emit = defineEmits<{ manage: [] }>();
const status = ref<ScreenSenseStatus>();
const error = ref('');
let unsubscribe: (() => void) | undefined;
onMounted(() => {
  void call<ScreenSenseStatus>('screenSense.status').then(value => {
    status.value = value;
  }).catch(cause => { error.value = (cause as Error).message; });
  unsubscribe = subscribe(event => {
    if (event.type === 'screenSense.changed') {
      status.value = event.status;
      error.value = '';
    }
  });
});
onBeforeUnmount(() => unsubscribe?.());
async function stop() {
  try {
    status.value = await call('screenSense.stop');
    error.value = '';
  } catch (cause) {
    error.value = (cause as Error).message;
  }
}
</script>
<template>
  <section v-if="status?.active || status?.error || error" class="screen-sense-status" :class="{ active: status?.active }"
    :aria-label="t('screenStatusLabel')" aria-live="polite">
    <span :title="status?.target">{{ t(status?.active ? 'screenActive' : 'screenInactive') }} · {{ status?.target }}</span>
    <button @click="emit('manage')">{{ t('screenManage') }}</button>
    <button v-if="status?.active" @click="stop">{{ t('screenStop') }}</button>
    <span v-if="error || status?.error" role="alert">{{ error || status?.error }}</span>
  </section>
</template>
<style scoped>
.screen-sense-status {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 12px;
  border-bottom: 1px solid var(--gc-border-subtle);
  background: var(--gc-surface-raised);
  font-size: 12px;
  color: var(--gc-text-primary);
  flex-wrap: wrap;
}
.screen-sense-status.active::before { content: ''; width: 8px; height: 8px; background: var(--gc-success); flex-shrink: 0; }
.screen-sense-status > span:first-of-type { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
.screen-sense-status button {
  border: 1px solid var(--gc-border-control);
  border-radius: var(--gc-radius-sm);
  background: var(--gc-surface-sunken);
  color: var(--gc-text-primary);
  font: inherit;
  padding: 4px 7px;
  cursor: pointer;
  -webkit-app-region: no-drag;
}
</style>
