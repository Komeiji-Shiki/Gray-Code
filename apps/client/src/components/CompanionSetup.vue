<script setup lang="ts">
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import type { AutomationView, CompanionConfiguration, CompanionView, ScreenSenseSnapshot } from '@graycode/contracts';
import { call, rpc } from '../api';
import { shellText as t } from '../i18n';
import ScreenSenseSettings from './ScreenSenseSettings.vue';
import AutomationsPanel from './AutomationsPanel.vue';
import CompanionVocabularySync from './CompanionVocabularySync.vue';
const PetManager = defineAsyncComponent(() => import('./PetManager.vue'));

const props = defineProps<{ conversationId?: string; initialStep?: 'character' | 'pet' | 'screen' | 'greeting' }>();
const emit = defineEmits<{
  close: [];
  applied: [conversationId: string];
  memory: [];
  reminders: [];
  greeting: [conversationId: string];
}>();
const dialog = ref<HTMLDialogElement>();
const conversationId = ref(props.conversationId);
const form = reactive<CompanionConfiguration>({
  enabled: false, name: '', userName: '', tone: '', characterField: 'auto',
});
const cards = ref<CompanionView['characters']>([]);
const pets = ref<CompanionView['pets']>([]);
const petHostAvailable = ref(false);
const vocabulary = ref<CompanionView['petVocabulary']>();
const screen = ref<ScreenSenseSnapshot>();
const automations = ref<AutomationView[]>([]);
const childDirty = reactive({ screen: false, greeting: false, pet: false });
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
const saved = ref('');
const configurationDirty = computed(() => ready.value && (JSON.stringify(form) !== saved.value || saveAsDefault.value));
const dirty = computed(() => configurationDirty.value || Object.values(childDirty).some(Boolean));
const characterSummary = computed(() => cards.value.find(card => card.id === form.characterId)?.name || form.name || t('companionCustomIdentity'));
const petSummary = computed(() => pets.value.find(pet => pet.id === form.petResourceId)?.name || form.petResourceId || t('companionNoPet'));
const screenConfiguration = computed(() => {
  const configuration = screen.value?.configuration;
  return configuration?.conversationId === conversationId.value ? configuration : undefined;
});
const screenSummary = computed(() => {
  const configured = screenConfiguration.value;
  if (!configured) return t('companionFlowScreenEmpty');
  const target = configured.target.kind === 'window' ? configured.target.window.title : t('screenDisplay', {
    id: configured.target.display.id, width: configured.target.display.bounds.width, height: configured.target.display.bounds.height,
  });
  return `${target} · ${configured.visionModelId || t('screenProviderDefault')}`;
});
const greeting = computed(() => automations.value.find(row => row.conversationId === conversationId.value
  && row.kind === 'schedule' && row.status !== 'completed'));
const greetingSummary = computed(() => {
  const row = greeting.value;
  if (!row) return t('companionFlowGreetingEmpty');
  const schedule = row.schedule;
  const cadence = schedule?.type === 'daily' ? `${schedule.time} · ${schedule.timeZone}`
    : schedule?.type === 'once' ? new Date(schedule.at).toLocaleString()
    : schedule && 'everyMinutes' in schedule ? t('companionFlowEveryMinutes', { minutes: schedule.everyMinutes }) : '';
  return `${row.name} · ${cadence} · ${t(row.status === 'active' ? 'companionFlowRunning' : 'companionFlowPaused')}`;
});
let disposed = false;

