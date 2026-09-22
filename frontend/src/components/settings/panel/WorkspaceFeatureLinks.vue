<script setup lang="ts">
import { useI18n } from '@/i18n';
const props = defineProps<{ area: 'memory' | 'companions' }>();
const { t } = useI18n();
const host = window.__GRAYCODE_HOST;
const label = (key: string) => t(`components.settings.workspaceFeatureLinks.${key}`);
</script>
<template>
  <section v-if="host?.openWorkspacePanel" class="workspace-feature-links">
    <h4>{{ label(props.area === 'memory' ? 'memoryTitle' : 'companionsTitle') }}</h4>
    <p>{{ label(props.area === 'memory' ? 'memoryHint' : 'companionsHint') }}</p>
    <div>
      <button v-if="props.area === 'memory'" type="button" @click="host.openWorkspacePanel('memory')">{{ label('openMemory') }}</button>
      <template v-else>
        <button type="button" @click="host.openWorkspacePanel('pets')">{{ label('openPets') }}</button>
        <button type="button" @click="host.openWorkspacePanel('screenSense')">{{ label('openScreenSense') }}</button>
      </template>
    </div>
  </section>
</template>
<style scoped>
.workspace-feature-links { display: grid; gap: 10px; padding: 16px; margin-bottom: 20px; border: 1px solid var(--gc-border-subtle); border-left: 2px solid var(--gc-link); background: var(--gc-surface-panel); }
h4 { margin: 0; font-size: var(--gc-font-size-title); } p { margin: 0; color: var(--gc-text-muted); font-size: 12px; line-height: 1.7; }
.workspace-feature-links > div { display: flex; gap: 10px; flex-wrap: wrap; }
button { border: 1px solid var(--gc-border-control); border-radius: 0; color: var(--gc-text-primary); background: var(--gc-surface-raised); padding: 7px 11px; font: inherit; cursor: pointer; }
button:hover { background: var(--gc-surface-hover); }
</style>
