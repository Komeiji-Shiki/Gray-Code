<script setup lang="ts">
import { CustomCheckbox } from '../common'
import { formatFileSize } from '@/utils/file'
import NotificationQuietHours from './NotificationQuietHours.vue'
import { useSoundSettings } from './useSoundSettings'

const {
  t,
  isLoading,
  isSaving,
  saveMessage,
  saveMessageType,
  testMessage,
  testMessageType,
  builtinAssets,
  assetMessage,
  assetMessageType,
  enabled,
  quietHours,
  volume,
  volumeText,
  cooldownMs,
  cueWarning,
  cueError,
  cueTaskComplete,
  cueTaskError,
  cueSubagentWarning,
  cueSubagentError,
  cueSubagentTaskComplete,
  cueSubagentTaskError,
  windowsAgentStopNotificationEnabled,
  windowsAgentStopNotificationOnlyWhenWindowNotFocused,
  windowsAgentStopNotificationCaseError,
  windowsAgentStopNotificationCaseAwaitingUserAction,
  windowsAgentStopNotificationCaseContinueRequired,
  windowsAgentStopNotificationTitleTemplate,
  windowsAgentStopNotificationErrorBodyTemplate,
  windowsAgentStopNotificationAwaitingUserActionBodyTemplate,
  windowsAgentStopNotificationContinueRequiredBodyTemplate,
  windowsAgentStopTemplateVariables,
  assetWarning,
  assetError,
  assetTaskComplete,
  assetTaskError,
  assetFileInputRef,
  MAX_ASSET_BYTES,
  triggerSelectAsset,
  handleAssetFileChange,
  clearAsset,
  testCue,
  triggerWindowsNotificationPreview,
  saveConfig,
  resetToDefault
} = useSoundSettings()
</script>

