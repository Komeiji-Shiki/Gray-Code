<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import type { CompanionConfiguration, CompanionView } from '@graycode/contracts';
import { rpc } from '../api';
import { shellText as t } from '../i18n';

const props = defineProps<{ conversationId?: string }>();
const emit = defineEmits<{
  close: [];
  applied: [conversationId: string];
  memory: [];
  reminders: [];
  greeting: [conversationId: string];
}>();
const dialog = ref<HTMLDialogElement>();
const conversationId = props.conversationId;
const form = reactive<CompanionConfiguration>({
  enabled: false, name: '', userName: '', tone: '', characterField: 'auto',
});
const cards = ref<CompanionView['characters']>([]);
const pets = ref<CompanionView['pets']>([]);
const petHostAvailable = ref(false);
const title = ref('');
const metadataToken = ref<string>();
const defaultsRevision = ref<number | null>(null);
const hasDefaults = ref(false);
const saveAsDefault = ref(false);
const ready = ref(false);
const busy = ref(false);
const error = ref('');
const notice = ref('');
const confirmLeave = ref(false);
const destination = ref<'close' | 'memory' | 'reminders' | 'greeting'>('close');
let saved = '';
const dirty = computed(() => ready.value && (JSON.stringify(form) !== saved || saveAsDefault.value));

function leave() {
  // 先撤下原生模态窗口，再打开工作台面板，避免新面板被顶层窗口挡住。
  emit('close');
  if (destination.value === 'memory') emit('memory');
  else if (destination.value === 'reminders') emit('reminders');
  else if (destination.value === 'greeting' && conversationId) emit('greeting', conversationId);
}

function requestClose(next: typeof destination.value = 'close') {
  if (busy.value) return;
  destination.value = next;
  if (dirty.value) confirmLeave.value = true;
  else leave();
}

async function save() {
  busy.value = true;
  error.value = '';
  try {
    const result = await rpc('companion.save', {
      conversationId,
      configuration: form,
      metadataToken: metadataToken.value,
      defaultsRevision: defaultsRevision.value,
      saveAsDefault: saveAsDefault.value,
    });
    emit('applied', result.conversationId);
    emit('close');
  } catch (cause) {
    error.value = (cause as Error).message;
  } finally {
    busy.value = false;
  }
}

async function clearDefaults() {
  busy.value = true;
  error.value = '';
  try {
    await rpc('companion.defaults.clear', { defaultsRevision: defaultsRevision.value });
    defaultsRevision.value = null;
    hasDefaults.value = false;
    notice.value = t('companionDefaultsCleared');
  } catch (cause) {
    error.value = (cause as Error).message;
  } finally {
    busy.value = false;
  }
}

onMounted(async () => {
  dialog.value?.showModal();
  busy.value = true;
  try {
    const value = await rpc('companion.get', { conversationId });
    Object.assign(form, value.configuration);
    cards.value = value.characters;
    pets.value = value.pets;
    petHostAvailable.value = value.petHostAvailable;
    title.value = value.title ?? '';
    metadataToken.value = value.metadataToken;
    defaultsRevision.value = value.defaultsRevision;
    hasDefaults.value = value.hasDefaults;
    saved = JSON.stringify(form);
    ready.value = true;
  } catch (cause) {
    error.value = (cause as Error).message;
  } finally {
    busy.value = false;
  }
});
</script>

