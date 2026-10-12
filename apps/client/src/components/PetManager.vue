<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { PET_DEFAULT_DURATION_MS, type PetAnimation, type PetCommandInput, type PetConfiguration,
  type PetParameter, type PetResource, type PetSnapshot } from '@graycode/contracts';
import { rpc } from '../api';
import { shellText } from '../i18n';
import { collectPetImport, fileBase64, selectedPath } from '../pets/importFiles';
import { clearPetRuntimeCache } from '../pets/assets';
import playerNotices from '../../public/pets-notices.txt?raw';
import { petAnimations } from '../../../../shared/petFormat';
import PetPlayer from './PetPlayer.vue';
import PetResourceAnnotations from './PetResourceAnnotations.vue';

const emit = defineEmits<{ close: []; screenSense: [] }>();
const dialog = ref<HTMLDialogElement>();
const player = ref<InstanceType<typeof PetPlayer>>();
const resources = ref<PetResource[]>([]);
const snapshot = ref<PetSnapshot>();
const selected = ref('');
const parameters = ref<PetParameter[]>([]);
const error = ref('');
const notice = ref('');
const busy = ref(false);
const previewReady = ref(false);
const confirmLeave = ref(false);
const confirmingRemove = ref(false);
const previewKey = ref(0);
const annotationsDirty = ref(false);
const pendingFiles = ref<File[]>([]);
const entry = ref('');
const source = ref('');
const license = ref('');
const importName = ref('');
const action = ref('');
const expression = ref('');
const angle = ref(0);
const parameterId = ref('');
const parameterValue = ref(0);
const duration = ref(PET_DEFAULT_DURATION_MS / 1000);
const configuration = reactive<PetConfiguration>({
  visible: false, surface: 'app', scale: 1, reducedMotion: false, stopped: false,
  taskAnimations: true, mappings: {}, soundEnabled: false, speechEnabled: false, followPointer: true,
});
const leaveDestination = ref<'close' | 'screenSense'>('close');
let savedDraft = '';
const dirty = computed(() => annotationsDirty.value || !!savedDraft && (
  JSON.stringify(configuration) !== savedDraft ||
  selected.value !== (configuration.resourceId ?? resources.value[0]?.id ?? '') || pendingFiles.value.length > 0
));
const resource = computed(() => resources.value.find(item => item.id === selected.value));
const manifests = computed(() => pendingFiles.value.filter(file => /(?:^|\/)pet\.json$|\.model3\.json$/i.test(selectedPath(file))));
const selectedParameter = computed(() => parameters.value.find(parameter => parameter.id === parameterId.value));
const previewConfiguration = computed(() => ({ ...configuration, stopped: false }));
const taskStates = petAnimations.filter(item => ['idle', 'running', 'waiting', 'review', 'failed'].includes(item.id));
const formatBytes = (value: number) => (value / 1024 / 1024).toFixed(2) + ' MiB';
const text = (key: Parameters<typeof shellText>[0], fields: Record<string, string | number> = {}) => {
  let value = shellText(key);
  for (const [name, replacement] of Object.entries(fields)) value = value.replaceAll('{' + name + '}', String(replacement));
  return value;
};
const animationText: Record<PetAnimation, Parameters<typeof shellText>[0]> = {
  idle: 'petAnimationIdle', 'running-right': 'petAnimationRight', 'running-left': 'petAnimationLeft',
  waving: 'petAnimationWaving', jumping: 'petAnimationJumping', failed: 'petAnimationFailed',
  waiting: 'petAnimationWaiting', running: 'petAnimationRunning', review: 'petAnimationReview',
};