<template>
  <div class="sound-settings">
    <div v-if="isLoading" class="loading">
      <i class="codicon codicon-loading codicon-modifier-spin"></i>
      <span>{{ t('common.loading') }}</span>
    </div>

    <template v-else>
      <div class="panel-overview">
        <div class="section-title">{{ t('components.settings.soundSettings.overview.title') }}</div>
        <p class="section-description">{{ t('components.settings.soundSettings.overview.description') }}</p>
      </div>

      <NotificationQuietHours v-model="quietHours" />

      <section class="settings-area">
        <div class="section-header">
          <div class="section-title">{{ t('components.settings.soundSettings.sections.sound.title') }}</div>
          <p class="section-description">{{ t('components.settings.soundSettings.sections.sound.description') }}</p>
        </div>

        <div class="section-body">
          <div class="form-group" data-search-anchor="sound-enabled">
            <label class="group-label">
              <i class="codicon codicon-bell"></i>
              {{ t('components.settings.soundSettings.enabled.title') }}
            </label>
            <p class="field-description">{{ t('components.settings.soundSettings.enabled.description') }}</p>

            <CustomCheckbox v-model="enabled" :label="t('components.settings.soundSettings.enabled.label')" />
          </div>

          <div class="form-group" data-search-anchor="volume">
            <label class="group-label">
              <i class="codicon codicon-unmute"></i>
              {{ t('components.settings.soundSettings.volume.title') }}
            </label>
            <p class="field-description">{{ t('components.settings.soundSettings.volume.description') }}</p>

            <div class="slider-row">
              <input
                v-model.number="volume"
                class="range"
                type="range"
                min="0"
                max="100"
                step="1"
              />
              <div class="range-value">{{ volumeText }}</div>
            </div>
          </div>

          <div class="form-group" data-search-anchor="min-interval">
            <label class="group-label">
              <i class="codicon codicon-clock"></i>
              {{ t('components.settings.soundSettings.cooldown.title') }}
            </label>
            <p class="field-description">{{ t('components.settings.soundSettings.cooldown.description') }}</p>

            <div class="slider-row">
              <input
                v-model.number="cooldownMs"
                class="range"
                type="range"
                min="0"
                max="5000"
                step="100"
              />
              <div class="range-value">{{ cooldownMs }}ms</div>
            </div>
          </div>

          <div class="form-group" data-search-anchor="event-types">
            <label class="group-label">
              <i class="codicon codicon-symbol-event"></i>
              {{ t('components.settings.soundSettings.cues.title') }}
            </label>
            <p class="field-description">{{ t('components.settings.soundSettings.cues.description') }}</p>

            <div class="cue-group">
              <div class="cue-group-title">{{ t('components.settings.soundSettings.cues.main') }}</div>
              <div class="cues-grid">
                <CustomCheckbox v-model="cueWarning" :label="t('components.settings.soundSettings.cues.warning')" />
                <CustomCheckbox v-model="cueError" :label="t('components.settings.soundSettings.cues.error')" />
                <CustomCheckbox v-model="cueTaskComplete" :label="t('components.settings.soundSettings.cues.taskComplete')" />
                <CustomCheckbox v-model="cueTaskError" :label="t('components.settings.soundSettings.cues.taskError')" />
              </div>
            </div>

            <div class="cue-group">
              <div class="cue-group-title">{{ t('components.settings.soundSettings.cues.subagent') }}</div>
              <div class="cues-grid">
                <CustomCheckbox v-model="cueSubagentWarning" :label="t('components.settings.soundSettings.cues.warning')" />
                <CustomCheckbox v-model="cueSubagentError" :label="t('components.settings.soundSettings.cues.error')" />
                <CustomCheckbox v-model="cueSubagentTaskComplete" :label="t('components.settings.soundSettings.cues.taskComplete')" />
                <CustomCheckbox v-model="cueSubagentTaskError" :label="t('components.settings.soundSettings.cues.taskError')" />
              </div>
            </div>
          </div>

          <div class="form-group" data-search-anchor="custom-sounds">
            <label class="group-label">
              <i class="codicon codicon-file-media"></i>
              {{ t('components.settings.soundSettings.assets.title') }}
            </label>
            <p class="field-description">
              {{
                t('components.settings.soundSettings.assets.description', {
                  size: formatFileSize(MAX_ASSET_BYTES)
                })
              }}
            </p>

            <input
              ref="assetFileInputRef"
              type="file"
              accept="audio/*"
              style="display: none"
              @change="handleAssetFileChange"
            />

            <div class="assets-list">
              <div class="asset-row">
                <div class="asset-row-left">
                  <div class="asset-row-title">{{ t('components.settings.soundSettings.cues.warning') }}</div>
                  <div class="asset-row-value">
                    {{ assetWarning?.name || builtinAssets.warning?.name || t('components.settings.soundSettings.assets.none') }}
                  </div>
                </div>
                <div class="asset-row-actions">
                  <button class="action-btn" @click="triggerSelectAsset('warning')">
                    <i class="codicon codicon-folder-opened"></i>
                    {{ t('components.settings.soundSettings.assets.choose') }}
                  </button>
                  <button v-if="assetWarning" class="action-btn" @click="clearAsset('warning')">
                    <i class="codicon codicon-trash"></i>
                    {{ t('components.settings.soundSettings.assets.clear') }}
                  </button>
                </div>
              </div>

              <div class="asset-row">
                <div class="asset-row-left">
                  <div class="asset-row-title">{{ t('components.settings.soundSettings.cues.error') }}</div>
                  <div class="asset-row-value">
                    {{ assetError?.name || builtinAssets.error?.name || t('components.settings.soundSettings.assets.none') }}
                  </div>
                </div>
                <div class="asset-row-actions">
                  <button class="action-btn" @click="triggerSelectAsset('error')">
                    <i class="codicon codicon-folder-opened"></i>
                    {{ t('components.settings.soundSettings.assets.choose') }}
                  </button>
                  <button v-if="assetError" class="action-btn" @click="clearAsset('error')">
                    <i class="codicon codicon-trash"></i>
                    {{ t('components.settings.soundSettings.assets.clear') }}
                  </button>
                </div>
              </div>

              <div class="asset-row">
                <div class="asset-row-left">
                  <div class="asset-row-title">{{ t('components.settings.soundSettings.cues.taskComplete') }}</div>
                  <div class="asset-row-value">
                    {{ assetTaskComplete?.name || builtinAssets.taskComplete?.name || t('components.settings.soundSettings.assets.none') }}
                  </div>
                </div>
                <div class="asset-row-actions">
                  <button class="action-btn" @click="triggerSelectAsset('taskComplete')">
                    <i class="codicon codicon-folder-opened"></i>
                    {{ t('components.settings.soundSettings.assets.choose') }}
                  </button>
                  <button v-if="assetTaskComplete" class="action-btn" @click="clearAsset('taskComplete')">
                    <i class="codicon codicon-trash"></i>
                    {{ t('components.settings.soundSettings.assets.clear') }}
                  </button>
                </div>
              </div>

              <div class="asset-row">
                <div class="asset-row-left">
                  <div class="asset-row-title">{{ t('components.settings.soundSettings.cues.taskError') }}</div>
                  <div class="asset-row-value">
                    {{ assetTaskError?.name || builtinAssets.taskError?.name || builtinAssets.error?.name || t('components.settings.soundSettings.assets.none') }}
                  </div>
                </div>
                <div class="asset-row-actions">
                  <button class="action-btn" @click="triggerSelectAsset('taskError')">
                    <i class="codicon codicon-folder-opened"></i>
                    {{ t('components.settings.soundSettings.assets.choose') }}
                  </button>
                  <button v-if="assetTaskError" class="action-btn" @click="clearAsset('taskError')">
                    <i class="codicon codicon-trash"></i>
                    {{ t('components.settings.soundSettings.assets.clear') }}
                  </button>
                </div>
              </div>
            </div>

            <span v-if="assetMessage" class="test-message" :class="assetMessageType">
              {{ assetMessage }}
            </span>
          </div>

          <div class="form-group" data-search-anchor="test-play">
            <label class="group-label">
              <i class="codicon codicon-play"></i>
              {{ t('components.settings.soundSettings.test.title') }}
            </label>
            <p class="field-description">{{ t('components.settings.soundSettings.test.description') }}</p>

            <div class="test-buttons">
              <button class="action-btn" @click="testCue('warning')">
                {{ t('components.settings.soundSettings.test.warning') }}
              </button>
              <button class="action-btn" @click="testCue('error')">
                {{ t('components.settings.soundSettings.test.error') }}
              </button>
              <button class="action-btn" @click="testCue('taskComplete')">
                {{ t('components.settings.soundSettings.test.taskComplete') }}
              </button>
              <button class="action-btn" @click="testCue('taskError')">
                {{ t('components.settings.soundSettings.test.taskError') }}
              </button>
            </div>

            <span v-if="testMessage" class="test-message" :class="testMessageType">
              {{ testMessage }}
            </span>
          </div>
        </div>
      </section>

      <section class="settings-area">
        <div class="section-header">
          <div class="section-title">{{ t('components.settings.soundSettings.sections.windowsNotification.title') }}</div>
          <p class="section-description">{{ t('components.settings.soundSettings.sections.windowsNotification.description') }}</p>
        </div>

        <div class="section-body">
          <div class="form-group" data-search-anchor="win-agent-notify">
            <label class="group-label">
              <i class="codicon codicon-bell-dot"></i>
              {{ t('components.settings.soundSettings.windowsAgentStopNotification.optionsTitle') }}
            </label>
            <p class="field-description">{{ t('components.settings.soundSettings.windowsAgentStopNotification.description') }}</p>
            <p class="inline-hint">{{ t('components.settings.soundSettings.windowsAgentStopNotification.rawTextHint') }}</p>
            <p class="inline-hint">{{ t('components.settings.soundSettings.windowsAgentStopNotification.bestEffortClickHint') }}</p>

            <CustomCheckbox
              v-model="windowsAgentStopNotificationEnabled"
              :label="t('components.settings.soundSettings.windowsAgentStopNotification.enabled')"
            />
            <CustomCheckbox
              v-model="windowsAgentStopNotificationOnlyWhenWindowNotFocused"
              :label="t('components.settings.soundSettings.windowsAgentStopNotification.onlyWhenWindowNotFocused')"
            />

            <div class="template-field">
              <label class="template-label">{{ t('components.settings.soundSettings.windowsAgentStopNotification.casesTitle') }}</label>
            </div>

            <div class="cues-grid">
              <CustomCheckbox v-model="windowsAgentStopNotificationCaseError" :label="t('components.settings.soundSettings.windowsAgentStopNotification.cases.error')" />
              <CustomCheckbox v-model="windowsAgentStopNotificationCaseAwaitingUserAction" :label="t('components.settings.soundSettings.windowsAgentStopNotification.cases.awaitingUserAction')" />
              <CustomCheckbox v-model="windowsAgentStopNotificationCaseContinueRequired" :label="t('components.settings.soundSettings.windowsAgentStopNotification.cases.continueRequired')" />
            </div>

            <div class="template-field">
              <label class="template-label">{{ t('components.settings.soundSettings.windowsAgentStopNotification.templates.title') }}</label>
              <p class="inline-hint">{{ t('components.settings.soundSettings.windowsAgentStopNotification.templates.description') }}</p>
            </div>

            <div class="template-grid">
              <div class="template-field">
                <label class="template-label">{{ t('components.settings.soundSettings.windowsAgentStopNotification.templates.titleTemplate') }}</label>
                <input v-model="windowsAgentStopNotificationTitleTemplate" class="template-input" type="text">
              </div>
              <div class="template-field">
                <label class="template-label">{{ t('components.settings.soundSettings.windowsAgentStopNotification.templates.errorBodyTemplate') }}</label>
                <textarea v-model="windowsAgentStopNotificationErrorBodyTemplate" class="template-textarea" rows="2"></textarea>
              </div>
              <div class="template-field">
                <label class="template-label">{{ t('components.settings.soundSettings.windowsAgentStopNotification.templates.awaitingUserActionBodyTemplate') }}</label>
                <textarea v-model="windowsAgentStopNotificationAwaitingUserActionBodyTemplate" class="template-textarea" rows="2"></textarea>
              </div>
              <div class="template-field">
                <label class="template-label">{{ t('components.settings.soundSettings.windowsAgentStopNotification.templates.continueRequiredBodyTemplate') }}</label>
                <textarea v-model="windowsAgentStopNotificationContinueRequiredBodyTemplate" class="template-textarea" rows="2"></textarea>
              </div>
              <div class="template-field">
                <label class="template-label">{{ t('components.settings.soundSettings.windowsAgentStopNotification.templates.variables') }}</label>
                <p class="inline-hint">{{ t('components.settings.soundSettings.windowsAgentStopNotification.templates.variablesHint') }}</p>
                <div class="variable-list">
                  <code v-for="variable in windowsAgentStopTemplateVariables" :key="variable" class="variable-chip">{{ variable }}</code>
                </div>
              </div>
              <div class="template-field">
                <label class="template-label">{{ t('components.settings.soundSettings.windowsAgentStopNotification.preview.title') }}</label>
                <p class="inline-hint">{{ t('components.settings.soundSettings.windowsAgentStopNotification.preview.description') }}</p>
                <div class="test-buttons">
                  <button class="action-btn" @click="triggerWindowsNotificationPreview('error')">{{ t('components.settings.soundSettings.windowsAgentStopNotification.preview.error') }}</button>
                  <button class="action-btn" @click="triggerWindowsNotificationPreview('awaiting_user_action')">{{ t('components.settings.soundSettings.windowsAgentStopNotification.preview.awaitingUserAction') }}</button>
                  <button class="action-btn" @click="triggerWindowsNotificationPreview('continue_required')">{{ t('components.settings.soundSettings.windowsAgentStopNotification.preview.continueRequired') }}</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <div class="actions">
        <button class="action-btn primary" @click="saveConfig().catch(() => {})" :disabled="isSaving">
          <i v-if="isSaving" class="codicon codicon-loading codicon-modifier-spin"></i>
          <span v-else>{{ t('common.save') }}</span>
        </button>

        <button class="action-btn" @click="resetToDefault().catch(() => {})" :disabled="isSaving">
          <i class="codicon codicon-discard"></i>
          {{ t('common.reset') }}
        </button>

        <span v-if="saveMessage" class="save-message" :class="saveMessageType">
          {{ saveMessage }}
        </span>
      </div>
    </template>
  </div>