function leave() {
  // 先撤下原生模态窗口，再打开工作台面板，避免新面板被顶层窗口挡住。
  emit('close');
  if (destination.value === 'memory') emit('memory');
  else if (destination.value === 'reminders') emit('reminders');
  else if (destination.value === 'greeting' && conversationId.value) emit('greeting', conversationId.value);
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
      conversationId: conversationId.value,
      configuration: form,
      metadataToken: metadataToken.value,
      defaultsRevision: defaultsRevision.value,
      saveAsDefault: saveAsDefault.value,
    });
    if (disposed) return;
    conversationId.value = result.conversationId!;
    const view = await rpc('companion.get', { conversationId: conversationId.value });
    if (disposed) return;
    applyView(view);
    saveAsDefault.value = false;
    notice.value = t('companionFlowSaved');
    emit('applied', conversationId.value!);
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
    if (!conversationId.value) vocabulary.value = undefined;
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
    const [value, sense, tasks] = await Promise.all([
      rpc('companion.get', { conversationId: conversationId.value }), rpc('screenSense.get'), call<AutomationView[]>('automations.list'),
    ]);
    if (disposed) return;
    applyView(value);
    screen.value = sense;
    automations.value = tasks;
    ready.value = true;
  } catch (cause) {
    error.value = (cause as Error).message;
  } finally {
    busy.value = false;
  }
});
function applyVocabularySync(value: CompanionView) {
  metadataToken.value = value.metadataToken;
  defaultsRevision.value = value.defaultsRevision;
  vocabulary.value = value.petVocabulary;
}
async function refreshPets(resources: CompanionView['pets']) {
  pets.value = resources;
  const id = conversationId.value;
  try {
    const value = await rpc('companion.get', { conversationId: id });
    if (!disposed && id === conversationId.value) vocabulary.value = value.petVocabulary;
  } catch (cause) {
    if (!disposed) error.value = (cause as Error).message;
  }
}
function applyView(value: CompanionView) {
  Object.assign(form, value.configuration);
  cards.value = value.characters;
  pets.value = value.pets;
  petHostAvailable.value = value.petHostAvailable;
  title.value = value.title ?? '';
  hasDefaults.value = value.hasDefaults;
  applyVocabularySync(value);
  saved.value = JSON.stringify(form);
}
onBeforeUnmount(() => { disposed = true; });
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
    <div class="companion-content">
      <p v-if="error" class="companion-error" role="alert">{{ error }}</p>
      <p v-if="notice" role="status">{{ notice }}</p>
      <template v-if="ready">
        <label class="companion-check">
          <input v-model="form.enabled" type="checkbox">
          {{ t('companionEnabled') }}
        </label>
        <p>{{ t('companionMemoryHint') }}</p>
        <section class="companion-step" data-step="character">
          <details :open="!initialStep || initialStep === 'character'">
            <summary>
              <span class="companion-step-number">01</span>
              <span class="companion-step-heading"><strong>{{ t('companionFlowCharacter') }}</strong><small>{{ characterSummary }}</small></span>
              <span class="companion-step-status">{{ t(form.characterId || form.name || form.tone ? 'companionFlowConfigured' : 'companionFlowNotConfigured') }}</span>
            </summary>
            <div class="companion-step-content">
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
              <button type="button" :disabled="busy" @click="requestClose('memory')">{{ t('companionOpenMemory') }}</button>
            </div>
          </details>
        </section>
        <section class="companion-step" data-step="pet">
          <details :open="initialStep === 'pet'">
            <summary>
              <span class="companion-step-number">02</span>
              <span class="companion-step-heading"><strong>{{ t('companionFlowPet') }}</strong><small>{{ petSummary }}</small></span>
              <span class="companion-step-status">{{ t(form.petResourceId ? 'companionFlowConfigured' : 'companionFlowNotConfigured') }}</span>
            </summary>
            <div class="companion-step-content">
              <label>
                {{ t('companionPet') }}
                <select v-model="form.petResourceId">
                  <option :value="undefined">{{ t('companionNoPet') }}</option>
                  <option v-for="pet in pets" :key="pet.id" :value="pet.id">{{ pet.name }}</option>
                </select>
                <small>{{ t('companionPetHint') }}</small>
                <small v-if="!petHostAvailable">{{ t('companionPetUnavailable') }}</small>
              </label>
              <CompanionVocabularySync :conversation-id="conversationId" :pet-resource-id="form.petResourceId"
                :vocabulary="vocabulary" :metadata-token="metadataToken" :defaults-revision="defaultsRevision" :disabled="busy"
                @synced="applyVocabularySync" @busy="busy = $event" />
              <PetManager embedded :selected-resource-id="form.petResourceId" @select-resource="form.petResourceId = $event"
                @resources-changed="refreshPets" @dirty="childDirty.pet = $event" />
            </div>
          </details>
        </section>
        <section class="companion-step" data-step="screen">
          <details :open="initialStep === 'screen'">
            <summary>
              <span class="companion-step-number">03</span>
              <span class="companion-step-heading"><strong>{{ t('companionFlowScreen') }}</strong><small>{{ screenSummary }}</small></span>
              <span class="companion-step-status">{{ t(screenConfiguration ? 'companionFlowConfigured' : 'companionFlowNotConfigured') }}</span>
            </summary>
            <div class="companion-step-content">
              <ScreenSenseSettings v-if="conversationId" :key="conversationId" embedded :conversation-id="conversationId"
                @changed="screen = $event" @dirty="childDirty.screen = $event" />
              <p v-else>{{ t('companionFlowSaveFirst') }}</p>
            </div>
          </details>
        </section>
        <section class="companion-step" data-step="greeting">
          <details :open="initialStep === 'greeting'">
            <summary>
              <span class="companion-step-number">04</span>
              <span class="companion-step-heading"><strong>{{ t('companionFlowGreeting') }}</strong><small>{{ greetingSummary }}</small></span>
              <span class="companion-step-status">{{ t(greeting ? 'companionFlowConfigured' : 'companionFlowNotConfigured') }}</span>
            </summary>
            <div class="companion-step-content">
              <p>{{ t('companionAutomationHint') }}</p>
              <AutomationsPanel v-if="conversationId" :key="conversationId" open embedded :companion-request="{ conversationId }"
                @changed="automations = $event" @dirty="childDirty.greeting = $event" />
              <p v-else>{{ t('companionFlowSaveFirst') }}</p>
              <button class="companion-all-tasks" type="button" :disabled="busy" @click="requestClose('reminders')">
                {{ t('companionOpenAutomations') }}
              </button>
            </div>
          </details>
        </section>
        <label class="companion-check">
          <input v-model="saveAsDefault" type="checkbox">
          {{ t('companionSaveDefault') }}
        </label>
        <small>{{ t('companionDefaultHint') }}</small>
        <button v-if="hasDefaults" class="companion-clear" type="button" :disabled="busy" @click="clearDefaults">
          {{ t('companionClearDefault') }}
        </button>
      </template>
      <p v-else-if="busy">{{ t('companionLoading') }}</p>
    </div>
    <footer v-if="ready">
      <span v-if="configurationDirty">{{ t('companionUnsaved') }}</span>
      <button class="primary" type="button" :disabled="busy" @click="save">
        {{ busy ? t('companionSaving') : conversationId ? t('companionFlowSaveProfile') : t('companionCreate') }}
      </button>
    </footer>
    <section v-if="confirmLeave" class="companion-leave" role="alert">
      <p>{{ t('companionLeaveWarning') }}</p>
      <button @click="confirmLeave = false">{{ t('companionKeepEditing') }}</button>
      <button @click="leave">{{ t('companionDiscard') }}</button>
    </section>
  </dialog>