async function perform(work: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  notice.value = '';
  try { await work(); } catch (cause) { error.value = (cause as Error).message; } finally { busy.value = false; }
}
async function reload() {
  const changed = !!savedDraft && JSON.stringify(configuration) !== savedDraft;
  const prior = snapshot.value;
  [resources.value, snapshot.value] = await Promise.all([rpc('pets.list'), rpc('pets.status')]);
  if (!changed) {
    Object.assign(configuration, snapshot.value.configuration);
    savedDraft = JSON.stringify(configuration);
  } else if (prior) snapshot.value.revision = prior.revision;
  if (!resources.value.some(item => item.id === selected.value)) {
    selected.value = configuration.resourceId ?? resources.value[0]?.id ?? '';
  }
}
function chooseFiles(event: Event) {
  pendingFiles.value = [...((event.target as HTMLInputElement).files ?? [])];
  entry.value = '';
  if (manifests.value.length === 1) entry.value = selectedPath(manifests.value[0]!);
  if (!manifests.value.length) error.value = shellText('petManifestMissing');
  (event.target as HTMLInputElement).value = '';
}
async function importResource() {
  const bundle = await collectPetImport(pendingFiles.value, entry.value);
  const result = await rpc('pets.import', { ...bundle, name: importName.value, source: source.value, license: license.value });
  pendingFiles.value = [];
  entry.value = '';
  selected.value = result.id;
  await reload();
  notice.value = shellText('petImported');
}
async function importRuntime(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  (event.target as HTMLInputElement).value = '';
  if (!file) return;
  await perform(async () => {
    await rpc('pets.runtime.import', { name: file.name, data: await fileBase64(file) });
    clearPetRuntimeCache();
    await reload();
    previewKey.value++;
    notice.value = shellText('petRuntimeImported');
  });
}
async function removeRuntime() {
  await rpc('pets.runtime.remove');
  clearPetRuntimeCache();
  await reload();
  previewKey.value++;
}
async function save() {
  if (!snapshot.value || !resource.value) return;
  await rpc('pets.configure', {
    revision: snapshot.value.revision,
    configuration: { ...configuration, resourceId: resource.value.id,
      mappings: configuration.resourceId === resource.value.id ? configuration.mappings : {} },
  });
  savedDraft = '';
  await reload();
  notice.value = shellText('petConfigurationSaved');
}
async function remove() {
  if (!snapshot.value) return;
  await rpc('pets.remove', { id: selected.value, revision: snapshot.value.revision });
  selected.value = '';
  confirmingRemove.value = false;
  await reload();
}
async function preview(command: PetCommandInput) {
  if (command.action !== 'cancel' && (!Number.isFinite(duration.value) || duration.value < 0.1 || duration.value > 120)) {
    throw new Error(shellText('petDurationInvalid'));
  }
  if (command.action === 'parameters') {
    const parameter = selectedParameter.value;
    if (!parameter || !Number.isFinite(parameterValue.value) || parameterValue.value < parameter.min || parameterValue.value > parameter.max) {
      throw new Error(text('petParameterInvalid', { min: parameter?.min ?? '', max: parameter?.max ?? '' }));
    }
  }
  await player.value?.apply({ ...command, durationMs: duration.value * 1000 });
  notice.value = shellText('petPreviewApplied');
}
function annotationSaved(value: PetResource) {
  resources.value = resources.value.map(resource => resource.id === value.id ? value : resource);
  annotationsDirty.value = false;
  notice.value = shellText('petAnnotationsSaved');
}
function setMapping(state: PetAnimation, event: Event) {
  const id = (event.target as HTMLSelectElement).value;
  if (id) configuration.mappings[state] = id;
  else delete configuration.mappings[state];
}
function leave() {
  emit('close');
  if (leaveDestination.value === 'screenSense') emit('screenSense');
}
function close(destination: 'close' | 'screenSense' = 'close') {
  if (busy.value) return;
  leaveDestination.value = destination;
  if (dirty.value) confirmLeave.value = true;
  else leave();
}
async function discard() {
  savedDraft = '';
  await reload();
  selected.value = configuration.resourceId ?? resources.value[0]?.id ?? '';
  notice.value = shellText('petConfigurationReloaded');
}
watch(selected, () => {
  parameters.value = [];
  previewReady.value = false;
  previewKey.value++;
  confirmingRemove.value = false;
  annotationsDirty.value = false;
  action.value = '';
  expression.value = '';
  parameterId.value = '';
});
watch(parameterId, () => { parameterValue.value = selectedParameter.value?.default ?? 0; });
onMounted(() => {
  dialog.value?.showModal();
  void perform(reload);
});
</script>
<template>
  <dialog ref="dialog" class="pet-manager" aria-labelledby="pet-title" @cancel.prevent="close()">
    <header>
      <div><h2 id="pet-title">{{ shellText('petManagerTitle') }}</h2><p>{{ shellText('petManagerIntro') }}</p></div>
      <button :disabled="busy" @click="close()">{{ shellText('petClose') }}</button>
    </header>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="notice" class="notice" role="status">{{ notice }}</p>
    <div class="pet-columns">
      <aside>
        <button :disabled="busy" @click="close('screenSense')">{{ shellText('petScreenSenseSettings') }}</button>
        <p>{{ shellText('petScreenSenseIntro') }}</p>
        <div class="import-buttons">
          <label>{{ shellText('petSelectDirectory') }}<input type="file" webkitdirectory multiple :disabled="busy" @change="chooseFiles"></label>
          <label>{{ shellText('petSelectFiles') }}<input type="file" multiple :disabled="busy" @change="chooseFiles"></label>
        </div>
        <form v-if="pendingFiles.length" class="import-form" @submit.prevent="perform(importResource)">
          <label>{{ shellText('petManifest') }}
            <select v-model="entry">
              <option value="">{{ shellText('petChoose') }}</option>
              <option v-for="file in manifests" :key="selectedPath(file)" :value="selectedPath(file)">{{ selectedPath(file) }}</option>
            </select>
          </label>
          <label>{{ shellText('petDisplayName') }}<input v-model="importName"></label>
          <label>{{ shellText('petSource') }}<input v-model="source" :placeholder="shellText('petSourceHint')"></label>
          <label>{{ shellText('petLicense') }}<textarea v-model="license" rows="2" :placeholder="shellText('petLicenseHint')" /></label>
          <button :disabled="busy || !entry">{{ shellText('petImport') }}</button>
          <button type="button" @click="pendingFiles = []">{{ shellText('petCancelImport') }}</button>
        </form>
        <button v-for="item in resources" :key="item.id" class="pet-row" :aria-pressed="selected === item.id" @click="selected = item.id">
          <strong>{{ item.name }}</strong>
          <span>{{ item.kind === 'sprite' ? text('petSpriteFormat', { version: item.sprite?.version ?? '' }) : shellText('petLive2dFormat') }}</span>
          <b v-if="configuration.resourceId === item.id">{{ shellText('petCurrentSelection') }}</b>
        </button>
        <p v-if="!resources.length && !busy">{{ shellText('petEmptyLibrary') }}</p>
        <details class="runtime">
          <summary>{{ shellText('petRuntimeTitle') }}</summary>
          <p>{{ shellText('petRuntimeHelp') }}</p>
          <details><summary>{{ shellText('petPlayerLicenses') }}</summary><pre>{{ playerNotices }}</pre></details>
          <a href="https://www.live2d.com/en/sdk/download/web/" target="_blank" rel="noreferrer">{{ shellText('petOfficialSdk') }}</a>
          <p>{{ snapshot?.runtime ? snapshot.runtime.name + ' · ' + formatBytes(snapshot.runtime.bytes) : shellText('petRuntimeMissing') }}</p>
          <label class="file-button">
            {{ shellText('petImportRuntime') }}<input type="file" accept=".js" :disabled="busy" @change="importRuntime">
          </label>
          <button v-if="snapshot?.runtime" :disabled="busy" @click="perform(removeRuntime)">{{ shellText('petRemoveRuntime') }}</button>
        </details>
      </aside>
      <main v-if="resource">
        <div class="settings-guide"><strong>{{ shellText('petPreviewFirst') }}</strong><p>{{ shellText('petPreviewHelp') }}</p></div>
        <div class="pet-heading">
          <div>
            <h3>{{ resource.name }}</h3>
            <p>{{ resource.description || text('petResourceSize', {
              count: resource.files.length, size: formatBytes(resource.files.reduce((sum, file) => sum + file.bytes, 0)),
            }) }}</p>
          </div>
          <button @click="confirmingRemove = true">{{ shellText('petRemoveResource') }}</button>
        </div>
        <div class="preview-layout">
          <div class="pet-preview">
            <PetPlayer
              :key="selected + '/' + previewKey"
              ref="player"
              :resource="resource"
              :runtime="snapshot?.runtime"
              :configuration="previewConfiguration"
              @ready="value => { parameters = value; previewReady = true; }"
              @failed="value => { error = value; }"
            />
          </div>
          <section class="preview-controls">
            <h4>{{ shellText('petMotionPreview') }}</h4>
            <label>{{ shellText('petMotion') }}
              <select v-model="action">
                <option value="">{{ shellText('petChooseMotion') }}</option>
                <option v-for="item in resource.actions" :key="item.id" :value="item.id">{{ item.description || item.name }} · {{ item.id }}</option>
              </select>
            </label>
            <button :disabled="!previewReady || !action || busy" @click="perform(() => preview({ action: 'play', id: action }))">
              {{ shellText('petPlayMotion') }}
            </button>
            <template v-if="resource.expressions.length">
              <label>{{ shellText('petExpression') }}
                <select v-model="expression">
                  <option value="">{{ shellText('petChoose') }}</option>
                  <option v-for="item in resource.expressions" :key="item.id" :value="item.id">{{ item.description || item.name }} · {{ item.id }}</option>
                </select>
              </label>
              <button :disabled="!previewReady || !expression || busy" @click="perform(() => preview({ action: 'expression', id: expression }))">
                {{ shellText('petApplyExpression') }}
              </button>
              <button
                :disabled="!previewReady || !action || !expression || busy"
                @click="perform(() => preview({ action: 'set', motion: action, expression }))"
              >{{ shellText('petPlayCombined') }}</button>
            </template>
            <label>{{ shellText('petDuration') }}
              <input v-model.number="duration" type="number" min="0.1" max="120" step="0.1" :aria-label="shellText('petDuration')">
              <small class="settings-help">{{ shellText('petDurationHelp') }}</small>
            </label>
            <button :disabled="!previewReady" @click="perform(() => preview({ action: 'cancel' }))">{{ shellText('petCancelPreview') }}</button>
            <p>{{ shellText('petPreviewIsolated') }}</p>
          </section>
        </div>
        <PetResourceAnnotations
          :key="resource.id"
          :resource="resource"
          :disabled="busy"
          @saved="annotationSaved"
          @dirty="value => { annotationsDirty = value; }"
          @failed="value => { error = value; }"
        />
        <details>
          <summary>{{ shellText('petLookParameters') }}</summary>
          <div class="control-grid">
            <label>{{ shellText('petLookDirection') }}
              <input v-model.number="angle" type="range" min="0" max="337.5" step="22.5">
              <span>{{ angle }}°</span><small class="settings-help">{{ shellText('petLookHelp') }}</small>
              <button :disabled="!previewReady || resource.sprite?.version === 1" @click="perform(() => preview({ action: 'look', angle }))">
                {{ shellText('petApplyLook') }}
              </button>
            </label>
            <label v-if="parameters.length">{{ shellText('petParameter') }}
              <select v-model="parameterId">
                <option value="">{{ shellText('petChoose') }}</option>
                <option v-for="item in parameters" :key="item.id" :value="item.id">{{ item.name || item.id }} ({{ item.min }} ～ {{ item.max }})</option>
              </select>
              <input
                v-if="selectedParameter"
                v-model.number="parameterValue"
                type="number"
                :min="selectedParameter.min"
                :max="selectedParameter.max"
                step="any"
                :aria-label="shellText('petParameterValue')"
              >
              <small v-if="selectedParameter" class="settings-help">
                {{ text('petParameterHelp', { default: selectedParameter.default, min: selectedParameter.min, max: selectedParameter.max }) }}
              </small>
              <button
                :disabled="!parameterId || busy || !previewReady"
                @click="perform(() => preview({ action: 'parameters', parameters: { [parameterId]: parameterValue } }))"
              >{{ shellText('petApplyParameter') }}</button>
            </label>
          </div>
        </details>
        <fieldset>
          <legend>{{ shellText('petDisplaySettings') }}</legend>
          <div class="control-grid">
            <label>{{ shellText('petSurface') }}
              <select v-model="configuration.surface">
                <option value="app">{{ shellText('petSurfaceApp') }}</option>
                <option value="floating" :disabled="!snapshot?.floatingAvailable">{{ shellText('petSurfaceFloating') }}</option>
              </select>
            </label>
            <label>{{ text('petScale', { scale: configuration.scale.toFixed(1) }) }}
              <input v-model.number="configuration.scale" type="range" min="0.4" max="3" step="0.1" :aria-label="shellText('petScaleLabel')">
              <small class="settings-help">{{ shellText('petScaleHelp') }}</small>
            </label>
          </div>
          <label class="check"><input v-model="configuration.visible" type="checkbox">{{ shellText('petVisible') }}</label>
          <label class="check"><input v-model="configuration.reducedMotion" type="checkbox">{{ shellText('petReducedMotion') }}</label>
          <p class="settings-help">{{ shellText('petReducedMotionHelp') }}</p>
          <label class="check"><input v-model="configuration.stopped" type="checkbox">{{ shellText('petStopped') }}</label>
          <label class="check"><input v-model="configuration.taskAnimations" type="checkbox">{{ shellText('petTaskAnimations') }}</label>
          <p class="settings-help">{{ shellText('petTaskAnimationsHelp') }}</p>
          <div v-if="resource.kind === 'live2d' && configuration.resourceId === resource.id" class="control-grid">
            <label v-for="state in taskStates" :key="state.id">
              {{ shellText(animationText[state.id]) }}
              <select :value="configuration.mappings[state.id] ?? ''" @change="setMapping(state.id, $event)">
                <option value="">{{ shellText('petNoMapping') }}</option>
                <option v-for="item in resource.actions" :key="item.id" :value="item.id">{{ item.description || item.name }} · {{ item.id }}</option>
              </select>
            </label>
          </div>
          <label class="check"><input v-model="configuration.followPointer" type="checkbox">{{ shellText('petFollowPointer') }}</label>
          <label class="check"><input v-model="configuration.soundEnabled" type="checkbox">{{ shellText('petSoundEnabled') }}</label>
          <label class="check"><input v-model="configuration.speechEnabled" type="checkbox">{{ shellText('petSpeechEnabled') }}</label>
          <p class="settings-help">{{ shellText('petSpeechHelp') }}</p>
          <button class="primary" :disabled="busy" @click="perform(save)">{{ shellText('petSaveConfiguration') }}</button>
          <button :disabled="busy" @click="perform(discard)">{{ shellText('petDiscardConfiguration') }}</button>
          <p>{{ shellText('petPriorityHelp') }}</p>
        </fieldset>
        <details>
          <summary>{{ shellText('petSourceLicenseFiles') }}</summary>
          <p>{{ resource.source || shellText('petSourceMissing') }}</p>
          <pre>{{ resource.license || shellText('petLicenseMissing') }}</pre>
          <p v-for="file in resource.files" :key="file.path">{{ file.path }} · {{ formatBytes(file.bytes) }}</p>
        </details>
        <section v-if="confirmingRemove" class="confirm" role="alert">
          <p>{{ text('petRemoveQuestion', { name: resource.name }) }}</p>
          <button @click="confirmingRemove = false">{{ shellText('petKeep') }}</button>
          <button @click="perform(remove)">{{ shellText('petRemove') }}</button>
        </section>
      </main>
      <main v-else class="empty"><h3>{{ shellText('petEmptyTitle') }}</h3><p>{{ shellText('petEmptyHelp') }}</p></main>
    </div>
    <footer v-if="confirmLeave" class="confirm" role="alert">
      <p>{{ shellText('petUnsaved') }}</p>
      <button @click="confirmLeave = false">{{ shellText('petContinueEditing') }}</button>
      <button @click="leave">{{ shellText('petDiscardContinue') }}</button>
    </footer>
  </dialog>
