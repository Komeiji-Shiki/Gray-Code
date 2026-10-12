<script setup lang="ts">
import { shellText as t } from '../i18n';
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import type { CharacterChatConfig, CharacterResource } from '@graycode/contracts';
import { call, uiRequest } from '../api';
import { state } from '../state';
import { shellText } from '../i18n';
const props = defineProps<{ characterId?: string }>();
const emit = defineEmits<{ close: [] }>();
const dialog = ref<HTMLDialogElement>();
const conversationId = state.conversationId;
const ready = ref(false),
  confirmLeave = ref(false);
let saved = '';
const resources = ref<Pick<CharacterResource, 'id' | 'name' | 'kind'>[]>([]);
const characterId = ref(props.characterId ?? '');
const userName = ref('');
const persona = ref('');
const worldbookIds = ref<string[]>([]);
const regexIds = ref<string[]>([]);
const scanDepth = ref<number | ''>(2);
const greetings = ref<string[]>([]);
const greetingIndex = ref(0);
const recursiveScan = ref('');
const maxRecursionSteps = ref<number | ''>('');
let greetingEpoch = 0;
const tokenBudget = ref<number | ''>('');
const metadataToken = ref('');
const canSave = ref(false);
const busy = ref(false);
const error = ref('');
const draftKey = () =>
  JSON.stringify([
    characterId.value,
    userName.value,
    persona.value,
    worldbookIds.value,
    regexIds.value,
    scanDepth.value,
    tokenBudget.value,
    greetingIndex.value,
    recursiveScan.value,
    maxRecursionSteps.value,
  ]);