</template>

<style scoped>
.companion-setup {
  width: min(920px, calc(100vw - 24px));
  max-height: calc(100dvh - 56px);
  padding: 0;
  margin: auto;
  box-sizing: border-box;
  border: 1px solid var(--gc-border-subtle);
  border-radius: 0;
  color: var(--gc-text-primary);
  background: var(--gc-surface-base);
}
.companion-setup::backdrop {
  background: color-mix(in srgb, var(--gc-surface-sunken) 70%, transparent);
}
.companion-setup[open] { display: flex; flex-direction: column; }
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
  flex-shrink: 0;
}
h2 { font-size: 17px; margin: 0; }
header p { margin: 5px 0 0; }
.companion-content { padding: 20px; min-height: 0; overflow: auto; }
.companion-step { margin: 18px 0; background: var(--gc-surface-raised); }
.companion-step summary { display: flex; align-items: center; gap: 14px; padding: 16px; cursor: pointer; list-style: none; }
.companion-step-number { color: var(--gc-text-muted); font-size: 12px; }
.companion-step-heading { display: flex; flex: 1; min-width: 0; flex-direction: column; gap: 5px; }
.companion-step-heading strong { font-size: 14px; font-weight: 500; }
.companion-step-heading small { overflow-wrap: anywhere; }
.companion-step-status { font-size: 12px; color: var(--gc-text-muted); white-space: nowrap; }
.companion-step-content { padding: 6px 16px 18px; background: var(--gc-surface-base); }
.companion-all-tasks { margin-top: 18px; }
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
footer { display: flex; gap: 12px; justify-content: flex-end; align-items: center; padding: 14px 20px; flex-shrink: 0; }
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
  .companion-content { padding: 15px; }
  .companion-setup { max-height: calc(100dvh - 20px); }
}
</style>
