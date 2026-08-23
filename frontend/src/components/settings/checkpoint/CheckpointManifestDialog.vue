<script setup lang="ts">
/** CheckpointManifestDialog - 存档排除清单详情弹窗。 */
import { t } from '@/i18n'
import type { CheckpointManifest } from '@/types'
import { Modal } from '../../common'

defineProps<{
  checkpointId: string | null
  detail: CheckpointManifest | null
  isLoading: boolean
  loadError: string | null
  excludedCount: number
  enabledProfileIds: string[]
  rulesChanged: () => boolean
  profileLabel: (profileId: string) => string
  formatSize: (size: number) => string
}>()

const emit = defineEmits<{
  (e: 'close'): void
}>()
</script>

<template>
  <Modal
    :model-value="!!checkpointId"
    :aria-label="t('components.settings.checkpoint.sections.cleanup.manifestDetail')"
    width="480px"
    body-padding="compact"
    @close="emit('close')"
  >
    <template #header>
      <div class="dialog-heading">
        <i class="codicon codicon-filter" aria-hidden="true"></i>
        <h3>{{ t('components.settings.checkpoint.sections.cleanup.manifestDetail') }}</h3>
      </div>
    </template>

    <div class="manifest-body">
      <div v-if="isLoading" class="manifest-loading" role="status" aria-live="polite">
        <i class="codicon codicon-loading codicon-modifier-spin" aria-hidden="true"></i>
        <span>{{ t('components.settings.checkpoint.sections.cleanup.loading') }}</span>
      </div>
      <p v-else-if="loadError" class="manifest-error gc-feedback gc-feedback--error" role="alert">
        <i class="codicon codicon-warning" aria-hidden="true"></i>
        <span>{{ t('components.settings.checkpoint.sections.cleanup.manifestLoadFailed') }}</span>
      </p>
      <div v-else-if="!detail" class="manifest-unavailable gc-feedback" role="status">
        <i class="codicon codicon-info" aria-hidden="true"></i>
        <span>{{ t('components.settings.checkpoint.sections.cleanup.manifestUnavailable') }}</span>
      </div>
      <div v-else class="manifest-content">
        <div class="manifest-stat gc-card">
          <span class="manifest-stat-label">{{ t('components.settings.checkpoint.sections.cleanup.manifestExcludedCount') }}</span>
          <span class="manifest-stat-value">{{ excludedCount }}</span>
        </div>
        <p class="manifest-note">
          {{ t('components.settings.checkpoint.sections.cleanup.manifestNote', { count: excludedCount }) }}
        </p>
        <p v-if="rulesChanged()" class="manifest-rules-changed gc-feedback gc-feedback--warning">
          <i class="codicon codicon-warning" aria-hidden="true"></i>
          <span>{{ t('components.settings.checkpoint.sections.cleanup.manifestRulesChanged') }}</span>
        </p>
        <template v-if="detail.ignoreSnapshot">
          <div class="manifest-section-title">
            {{ t('components.settings.checkpoint.sections.cleanup.manifestIgnoreSnapshot') }}
          </div>
          <div class="manifest-rows">
            <div class="manifest-row">
              <span class="manifest-row-label">{{ t('components.settings.checkpoint.sections.cleanup.manifestRuleVersion') }}</span>
              <span>{{ detail.ignoreSnapshot.version }}</span>
            </div>
            <div class="manifest-row">
              <span class="manifest-row-label">{{ t('components.settings.checkpoint.sections.cleanup.manifestForcedRulesVersion') }}</span>
              <span>{{ detail.ignoreSnapshot.forcedRulesVersion }}</span>
            </div>
            <div class="manifest-row">
              <span class="manifest-row-label">{{ t('components.settings.checkpoint.sections.cleanup.manifestDefaultProfileVersion') }}</span>
              <span>{{ detail.ignoreSnapshot.defaultProfileVersion }}</span>
            </div>
            <div class="manifest-row">
              <span class="manifest-row-label">{{ t('components.settings.checkpoint.sections.cleanup.manifestMaxFileSize') }}</span>
              <span>{{ formatSize(detail.ignoreSnapshot.maxFileSizeBytes) }}</span>
            </div>
            <div class="manifest-row">
              <span class="manifest-row-label">{{ t('components.settings.checkpoint.sections.cleanup.manifestEnabledProfiles') }}</span>
              <span v-if="enabledProfileIds.length > 0" class="manifest-profiles">
                {{ enabledProfileIds.map(profileLabel).join('、') }}
              </span>
              <span v-else>{{ t('components.settings.checkpoint.sections.cleanup.manifestNone') }}</span>
            </div>
            <div class="manifest-row">
              <span class="manifest-row-label">{{ t('components.settings.checkpoint.sections.cleanup.manifestCustomPatterns') }}</span>
              <span v-if="detail.ignoreSnapshot.customPatterns?.length > 0" class="manifest-patterns">
                {{ detail.ignoreSnapshot.customPatterns.join('、') }}
              </span>
              <span v-else>{{ t('components.settings.checkpoint.sections.cleanup.manifestNone') }}</span>
            </div>
          </div>
        </template>
      </div>
    </div>

    <template #footer>
      <button type="button" class="gc-button" @click="emit('close')">
        {{ t('components.settings.checkpoint.sections.cleanup.manifestClose') }}
      </button>
    </template>
  </Modal>
</template>

<style scoped>
.dialog-heading {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: var(--gc-space-2);
}

.dialog-heading .codicon {
  flex-shrink: 0;
  color: var(--gc-text-muted);
  font-size: var(--gc-icon-size-md);
}

.dialog-heading h3 {
  margin: 0;
  font-size: var(--gc-font-size-title);
  font-weight: var(--gc-font-weight-medium);
}

.manifest-body {
  overflow-y: auto;
  font-size: var(--gc-font-size-control);
  line-height: var(--gc-line-height-normal);
}

.manifest-loading {
  display: flex;
  align-items: center;
  gap: var(--gc-space-2);
  color: var(--gc-text-muted);
}

.manifest-loading .codicon {
  color: var(--vscode-progressBar-background, var(--gc-info));
}

.manifest-error,
.manifest-unavailable,
.manifest-rules-changed,
.manifest-note {
  margin: 0;
}

.manifest-stat {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  padding: var(--gc-space-2) var(--gc-space-3);
  box-shadow: none;
}

.manifest-stat-label,
.manifest-note {
  color: var(--gc-text-muted);
  font-size: var(--gc-font-size-body);
}

.manifest-stat-value {
  font-size: var(--gc-font-size-display);
  font-weight: var(--gc-font-weight-semibold);
}

.manifest-note,
.manifest-rules-changed {
  margin-top: var(--gc-space-3);
}

.manifest-section-title {
  margin: var(--gc-space-4) 0 var(--gc-space-2);
  color: var(--gc-text-muted);
  font-size: var(--gc-font-size-body);
  font-weight: var(--gc-font-weight-semibold);
  letter-spacing: 0.03em;
  text-transform: uppercase;
}

.manifest-rows {
  overflow: hidden;
  border: 1px solid var(--gc-border-subtle);
  border-radius: var(--gc-radius-sm);
}

.manifest-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--gc-space-3);
  padding: 6px var(--gc-space-3);
  border-bottom: 1px solid var(--gc-border-subtle);
  font-size: var(--gc-font-size-body);
}

.manifest-row:last-child {
  border-bottom: 0;
}

.manifest-row-label {
  flex-shrink: 0;
  color: var(--gc-text-muted);
}

.manifest-profiles,
.manifest-patterns {
  max-width: 260px;
  text-align: right;
  overflow-wrap: anywhere;
}
</style>