const dirty = computed(() => ready.value && draftKey() !== saved);
function requestClose() {
  if (busy.value) return;
  if (dirty.value) confirmLeave.value = true;
  else emit('close');
}
async function save(create: boolean) {
  if (busy.value || !ready.value) return;
  busy.value = true;
  error.value = '';
  try {
    if (scanDepth.value === '') throw new Error(t('uiCharacterSetupScanDepthRequired'));
    const config: CharacterChatConfig = {
      kind: 'character',
      characterId: characterId.value || undefined,
      greetingIndex: greetingIndex.value,
      userName: userName.value,
      persona: persona.value,
      worldbookIds: worldbookIds.value,
      regexIds: regexIds.value,
      scanDepth: Number(scanDepth.value),
      worldTokenBudget: tokenBudget.value === '' ? undefined : Number(tokenBudget.value),
      recursiveScan: recursiveScan.value === '' ? undefined : recursiveScan.value === 'true',
      maxRecursionSteps: maxRecursionSteps.value === '' ? undefined : Number(maxRecursionSteps.value),
    };
    const result = create
      ? await uiRequest('characters.conversation.create', { config })
      : await uiRequest('characters.conversation.save', { config, conversationId: conversationId!, metadataToken: metadataToken.value });
    if ('conversationId' in result) {
      state.mode = 'character';
      state.chatFocused = true;
      await call('ui.command', { command: 'platform.openModeConversation', data: result });
    }
    emit('close');
  } catch (cause) {
    error.value = (cause as Error).message;
  } finally {
    busy.value = false;
  }
}
watch(
  characterId,
  async (id) => {
    const epoch = ++greetingEpoch;
    greetings.value = [];
    if (!id) return;
    try {
      const result = await uiRequest('characters.definition', { id });
      if (epoch !== greetingEpoch) return;
      greetings.value = result.greetings;
      if (greetingIndex.value >= result.greetings.length) greetingIndex.value = 0;
    } catch (cause) {
      if (epoch === greetingEpoch) error.value = (cause as Error).message;
    }
  },
  { immediate: true },
);
onMounted(async () => {
  dialog.value?.showModal();
  busy.value = true;
  try {
    resources.value = await uiRequest('characters.list');
    if (conversationId && !props.characterId) {
      const result = await uiRequest('characters.conversation.get', { conversationId });
      metadataToken.value = result.metadataToken;
      canSave.value = result.mode === 'character';
      if (result.config) {
        characterId.value = result.config.characterId ?? '';
        userName.value = result.config.userName;
        persona.value = result.config.persona;
        worldbookIds.value = [...result.config.worldbookIds];
        regexIds.value = [...result.config.regexIds];
        scanDepth.value = result.config.scanDepth;
        tokenBudget.value = result.config.worldTokenBudget ?? '';
        greetingIndex.value = result.config.greetingIndex ?? 0;
        recursiveScan.value = result.config.recursiveScan === undefined ? '' : String(result.config.recursiveScan);
        maxRecursionSteps.value = result.config.maxRecursionSteps ?? '';
      }
    }
    saved = draftKey();
    ready.value = true;
  } catch (cause) {
    error.value = (cause as Error).message;
  } finally {
    busy.value = false;
  }
});
onUnmounted(() => {
  greetingEpoch++;
});
</script>
<template>
  <dialog ref="dialog" class="character-setup" :aria-label="t('uiCharacterSetupCharacterConversationConfiguration')" @cancel.prevent="requestClose">
    <header>
      <strong>{{ t('uiCharacterSetupCharacterConversation') }}</strong>
      <button :disabled="busy" @click="requestClose">{{ t('close') }}</button>
    </header>
    <div class="character-form">
      <p v-if="error" class="character-error" role="alert">{{ error }}</p>
      <label>
        {{ t('uiResourceLibraryCharacterCard') }}
        <select v-model="characterId">
          <option value="">{{ t('uiCharacterSetupNoCharacterCard') }}</option>
          <option v-for="resource in resources.filter((item) => item.kind === 'character')" :key="resource.id" :value="resource.id">{{ resource.name }}</option>
        </select>
      </label>
      <label v-if="greetings.length">
        {{ t('uiCharacterSetupNewConversationGreeting') }}
        <select v-model="greetingIndex">
          <option :value="-1">{{ t('uiCharacterSetupNoGreeting') }}</option>
          <option v-for="(greeting, index) in greetings" :key="index" :value="index">
            {{ index + 1 }} · {{ greeting.slice(0, 70) || t('uiCharacterSetupEmptyGreeting') }}
          </option>
        </select>
      </label>
      <label>
        {{ t('uiCharacterSetupUserCharacterName') }}
        <input v-model="userName" :placeholder="t('uiCharacterSetupUserNamePlaceholder')" />
      </label>
      <label>
        {{ t('uiCharacterSetupUserCharacterDescription') }}
        <textarea v-model="persona" rows="4" :placeholder="t('uiCharacterSetupUserDescriptionPlaceholder')"></textarea>
      </label>
      <fieldset>
        <legend>{{ t('uiCharacterSetupAdditionalLorebooks') }}</legend>
        <label v-for="book in resources.filter((item) => item.kind === 'worldbook')" :key="book.id" class="check">
          <input v-model="worldbookIds" type="checkbox" :value="book.id" />
          {{ book.name }}
        </label>
        <p>{{ t('uiCharacterSetupAdditionalLorebooksHelp') }}</p>
      </fieldset>
      <fieldset>
        <legend>{{ t('uiCharacterSetupAdditionalRegex') }}</legend>
        <label v-for="regex in resources.filter((item) => item.kind === 'regex')" :key="regex.id" class="check">
          <input v-model="regexIds" type="checkbox" :value="regex.id" />
          {{ regex.name }}
        </label>
      </fieldset>
      <div class="number-fields">
        <label>
          {{ t('uiCharacterSetupDefaultScanDepth') }}
          <input v-model="scanDepth" type="number" min="0" step="1" />
          <small>{{ t('uiCharacterSetupScanDepthHelp') }}</small>
        </label>
        <label>
          {{ t('uiCharacterSetupMaxLorebookTokens') }}
          <input v-model="tokenBudget" type="number" min="0" step="1" :placeholder="shellText('characterWorldBudgetPlaceholder')" />
          <small>{{ shellText('characterWorldBudgetHelp') }}</small>
        </label>
      </div>
      <details>
        <summary>{{ t('uiCharacterSetupAdvancedLorebookSettings') }}</summary>
        <label>
          {{ t('uiCharacterSetupRecursiveScanning') }}
          <select v-model="recursiveScan">
            <option value="">{{ t('uiCharacterSetupUseLorebookConfiguration') }}</option>
            <option value="true">{{ t('uiCharacterSetupEnable') }}</option>
            <option value="false">{{ t('close') }}</option>
          </select>
        </label>
        <label>
          {{ t('uiCharacterSetupMaxScanPasses') }}
          <input v-model="maxRecursionSteps" type="number" min="0" step="1" :placeholder="t('uiCharacterSetupScanPassesPlaceholder')" />
          <small>{{ t('uiCharacterSetupScanPassesHelp') }}</small>
        </label>
      </details>
      <p>{{ t('uiCharacterSetupPresetToolBindingsHelp') }}</p>
      <footer>
        <span v-if="dirty" class="settings-help">{{ t('uiCharacterSetupUnsavedChanges') }}</span>
        <button v-if="canSave" :disabled="busy || !ready" @click="save(false)">{{ t('uiCharacterSetupSaveCurrentCharacterConversation') }}</button>
        <button :disabled="busy || !ready" @click="save(true)">{{ t('uiCharacterSetupNewCharacterConversation') }}</button>
      </footer>
    </div>
    <div v-if="confirmLeave" class="character-leave" role="alert">
      <p>{{ t('uiCharacterSetupCharacterConfigurationUnsaved') }}</p>
      <button @click="confirmLeave = false">{{ t('uiResourceLibraryKeepEditing') }}</button>
      <button @click="emit('close')">{{ t('uiCharacterSetupDiscardAndClose') }}</button>
    </div>
  </dialog>