</template>

<style scoped>
.sound-settings {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.panel-overview,
.settings-area {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px;
  border: 1px solid transparent;
  border-radius: var(--gc-radius-lg);
  background: var(--gc-surface-raised);
}

.section-header,
.section-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.section-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--gc-text-primary);
}

.section-description {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--gc-text-muted);
}

.loading {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--gc-text-muted);
  padding: 16px 0;
}

.form-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px;
  border-radius: var(--gc-radius-sm);
}

.group-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 500;
}

.group-label .codicon {
  font-size: 14px;
}

.field-description {
  margin: 0 0 8px 0;
  font-size: 12px;
  color: var(--gc-text-muted);
}

.slider-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.range {
  flex: 1;
}

.range-value {
  min-width: 70px;
  text-align: right;
  font-size: 12px;
  color: var(--gc-text-muted);
}

.cues-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}

.cue-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.cue-group-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--gc-text-muted);
}

.assets-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.asset-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px;
  border: 1px solid transparent;
  border-radius: var(--gc-radius-sm);
  background: var(--gc-surface-muted);
}

.asset-row-left {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.asset-row-title {
  font-size: 12px;
  font-weight: 500;
}

.asset-row-value {
  font-size: 12px;
  color: var(--gc-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 360px;
}

.asset-row-actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}

.asset-row .action-btn {
  padding: 4px 10px;
}

.test-buttons {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.inline-hint {
  margin: 0;
  font-size: 12px;
  color: var(--gc-text-muted);
}

.template-grid {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.template-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.template-label {
  font-size: 12px;
  font-weight: 500;
}

.template-input,
.template-textarea {
  width: 100%;
  padding: 8px 10px;
  font-size: 12px;
  color: var(--gc-text-primary);
  background: var(--gc-surface-input);
  border: 1px solid var(--gc-border-control);
  border-radius: var(--gc-radius-sm);
  box-sizing: border-box;
}

.template-textarea {
  resize: vertical;
  min-height: 56px;
}

.variable-list {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.variable-chip {
  padding: 2px 6px;
  border-radius: var(--gc-radius-sm);
  background: var(--gc-badge-bg);
  color: var(--gc-badge-fg);
}

.actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.action-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  font-size: 12px;
  background: var(--gc-button-secondary);
  color: var(--gc-text-on-secondary);
  border: none;
  border-radius: var(--gc-radius-sm);
  cursor: pointer;
  transition: background-color 0.15s;
}

.action-btn:hover:not(:disabled) {
  background: var(--gc-button-secondary-hover);
}

.action-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.action-btn.primary {
  background: var(--gc-button-primary);
  color: var(--gc-text-on-primary);
}

.save-message,
.test-message {
  font-size: 12px;
}

.save-message.success,
.test-message.success {
  color: var(--gc-success);
}

.save-message.error,
.test-message.error {
  color: var(--gc-danger);
}
</style>
