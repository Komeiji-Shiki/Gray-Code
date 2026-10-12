<script setup lang="ts">
import { useI18n } from '@/i18n'
import ContextSettings from './ContextSettings.vue'
import SummarizeSettings from './SummarizeSettings.vue'
import TokenCountSettings from './TokenCountSettings.vue'

const { t } = useI18n()
</script>

<template>
  <div class="unified-context-settings">
    <SummarizeSettings />
    <details class="context-extra-section" data-search-anchor="context-token-count">
      <summary>{{ t('components.settings.contextPage.exactCountTitle') }}</summary>
      <p class="section-description">{{ t('components.settings.contextPage.exactCountDescription') }}</p>
      <TokenCountSettings />
    </details>
    <details class="context-extra-section" data-search-anchor="context-awareness">
      <summary>{{ t('components.settings.contextPage.awarenessTitle') }}</summary>
      <p class="section-description">{{ t('components.settings.contextPage.awarenessDescription') }}</p>
      <ContextSettings />
    </details>
  </div>
</template>

<style scoped>
.unified-context-settings { display: grid; gap: var(--gc-space-5); }
.unified-context-settings :deep(.section) { border-radius: 0; }
.context-extra-section { min-width: 0; padding: var(--gc-space-4); background: var(--gc-surface-panel); }
summary { color: var(--gc-text-primary); font-size: var(--gc-font-size-title); font-weight: var(--gc-font-weight-medium); cursor: pointer; }
.section-description { margin: var(--gc-space-3) 0 var(--gc-space-4); color: var(--gc-text-muted); line-height: 1.7; }
</style>
