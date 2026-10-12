<script setup lang="ts">
import { shellText as t } from '../i18n';
defineProps<{ error?: Error }>();
function retry() {
  window.location.reload();
}
</script>
<template>
  <div class="workspace-loading" :role="error ? 'alert' : 'status'">
    <strong>GRAYCODE</strong>
    <h1>{{ error ? t('uiWorkspaceLoadingWorkbenchLoadFailed') : t('uiWorkspaceLoadingLoadingWorkbench') }}</h1>
    <p>{{ error ? t('uiWorkspaceLoadingPageResourcesFailed') : t('uiWorkspaceLoadingSlowConnectionHelp') }}</p>
    <button @click="retry">{{ t('uiWorkspaceLoadingReload') }}</button>
  </div>
</template>
<style scoped>
.workspace-loading {
  min-height: 100dvh;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  justify-content: center;
  padding: clamp(28px, 8vw, 100px);
  background: var(--gc-surface-chrome);
  color: var(--gc-text-on-chrome);
  font-family: 'Segoe UI', 'Microsoft YaHei', sans-serif;
}
.workspace-loading strong {
  font-size: 14px;
  letter-spacing: 0.16em;
  color: var(--gc-text-on-chrome-muted);
}
.workspace-loading h1 {
  font-size: 26px;
  font-weight: 500;
  margin: 24px 0 12px;
}
.workspace-loading p {
  color: var(--gc-text-on-chrome-muted);
  font-size: 14px;
  line-height: 1.7;
  margin: 0;
}
.workspace-loading button {
  margin-top: 24px;
  padding: 11px 18px;
  border: 1px solid transparent;
  border-radius: var(--gc-radius-sm);
  background: var(--gc-button-primary);
  color: var(--gc-text-on-primary);
  font: inherit;
  cursor: pointer;
}
.workspace-loading button:focus-visible {
  outline: 2px solid var(--gc-focus-border);
  outline-offset: 4px;
}
</style>