</template>
<style scoped>
.pet-manager {
  width: min(1080px, calc(100vw - 28px));
  height: min(860px, calc(100dvh - 40px));
  padding: 0;
  margin: auto;
  border: 1px solid var(--gc-border-subtle);
  border-radius: 0;
  background: var(--gc-surface-base);
  color: var(--gc-text-primary);
  box-sizing: border-box;
  overflow: hidden;
}
.pet-manager[open] { display: flex; flex-direction: column; }
.pet-manager::backdrop { background: color-mix(in srgb, var(--gc-surface-sunken) 70%, transparent); }
header, .pet-heading { display: flex; justify-content: space-between; align-items: center; gap: 18px; }
header { padding: 16px 20px; border-bottom: 1px solid var(--gc-border-subtle); }
h2, h3, h4 { margin: 0; font-weight: 600; }
h2 { font-size: 18px; }
h3 { font-size: 17px; }
h4 { font-size: 14px; }
p, pre { font-size: 12px; line-height: 1.7; color: var(--gc-text-muted); }
header p { margin: 5px 0 0; }
button, input, textarea, select, .file-button, .import-buttons label {
  border: 1px solid var(--gc-border-control);
  border-radius: var(--gc-radius-sm);
  background: var(--gc-surface-sunken);
  color: var(--gc-text-primary);
  font: inherit;
  padding: 7px 9px;
  min-width: 0;
  box-sizing: border-box;
}
button, .file-button, .import-buttons label, summary { cursor: pointer; }
button:disabled { opacity: .5; cursor: default; }
input[type=checkbox] { margin: 0; }
input[type=range] { padding: 0; }
label { display: flex; flex-direction: column; gap: 7px; font-size: 12px; margin: 12px 0; }
a { color: var(--gc-accent); font-size: 12px; }
.pet-columns { display: grid; grid-template-columns: 280px minmax(0, 1fr); min-height: 0; flex: 1; }
.pet-columns > aside, .pet-columns > main { overflow: auto; padding: 20px; }
.pet-columns > aside { border-right: 1px solid var(--gc-border-subtle); }
.import-buttons { display: flex; flex-wrap: wrap; gap: 8px; }
.import-buttons label { margin: 0; }
.import-buttons input, .file-button input { display: none; }
.import-form { border-block: 1px solid var(--gc-border-subtle); padding: 8px 0 16px; margin: 16px 0; }
.pet-row { display: flex; flex-direction: column; width: 100%; text-align: left; gap: 7px; margin: 12px 0; }
.pet-row[aria-pressed=true] { border-left: 3px solid var(--gc-accent); }
.pet-row span { font-size: 11px; color: var(--gc-text-muted); }
.pet-row b { font-weight: 400; color: var(--gc-accent); }
.runtime { margin-top: 26px; }
.file-button { display: inline-flex; }
.preview-layout { display: grid; grid-template-columns: minmax(180px, 1fr) 230px; gap: 22px; margin: 18px 0; }
.pet-preview {
  height: 320px;
  border: 1px solid var(--gc-border-subtle);
  background: repeating-conic-gradient(color-mix(in srgb, var(--gc-text-muted) 7%, transparent) 0% 25%, transparent 0% 50%) 0 0/28px 28px;
}
.preview-controls button { font-size: 12px; margin-bottom: 8px; }
.control-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0 18px; min-width: 0; }
.check { flex-direction: row; align-items: center; }
.pet-manager details { margin: 16px 0; padding-top: 12px; border-top: 1px solid var(--gc-border-subtle); }
fieldset { margin: 24px 0; border: 1px solid var(--gc-border-subtle); padding: 14px 18px; }
legend { padding: 0 6px; font-size: 13px; }
.primary { background: var(--gc-button-primary); color: var(--gc-text-on-primary); margin-top: 12px; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; }
.error, .notice { margin: 10px 20px 0; }
.error { color: var(--gc-danger); }
.confirm { padding: 14px 20px; background: var(--gc-surface-raised); border-top: 1px solid var(--gc-border-subtle); }
.confirm button + button { margin-left: 10px; }
.empty { display: flex; flex-direction: column; justify-content: center; }
.empty h3 { font-size: 22px; font-weight: 400; }
@media (max-width: 700px) {
  .pet-manager { width: calc(100vw - 12px); height: calc(100dvh - 20px); }
  header { padding: 12px; }
  .pet-columns { overflow: auto; display: block; }
  .pet-columns > aside { border-right: 0; border-bottom: 1px solid var(--gc-border-subtle); }
  .pet-columns > aside, .pet-columns > main { overflow: visible; padding: 14px; }
  .preview-layout, .control-grid { grid-template-columns: 1fr; }
  .pet-preview { height: 280px; }
  .pet-heading { align-items: flex-start; }
  .pet-row { margin: 8px 0; }
}
</style>
