<script setup lang="ts">
import { shellText as t } from '../i18n';
import { computed } from 'vue';
import type { DebugAdapterInfo, DebugConfiguration } from '@graycode/contracts';
interface Draft {
  configuration: DebugConfiguration;
  argsText: string;
  envText: string;
  optionsText: string;
}
const props = defineProps<{ draft: Draft; adapters: DebugAdapterInfo[]; saving: boolean }>();
const emit = defineEmits<{ save: []; remove: [] }>();
const adapter = computed(() => props.adapters.find((value) => value.id === props.draft.configuration.adapterId));
</script>
<template>
  <form class="debug-configuration" @submit.prevent="emit('save')">
    <div class="configuration-fields">
      <label>
        {{ t('uiDebugConfigurationEditorConfigName') }}
        <input v-model="draft.configuration.name" required :aria-label="t('uiDebugConfigurationEditorConfigurationName')" />
      </label>
      <label>
        {{ t('uiDebugConfigurationEditorDebugger') }}
        <select v-model="draft.configuration.adapterId" :aria-label="t('uiDebugConfigurationEditorDebugger')">
          <option v-for="item in adapters" :key="item.id" :value="item.id">{{ item.name }}</option>
        </select>
      </label>
      <label>
        {{ t('uiDebugConfigurationEditorDebugMode') }}
        <select v-model="draft.configuration.request" :aria-label="t('uiDebugConfigurationEditorDebugMode')">
          <option value="launch">{{ t('uiDebugConfigurationEditorLaunchProgram') }}</option>
          <option value="attach">{{ t('uiDebugConfigurationEditorAttachProcess') }}</option>
        </select>
      </label>
      <label v-if="draft.configuration.request === 'launch'">
        {{ t('uiDebugConfigurationEditorProgramFile') }}
        <input
          v-model="draft.configuration.program"
          :placeholder="t('uiDebugConfigurationEditorProgramFilePlaceholder')"
          :aria-label="t('uiDebugConfigurationEditorDebugProgramFile')"
        />
      </label>
      <label>
        {{ t('uiDebugConfigurationEditorWorkingDirectory') }}
        <input
          v-model="draft.configuration.cwd"
          :placeholder="t('uiDebugConfigurationEditorWorkingDirectoryPlaceholder')"
          :aria-label="t('uiDebugConfigurationEditorDebugWorkingDirectory')"
        />
      </label>
      <label v-if="draft.configuration.request === 'launch'">
        {{ t('uiDebugConfigurationEditorProgramInputOutput') }}
        <select v-model="draft.configuration.console" :aria-label="t('uiDebugConfigurationEditorDebugInputOutput')">
          <option :value="undefined">{{ t('uiDebugConfigurationEditorAutoSelect') }}</option>
          <option value="integratedTerminal">{{ t('uiDebugConfigurationEditorProgramTerminalOption') }}</option>
          <option value="internalConsole">{{ t('uiDebugConfigurationEditorDebugConsoleOption') }}</option>
        </select>
      </label>
      <label v-if="['node', 'python'].includes(draft.configuration.adapterId)">
        {{ draft.configuration.adapterId === 'python' ? t('uiDebugConfigurationEditorPythonInterpreter') : t('uiDebugConfigurationEditorNodeExecutable') }}
        <input
          v-model="draft.configuration.runtimeExecutable"
          :placeholder="
            draft.configuration.adapterId === 'python'
              ? t('uiDebugConfigurationEditorPythonPathPlaceholder')
              : t('uiDebugConfigurationEditorNodePathPlaceholder')
          "
          :aria-label="t('uiDebugConfigurationEditorDebugExecutable')"
        />
      </label>
      <template v-if="draft.configuration.request === 'attach'">
        <label>
          {{ t('uiDebugConfigurationEditorListeningHost') }}
          <input v-model="draft.configuration.host" placeholder="127.0.0.1" :aria-label="t('uiDebugConfigurationEditorDebugListeningHost')" />
        </label>
        <label>
          {{ t('uiDebugConfigurationEditorListeningPort') }}
          <input v-model.number="draft.configuration.port" type="number" min="1" max="65535" :aria-label="t('uiDebugConfigurationEditorDebugListeningPort')" />
        </label>
      </template>
    </div>
    <p v-if="adapter?.requirement" class="muted">{{ adapter.requirement }}</p>
    <p v-if="draft.configuration.request === 'attach'" class="muted">{{ t('uiDebugConfigurationEditorAttachProcessHelp') }}</p>
    <details>
      <summary>{{ t('uiDebugConfigurationEditorAdvancedRunOptions') }}</summary>
      <label>
        {{ t('uiDebugConfigurationEditorProgramArguments') }}
        <textarea v-model="draft.argsText" rows="3" spellcheck="false" :aria-label="t('uiDebugConfigurationEditorDebugArguments')"></textarea>
      </label>
      <label>
        {{ t('uiDebugConfigurationEditorEnvironmentVariables') }}
        <textarea v-model="draft.envText" rows="3" spellcheck="false" :aria-label="t('uiDebugConfigurationEditorDebugEnvironmentVariables')"></textarea>
      </label>
      <label>
        {{ t('uiDebugConfigurationEditorAdapterOptions') }}
        <textarea v-model="draft.optionsText" rows="6" spellcheck="false" :aria-label="t('uiDebugConfigurationEditorAdvancedDebugOptions')"></textarea>
      </label>
      <p class="muted">{{ t('uiDebugConfigurationEditorAdapterOptionsHelp') }}</p>
    </details>
    <div class="configuration-actions">
      <button type="submit" :disabled="saving">{{ t('uiDebugConfigurationEditorSaveConfiguration') }}</button>
      <button type="button" :disabled="saving" @click="emit('remove')">{{ t('uiDebugConfigurationEditorDeleteConfiguration') }}</button>
    </div>
  </form>
</template>
<style scoped>
.debug-configuration {
  display: grid;
  gap: 12px;
  padding: 14px;
  border-bottom: 1px solid var(--gc-border-subtle);
}
.configuration-fields {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 220px), 1fr));
  gap: 12px;
}
label {
  display: grid;
  gap: 6px;
  font-size: 12px;
}
input,
select,
textarea {
  box-sizing: border-box;
  min-width: 0;
  width: 100%;
  border: 1px solid var(--gc-border-control);
  border-radius: var(--gc-radius-sm);
  background: var(--gc-surface-raised);
  color: var(--gc-text-primary);
  padding: 8px;
  font: inherit;
}
textarea {
  font-family: var(--gc-font-code);
  resize: vertical;
}
summary {
  cursor: pointer;
  padding: 7px 0;
}
details label {
  margin-top: 10px;
}
.configuration-actions {
  display: flex;
  gap: 8px;
}
button {
  border: 1px solid var(--gc-border-control);
  border-radius: var(--gc-radius-sm);
  background: var(--gc-surface-raised);
  color: var(--gc-text-primary);
  padding: 7px 12px;
  cursor: pointer;
}
.muted {
  font-size: 12px;
  line-height: 1.65;
  color: var(--gc-text-muted);
  margin: 0;
}
</style>