<template>
  <dialog ref="dialog" class="companion-setup" aria-labelledby="companion-title" @cancel.prevent="requestClose()">
    <header>
      <div>
        <h2 id="companion-title">{{ t('companionTitle') }}</h2>
        <p>{{ title || t('companionNewConversation') }}</p>
      </div>
      <button :disabled="busy" @click="requestClose()">{{ t('close') }}</button>
    </header>
    <form @submit.prevent="save">
      <p v-if="error" class="companion-error" role="alert">{{ error }}</p>
      <p v-if="notice" role="status">{{ notice }}</p>
      <template v-if="ready">
        <label class="companion-check">
          <input v-model="form.enabled" type="checkbox">
          {{ t('companionEnabled') }}
        </label>
        <p>{{ t('companionMemoryHint') }}</p>
        <label>
          {{ t('companionCharacter') }}
          <select v-model="form.characterId">
            <option :value="undefined">{{ t('companionCustomIdentity') }}</option>
            <option v-for="card in cards" :key="card.id" :value="card.id">{{ card.name }}</option>
          </select>
          <small>{{ t('companionCharacterHint') }}</small>
        </label>
        <label v-if="form.characterId">
          {{ t('companionCharacterField') }}
          <select v-model="form.characterField">
            <option value="auto">{{ t('companionFieldAuto') }}</option>
            <option value="personality">{{ t('companionFieldPersonality') }}</option>
            <option value="description">{{ t('companionFieldDescription') }}</option>
            <option value="both">{{ t('companionFieldBoth') }}</option>
          </select>
        </label>
        <div class="companion-names">
          <label>
            {{ t('companionName') }}
            <input v-model="form.name" maxlength="100" :placeholder="t('companionNamePlaceholder')">
          </label>
          <label>
            {{ t('companionUserName') }}
            <input v-model="form.userName" maxlength="100" :placeholder="t('companionUserNamePlaceholder')">
          </label>
        </div>
        <label>
          {{ t('companionTone') }}
          <textarea v-model="form.tone" rows="5" maxlength="4000" :placeholder="t('companionTonePlaceholder')"></textarea>
        </label>
        <label>
          {{ t('companionPet') }}
          <select v-model="form.petResourceId">
            <option :value="undefined">{{ t('companionNoPet') }}</option>
            <option v-for="pet in pets" :key="pet.id" :value="pet.id">{{ pet.name }}</option>
          </select>
          <small>{{ t('companionPetHint') }}</small>
          <small v-if="!petHostAvailable">{{ t('companionPetUnavailable') }}</small>
        </label>
        <div class="companion-links">
          <button type="button" :disabled="busy" @click="requestClose('memory')">{{ t('companionOpenMemory') }}</button>
          <button type="button" :disabled="busy" @click="requestClose('reminders')">{{ t('companionOpenAutomations') }}</button>
          <button type="button" :disabled="busy || !conversationId" @click="requestClose('greeting')">
            {{ t('companionGreeting') }}
          </button>
        </div>
        <p>{{ t('companionAutomationHint') }}</p>
        <label class="companion-check">
          <input v-model="saveAsDefault" type="checkbox">
          {{ t('companionSaveDefault') }}
        </label>
        <small>{{ t('companionDefaultHint') }}</small>
        <button v-if="hasDefaults" class="companion-clear" type="button" :disabled="busy" @click="clearDefaults">
          {{ t('companionClearDefault') }}
        </button>
        <footer>
          <span v-if="dirty">{{ t('companionUnsaved') }}</span>
          <button class="primary" type="submit" :disabled="busy">
            {{ busy ? t('companionSaving') : conversationId ? t('companionSaveCurrent') : t('companionCreate') }}
          </button>
        </footer>
      </template>
      <p v-else-if="busy">{{ t('companionLoading') }}</p>
    </form>
    <section v-if="confirmLeave" class="companion-leave" role="alert">
      <p>{{ t('companionLeaveWarning') }}</p>
      <button @click="confirmLeave = false">{{ t('companionKeepEditing') }}</button>
      <button @click="leave">{{ t('companionDiscard') }}</button>
    </section>
  </dialog>
</template>

<style scoped>
.companion-setup {
  width: min(660px, calc(100vw - 24px));
  max-height: calc(100dvh - 56px);
  padding: 0;
  margin: auto;
  box-sizing: border-box;
  border: 1px solid var(--gc-border-subtle);
  border-radius: var(--gc-radius-md);
  color: var(--gc-text-primary);
  background: var(--gc-surface-base);
}
.companion-setup::backdrop {
  background: color-mix(in srgb, var(--gc-surface-sunken) 70%, transparent);
}
header {
  position: sticky;
  top: 0;
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 16px 20px;
  border-bottom: 1px solid var(--gc-border-subtle);
  background: var(--gc-surface-base);
  z-index: 1;
}
h2 { font-size: 17px; margin: 0; }
header p { margin: 5px 0 0; }
form { padding: 20px; }
p, small { font-size: 12px; line-height: 1.7; color: var(--gc-text-muted); }
label { display: flex; flex-direction: column; gap: 8px; margin-bottom: 17px; min-width: 0; }
.companion-check { flex-direction: row; align-items: center; margin-bottom: 10px; }
.companion-names { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
input, select, textarea, button {
  font: inherit;
  color: var(--gc-text-primary);
  border: 1px solid var(--gc-border-control);
  border-radius: var(--gc-radius-sm);
  background: var(--gc-surface-sunken);
  padding: 8px 10px;
  min-width: 0;
  box-sizing: border-box;
}
button { cursor: pointer; }
button:disabled { cursor: default; opacity: .6; }
textarea { resize: vertical; }
.companion-links { display: flex; gap: 10px; flex-wrap: wrap; }
.companion-clear { display: block; margin-top: 12px; }
footer { display: flex; gap: 12px; justify-content: flex-end; align-items: center; margin-top: 22px; }
footer span { color: var(--gc-text-muted); font-size: 12px; }
.primary { background: var(--gc-button-primary); color: var(--gc-text-on-primary); }
.companion-error { color: var(--gc-danger); }
.companion-leave {
  position: sticky;
  bottom: 0;
  background: var(--gc-surface-raised);
  border-top: 1px solid var(--gc-border-subtle);
  padding: 16px 20px;
}
.companion-leave button + button { margin-left: 10px; }
@media (max-width: 540px) {
  .companion-names { grid-template-columns: 1fr; gap: 0; }
  form { padding: 15px; }
  .companion-setup { max-height: calc(100dvh - 20px); }
}
</style>
