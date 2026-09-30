<script setup lang="ts">
import { t } from '@/i18n'
import { useDesktopUpdates } from './useDesktopUpdates'
const { installation, busy, message, failed, percent, phase, action, formatDate } = useDesktopUpdates()
</script>

<template>
  <section class="desktop-update" data-preference-transient data-desktop-update :aria-label="t('desktop.updateTitle')">
    <header class="update-overview">
      <div class="update-product"><span class="product-mark" aria-hidden="true">G</span><div><strong>GrayCode</strong><p>{{ t('desktop.updateTitle') }}</p></div></div>
      <div v-if="installation" class="version-summary"><span class="version-label">{{ t('desktop.currentVersion') }}</span><strong>{{ installation.currentVersion }}</strong><span class="gc-badge">{{ t(installation.kind === 'installed' ? 'desktop.installedKind' : 'desktop.portableKind') }}</span></div>
      <span v-else role="status">{{ t('desktop.loadingUpdate') }}</span>
    </header>
    <p v-if="installation?.rootDirectory" class="path">{{ installation.rootDirectory }}</p>
    <p v-if="installation?.kind === 'portable'">{{ t('desktop.portableHint') }}</p>
    <div class="actions">
      <button type="button" class="gc-button" :disabled="busy" @click="action('checkUpdateNow')">{{ t('desktop.checkUpdate') }}</button>
      <template v-if="installation?.kind === 'installed'">
        <button type="button" class="gc-button" :disabled="busy" @click="action('updateNow')">{{ t('desktop.downloadUpdate') }}</button>
        <button type="button" class="gc-button" :disabled="busy" @click="action('desktop.updates.local')">{{ t('desktop.offlineUpdate') }}</button>
      </template>
      <button type="button" class="gc-button gc-button--ghost" @click="action('openUpdatePage')">{{ t('desktop.releasePage') }}</button>
    </div>
    <div v-if="installation?.progress" class="update-progress" role="status" aria-live="polite">
      <div><span>{{ phase }}</span><span v-if="percent !== undefined">{{ Math.round(percent) }}%</span></div>
      <progress :value="percent" max="100" :aria-label="phase" />
    </div>
    <div v-if="installation?.ready" class="ready">
      <div class="section-heading"><span class="status-dot" aria-hidden="true"></span><strong>{{ t('desktop.readyTitle') }}</strong><span class="version-chip">{{ installation.ready.version }}</span></div>
      <p>{{ t('desktop.readyDescription', { version: installation.ready.version }) }}</p>
      <div class="actions"><button type="button" class="gc-button gc-button--primary" :disabled="busy" @click="action('desktop.updates.apply')">{{ t('desktop.restartInstall') }}</button></div>
    </div>
    <section v-if="installation?.recovery" class="recovery">
      <div class="section-heading"><strong>{{ t('desktop.restorePoint') }}</strong><span class="version-chip">{{ installation.recovery.version }}</span></div>
      <time :datetime="installation.recovery.createdAt">{{ formatDate(installation.recovery.createdAt) }}</time>
      <p>{{ t('desktop.recoveryHint') }}</p><p>{{ t('desktop.recoveryRescue') }}</p>
      <div class="actions">
        <button type="button" class="gc-button" :disabled="busy || installation.recovery.version === installation.currentVersion" @click="action('desktop.updates.rollback')">{{ t('desktop.rollback') }}</button>
        <button type="button" class="gc-button gc-button--ghost" @click="action('desktop.updates.openRecovery')">{{ t('desktop.openRecovery') }}</button>
      </div>
    </section>
    <p v-if="installation?.transitionResult === 'not-applied'" class="notice" role="status">{{ t('desktop.transitionFailed', { version: installation.currentVersion }) }}</p>
    <p v-if="message" class="notice" :class="{ error: failed }" :role="failed ? 'alert' : 'status'">{{ message }}</p>
  </section>
</template>

<style scoped>
.desktop-update { display: grid; gap: 14px; min-width: 0; margin-top: 12px; font-size: var(--gc-font-size-control); }
p { margin: 0; line-height: 1.65; color: var(--gc-text-muted); overflow-wrap: anywhere; }
.update-overview { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 18px; padding-bottom: 16px; }
.update-product { display: flex; align-items: center; gap: 12px; }
.update-product strong { font-size: 19px; letter-spacing: -.02em; }
.product-mark { display: grid; place-items: center; width: 40px; height: 40px; border: 1px solid var(--gc-accent); font-size: 24px; color: var(--gc-accent); }
.version-summary { display: grid; gap: 4px; justify-items: end; }
.version-label, time { color: var(--gc-text-muted); font-size: 12px; }
.version-summary strong, .version-chip { font-family: var(--gc-font-code); }
.version-chip { padding: 2px 7px; border: 1px solid var(--gc-border-subtle); font-size: 12px; }
.path { font-family: var(--gc-font-code); font-size: 12px; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; }
.actions button { min-height: 34px; white-space: normal; }
.ready, .recovery { display: grid; gap: 10px; padding: 16px; border: 1px solid var(--gc-border-subtle); background: var(--gc-surface-muted); border-radius: 2px; min-width: 0; }
.ready { border-left: 2px solid var(--gc-accent); }
.section-heading { display: flex; align-items: center; flex-wrap: wrap; gap: 9px; }
.status-dot { width: 6px; height: 6px; background: var(--gc-success); }
.update-progress { display: grid; gap: 8px; }.update-progress > div { display: flex; justify-content: space-between; gap: 10px; }
progress { appearance: none; width: 100%; height: 4px; border: 0; accent-color: var(--gc-accent); }
progress::-webkit-progress-bar { background: var(--gc-border-subtle); }progress::-webkit-progress-value { background: var(--gc-accent); }
.notice { padding: 11px 13px; border-left: 2px solid var(--gc-accent); background: var(--gc-surface-muted); }.error { color: var(--gc-danger); border-left-color: var(--gc-danger); }
@media (max-width: 520px) { .version-summary { justify-items: start; } .ready, .recovery { padding: 12px; }.actions { flex-direction: column; }.actions button { width: 100%; } }
</style>