</template>
<style scoped>
.character-setup {
  width: min(720px, calc(100vw - 28px));
  height: min(820px, calc(100dvh - 40px));
  padding: 0;
  margin: auto;
  overflow: hidden;
  background: var(--gc-surface-base);
  border: 1px solid var(--gc-border-subtle);
  color: var(--gc-text-primary);
  box-shadow: var(--gc-shadow-md);
}
.character-setup > header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 14px 20px;
  border-bottom: 1px solid var(--gc-border-subtle);
}
.character-setup[open] {
  display: flex;
  flex-direction: column;
}
.character-setup::backdrop {
  background: var(--gc-backdrop);
}
.character-form {
  overflow: auto;
  padding: 20px;
  flex: 1;
  min-height: 0;
}
.character-leave {
  padding: 14px 20px;
  border-top: 1px solid var(--gc-border-subtle);
  background: var(--gc-surface-raised);
}
.character-leave p {
  font-size: 12px;
  color: var(--gc-text-muted);
}
.character-leave button + button {
  margin-left: 8px;
}
.character-form label {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 16px;
}
.character-setup input,
.character-setup select,
.character-setup textarea,
.character-setup button {
  border-radius: var(--gc-radius-sm);
  border: 1px solid var(--gc-border-control);
  background: var(--gc-surface-sunken);
  color: var(--gc-text-primary);
  font: inherit;
  padding: 8px 10px;
}
.character-setup button {
  cursor: pointer;
}
.character-setup fieldset {
  border: 1px solid var(--gc-border-subtle);
  margin-bottom: 20px;
  padding: 16px;
}
.character-form .check {
  flex-direction: row;
  align-items: center;
}
.character-form p,
.character-form small {
  font-size: 12px;
  line-height: 1.7;
  color: var(--gc-text-muted);
}
.number-fields {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 20px;
}
.character-form footer {
  display: flex;
  gap: 10px;
  justify-content: flex-end;
  margin-top: 20px;
}
.character-form .character-error {
  color: var(--gc-danger);
}
@media (max-width: 600px) {
  .character-setup {
    width: calc(100vw - 12px);
    height: calc(100dvh - 20px);
  }
  .number-fields {
    grid-template-columns: 1fr;
  }
}
</style>
