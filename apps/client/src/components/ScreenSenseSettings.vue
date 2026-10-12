<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import type { ScreenSenseConfiguration, ScreenSenseOptions, ScreenSensePrices, ScreenSenseSnapshot, ScreenSenseTarget } from '@graycode/contracts';
import { rpc, subscribe } from '../api';
import { shellText as t } from '../i18n';

const props = withDefaults(defineProps<{
  embedded?: boolean;
  section?: 'conversation' | 'defaults';
  conversationId?: string;
}>(), { section: 'conversation' });
const emit = defineEmits<{ close: []; changed: [snapshot: ScreenSenseSnapshot]; dirty: [value: boolean] }>();
const dialog = ref<HTMLDialogElement>();
const snapshot = ref<ScreenSenseSnapshot>();
const options = ref<ScreenSenseOptions>();
const error = ref('');
const notice = ref('');
const busy = ref(false);
const confirmClose = ref(false);
const form = reactive({
  target: '', trigger: '' as ScreenSenseConfiguration['trigger'] | '', interval: '',
  delivery: '' as ScreenSenseConfiguration['delivery'] | '', maximum: '', conversationId: '',
  visionProviderId: '', visionModelId: '', prompt: '', allowSilent: false, autoStartOnOpen: false,
  currency: '', input: '', output: '', cacheRead: '', cacheWrite: '',
});
const saved = ref('');
let unsubscribe: (() => void) | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let sequence = 0;
let disposed = false;
const dirty = computed(() => !!saved.value && JSON.stringify(form) !== saved.value);
watch(dirty, value => emit('dirty', value), { immediate: true });
const provider = computed(() => options.value?.providers.find(item => item.id === form.visionProviderId));
const targets = computed(() => options.value ? [
  ...options.value.targets.windows.map(window => ({
    key: `window:${window.id}`, label: `${window.title} · PID ${window.processId}`,
    value: { kind: 'window', window } as ScreenSenseTarget,
  })),
  ...options.value.targets.displays.map(display => ({
    key: `display:${display.id}`, label: t('screenDisplay', { id: display.id, width: display.bounds.width, height: display.bounds.height }),
    value: { kind: 'display', display } as ScreenSenseTarget,
  })),
] : []);
const previewUrl = computed(() => {
  const capture = snapshot.value?.preview?.capture;
  return capture ? `data:${capture.mimeType};base64,${capture.data}` : '';
});

function loadForm(configuration?: ScreenSenseConfiguration) {
  if (configuration) Object.assign(form, {
    target: configuration.target.kind === 'window' ? `window:${configuration.target.window.id}` : `display:${configuration.target.display.id}`,
    trigger: configuration.trigger, interval: String(configuration.intervalSeconds ?? ''), delivery: configuration.delivery,
    maximum: String(configuration.maxCaptures), conversationId: props.conversationId || configuration.conversationId,
    visionProviderId: configuration.visionProviderId ?? '', visionModelId: configuration.visionModelId ?? '',
    prompt: configuration.prompt, allowSilent: configuration.allowSilent === true,
    autoStartOnOpen: configuration.conversationId === (props.conversationId || configuration.conversationId)
      && configuration.autoStartOnOpen === true,
    currency: configuration.prices?.currency ?? '',
    ...Object.fromEntries(['input', 'output', 'cacheRead', 'cacheWrite'].map(key => [key,
      String(configuration.prices?.[key as keyof ScreenSensePrices] ?? ''),
    ])),
  });
  if (!configuration) Object.assign(form, {
    visionProviderId: snapshot.value?.visionDefaults.visionProviderId ?? '',
    visionModelId: snapshot.value?.visionDefaults.visionModelId ?? '',
    conversationId: props.conversationId || '',
  });
  saved.value = JSON.stringify(form);
}

async function refresh() {
  if (disposed) return;
  const request = ++sequence;
  const value = await rpc('screenSense.get');
  if (disposed || request !== sequence) return;
  snapshot.value = value;
  emit('changed', value);
  if (!saved.value) loadForm(value.configuration);
}

async function refreshOptions() {
  const value = await rpc('screenSense.options', { includeTargets: props.section !== 'defaults' });
  if (!disposed) options.value = value;
}

async function perform(work: () => Promise<unknown>) {
  if (disposed || busy.value) return;
  busy.value = true;
  error.value = '';
  notice.value = '';
  try {
    await work();
    if (!disposed) await refresh();
  } catch (cause) {
    if (!disposed) error.value = (cause as Error).message;
  } finally {
    if (!disposed) busy.value = false;
  }
}

// 停止采集不等待慢截图或识图请求完成，界面关闭后也不再补读。
async function stop() {
  try {
    await rpc('screenSense.stop');
    if (!disposed) await refresh();
  } catch (cause) {
    if (!disposed) error.value = (cause as Error).message;
  }
}

async function save() {
  if (props.section === 'defaults') {
    const value = await rpc('screenSense.defaults.save', {
      defaults: { visionProviderId: form.visionProviderId, visionModelId: form.visionModelId || undefined },
      revision: snapshot.value?.revision ?? null,
    });
    if (disposed) return;
    snapshot.value = value;
    loadForm(value.configuration);
    emit('changed', value);
    notice.value = t('screenDefaultsSaved');
    return;
  }
  const target = targets.value.find(item => item.key === form.target)?.value;
  if (!target) throw new Error(t('screenSelectTargetError'));
  if (!form.trigger || !form.delivery) throw new Error(t('screenSelectModesError'));
  const pricing = [form.currency, form.input, form.output, form.cacheRead, form.cacheWrite];
  if (pricing.some(Boolean) && !pricing.every(value => value.trim())) throw new Error(t('screenPricesError'));
  const configuration: ScreenSenseConfiguration = {
    target, trigger: form.trigger, intervalSeconds: form.interval ? Number(form.interval) : undefined, delivery: form.delivery,
    maxCaptures: Number(form.maximum), conversationId: form.conversationId,
    visionProviderId: form.visionProviderId, visionModelId: form.visionModelId || undefined,
    prompt: form.prompt, allowSilent: form.allowSilent, autoStartOnOpen: form.autoStartOnOpen,
    ...(pricing.some(Boolean) ? { prices: {
      currency: form.currency, input: Number(form.input), output: Number(form.output),
      cacheRead: Number(form.cacheRead), cacheWrite: Number(form.cacheWrite),
    } } : {}),
  };
  const value = await rpc('screenSense.configure', { configuration, revision: snapshot.value?.revision ?? null });
  if (disposed) return;
  sequence++;
  snapshot.value = value;
  loadForm(value.configuration);
  emit('changed', value);
  notice.value = t(form.autoStartOnOpen ? 'screenSavedAutomatic' : 'screenSaved');
}

function close() {
  if (busy.value) return;
  if (dirty.value) confirmClose.value = true;
  else emit('close');
}

onMounted(() => {
  if (!props.embedded) dialog.value?.showModal();
  void perform(async () => { await refresh(); if (!disposed) await refreshOptions(); });
  unsubscribe = subscribe(event => {
    if (event.type === 'screenSense.changed' || event.type === 'transport.resumed'
      || event.type === 'event' && /run\.(completed|failed|cancelled|interrupted)/.test(event.event?.type ?? '')) {
      if (!disposed && !timer) timer = setTimeout(() => {
        timer = undefined;
        void refresh().catch(cause => { if (!disposed) error.value = cause.message; });
      }, 160);
    }
  });
});

onBeforeUnmount(() => { disposed = true; sequence++; unsubscribe?.(); clearTimeout(timer); });
defineExpose({
  async discard() {
    await refresh();
    loadForm(snapshot.value?.configuration);
  },
});
</script>

<template>
  <component :is="embedded ? 'section' : 'dialog'" ref="dialog" class="screen-sense-settings" :class="{ embedded }"
    :aria-labelledby="embedded ? undefined : 'sense-title'" :aria-label="embedded ? t('screenTitle') : undefined" @cancel.prevent="close">
    <header v-if="!embedded">
      <div><h2 id="sense-title">{{ t('screenTitle') }}</h2><p>{{ t('screenIntro') }}</p></div>
      <button :disabled="busy" @click="close">{{ t('close') }}</button>
    </header>
    <div class="sense-content">
      <p v-if="error" role="alert" class="error">{{ error }}</p>
      <p v-if="notice" role="status">{{ notice }}</p>
      <section v-if="section !== 'defaults'" class="sense-current">
        <strong>{{ t(snapshot?.status.active ? 'screenActive' : 'screenInactive') }}</strong>
        <p v-if="snapshot?.status.active">
          {{ snapshot.status.target }} · {{ t('screenCaptureCount', { count: snapshot.status.captures, max: snapshot.status.maxCaptures ?? 0 }) }}
          · {{ t('screenSkipped', { count: snapshot.status.skipped ?? 0 }) }}
          <span v-if="snapshot.status.nextCaptureAt"> · {{ new Date(snapshot.status.nextCaptureAt).toLocaleTimeString() }}</span>
        </p>
        <p v-if="snapshot?.status.error">{{ snapshot.status.error }}</p>
        <button v-if="snapshot?.status.active" @click="stop">{{ t('screenStop') }}</button>
        <button v-else :disabled="busy || !snapshot?.configuration || dirty
          || !!conversationId && snapshot.configuration.conversationId !== conversationId" @click="perform(() => rpc('screenSense.start'))">
          {{ t('screenStart') }}
        </button>
        <button v-if="snapshot?.status.active"
          :disabled="busy || snapshot.status.capturing || snapshot.status.captures >= (snapshot.status.maxCaptures ?? 0)"
          @click="perform(() => rpc('screenSense.capture'))">{{ t('screenCapture') }}</button>
        <button v-if="snapshot?.status.lastRunId" @click="perform(() => rpc('screenSense.cancelRun'))">{{ t('screenCancelRun') }}</button>
        <p>{{ t('screenStopHelp') }}</p>
      </section>
      <section v-if="section !== 'defaults' && snapshot?.preview" class="sense-preview">
        <h3>{{ t('screenPreview') }} · {{ snapshot.preview.target }}</h3>
        <p>{{ new Date(snapshot.preview.capture.capturedAt).toLocaleString() }}</p>
        <img :src="previewUrl" :alt="t('screenPreviewAlt')">
        <p v-if="snapshot.preview.summary">{{ snapshot.preview.summary }}</p>
        <button :disabled="busy || snapshot.status.capturing"
          @click="perform(() => rpc('screenSense.send', { previewId: snapshot!.preview!.id }))">{{ t('screenSend') }}</button>
      </section>
      <div v-if="section !== 'defaults'" class="settings-guide"><strong>{{ t('screenPipelineTitle') }}</strong><p>{{ t('screenPipelineHelp') }}</p></div>
      <form @submit.prevent="perform(save)">
        <fieldset :disabled="busy">
          <legend>{{ t(section === 'defaults' ? 'screenDefaultsTitle' : 'screenSettings') }}</legend>
          <template v-if="section !== 'defaults'">
            <label>{{ t('screenTarget') }}
              <select v-model="form.target" required>
                <option value="">{{ t('screenSelect') }}</option>
                <option v-for="target in targets" :key="target.key" :value="target.key">{{ target.label }}</option>
              </select>
            </label>
            <button type="button" @click="perform(refreshOptions)">{{ t('screenRefreshTargets') }}</button>
            <p>{{ t('screenTargetHelp') }}</p>
            <div class="sense-grid">
              <label>{{ t('screenTrigger') }}
                <select v-model="form.trigger" required>
                  <option value="">{{ t('screenSelect') }}</option>
                  <option value="manual">{{ t('screenManual') }}</option>
                  <option value="interval">{{ t('screenInterval') }}</option>
                </select>
              </label>
              <label v-if="form.trigger === 'interval'">{{ t('screenIntervalSeconds') }}
                <input v-model="form.interval" type="number" min="1" max="86400" required>
                <small>{{ t('screenIntervalHelp') }}</small>
              </label>
              <label>{{ t('screenDelivery') }}
                <select v-model="form.delivery" required>
                  <option value="">{{ t('screenSelect') }}</option>
                  <option value="preview">{{ t('screenPreviewFirst') }}</option>
                  <option value="automatic">{{ t('screenAutomatic') }}</option>
                </select>
              </label>
              <label>{{ t('screenMaximum') }}
                <input v-model="form.maximum" type="number" min="1" max="10000" required>
                <small>{{ t('screenMaximumHelp') }}</small>
              </label>
            </div>
            <p v-if="conversationId" class="sense-bound-conversation">
              {{ t('screenBoundConversation', { title: options?.conversations.find(item => item.id === conversationId)?.title || conversationId }) }}
            </p>
            <label v-else>{{ t('screenConversation') }}
              <select v-model="form.conversationId" required>
                <option value="">{{ t('screenSelect') }}</option>
                <option v-for="conversation in options?.conversations" :key="conversation.id" :value="conversation.id">{{ conversation.title }}</option>
              </select>
            </label>
            <label class="check"><input v-model="form.autoStartOnOpen" data-testid="screen-auto-start" type="checkbox">{{ t('screenAutoStart') }}</label>
            <small>{{ t('screenAutoStartHelp') }}</small>
            <p v-if="conversationId && snapshot?.configuration && snapshot.configuration.conversationId !== conversationId">
              {{ t('screenRebindHelp') }}
            </p>
          </template>
          <div class="sense-grid">
            <label>{{ t('screenVisionProvider') }}
              <select v-model="form.visionProviderId" required @change="form.visionModelId = ''">
                <option value="">{{ t('screenSelect') }}</option>
                <option v-for="channel in options?.providers" :key="channel.id" :value="channel.id">{{ channel.name }}</option>
              </select>
            </label>
            <label>{{ t('screenVisionModel') }}
              <select v-model="form.visionModelId">
                <option value="">{{ provider?.model || t('screenProviderDefault') }}</option>
                <option v-for="model in provider?.models" :key="model.id" :value="model.id">{{ model.name || model.id }}</option>
              </select>
            </label>
          </div>
          <p>{{ t('screenModelHelp') }}</p>
          <template v-if="section !== 'defaults'">
            <label>{{ t('screenPrompt') }}<textarea v-model="form.prompt" rows="3" required maxlength="10000" /></label>
            <label class="check"><input v-model="form.allowSilent" type="checkbox">{{ t('screenAllowSilent') }}</label>
            <details>
              <summary>{{ t('screenPriceTitle') }}</summary><p>{{ t('screenPriceHelp') }}</p>
              <label>{{ t('screenCurrency') }}<input v-model="form.currency" maxlength="20" placeholder="USD"></label>
              <div class="sense-grid">
                <label>{{ t('screenInput') }}<input v-model="form.input" type="number" min="0" step="any"></label>
                <label>{{ t('screenOutput') }}<input v-model="form.output" type="number" min="0" step="any"></label>
                <label>{{ t('screenCacheRead') }}<input v-model="form.cacheRead" type="number" min="0" step="any"></label>
                <label>{{ t('screenCacheWrite') }}<input v-model="form.cacheWrite" type="number" min="0" step="any"></label>
              </div>
            </details>
          </template>
          <button class="primary">{{ t(section === 'defaults' ? 'screenSaveDefaults' : 'screenSave') }}</button>
          <p v-if="snapshot?.status.active">{{ t('screenSaveHelp') }}</p>
        </fieldset>
      </form>
      <section v-if="section !== 'defaults'" class="sense-history">
        <h3>{{ t('screenHistory') }}</h3><p v-if="!snapshot?.history.length">{{ t('screenEmptyHistory') }}</p>
        <article v-for="record in snapshot?.history" :key="record.id">
          <strong>{{ record.target }}</strong>
          <p>{{ new Date(record.createdAt).toLocaleString() }} · {{ record.silent ? t('screenSilent') : record.status || record.error }}</p>
          <p v-if="record.summary">{{ record.summary }}</p>
          <p>{{ t(record.visionUsage ? 'screenVisionUsage' : 'screenMainUsage', {
            input: record.usage.inputTokens, output: record.usage.outputTokens,
            read: record.usage.cacheReadTokens, write: record.usage.cacheWriteTokens,
          }) }}</p>
          <p v-if="record.mainUsage?.requests">{{ t('screenMainUsage', {
            input: record.mainUsage.inputTokens, output: record.mainUsage.outputTokens,
            read: record.mainUsage.cacheReadTokens, write: record.mainUsage.cacheWriteTokens,
          }) }}</p>
          <p v-if="record.usage.unknownRequests || record.mainUsage?.unknownRequests">
            {{ t('screenUnknownUsage', { count: record.usage.unknownRequests + (record.mainUsage?.unknownRequests ?? 0) }) }}
          </p>
          <p v-if="record.prices">{{ t('screenEstimatedCost', { cost: record.usage.estimatedCost?.toFixed(6) ?? '—', currency: record.prices.currency }) }}</p>
        </article>
      </section>
    </div>
    <footer v-if="confirmClose">
      <p>{{ t('screenUnsaved') }}</p>
      <button @click="confirmClose = false">{{ t('screenContinueEditing') }}</button>
      <button @click="emit('close')">{{ t('screenDiscard') }}</button>
    </footer>
  </component>
</template>

<style scoped>
.screen-sense-settings {
  width: min(800px, calc(100vw - 20px));
  height: min(820px, calc(100dvh - 30px));
  padding: 0;
  border: 1px solid var(--gc-border-subtle);
  border-radius: 0;
  background: var(--gc-surface-base);
  color: var(--gc-text-primary);
  box-sizing: border-box;
  overflow: hidden;
}
.screen-sense-settings[open] { display: flex; flex-direction: column; }
.screen-sense-settings::backdrop { background: var(--gc-backdrop); }
.screen-sense-settings.embedded { width: 100%; height: auto; overflow: visible; border: 0; }
.embedded .sense-content { padding: 0; overflow: visible; }
.embedded fieldset { margin: 12px 0; padding: 0; border: 0; }
header, footer { padding: 16px 20px; border-bottom: 1px solid var(--gc-border-subtle); }
header { display: flex; justify-content: space-between; gap: 20px; }
header > button { flex-shrink: 0; white-space: nowrap; align-self: flex-start; }
h2, h3 { margin: 0; font-weight: 500; }
h2 { font-size: 18px; }
h3 { font-size: 14px; }
p, small { font-size: 12px; line-height: 1.7; color: var(--gc-text-muted); }
header p { margin-bottom: 0; }
.sense-content { overflow: auto; padding: 20px; min-height: 0; flex: 1; }
.sense-content > p[role] { position: sticky; top: 0; z-index: 1; padding: 10px; background: var(--gc-surface-raised); }
.sense-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0 18px; }
label { display: flex; flex-direction: column; gap: 6px; min-width: 0; font-size: 12px; margin: 12px 0; }
label.check { flex-direction: row; align-items: center; }
button, input, select, textarea {
  font: inherit;
  border: 1px solid var(--gc-border-control);
  border-radius: var(--gc-radius-sm);
  background: var(--gc-surface-sunken);
  color: var(--gc-text-primary);
  padding: 7px 9px;
  min-width: 0;
  box-sizing: border-box;
}
button { cursor: pointer; font-size: 12px; }
button + button { margin-left: 8px; }
button:disabled { opacity: .5; cursor: default; }
fieldset { margin: 22px 0; padding: 16px; border: 1px solid var(--gc-border-subtle); min-width: 0; }
legend { padding: 0 6px; }
summary { cursor: pointer; font-size: 13px; }
details { margin: 20px 0; }
.primary { background: var(--gc-button-primary); color: var(--gc-text-on-primary); }
.sense-current, .sense-preview, article { padding: 14px 0; border-bottom: 1px solid var(--gc-border-subtle); }
.sense-preview img {
  width: 100%; max-height: 360px; object-fit: contain; display: block;
  background: var(--gc-surface-sunken); margin: 12px 0;
}
.sense-history p { overflow-wrap: anywhere; }
.error { color: var(--gc-danger); }
footer { border-top: 1px solid var(--gc-border-subtle); }
@media (max-width: 600px) {
  .sense-grid { grid-template-columns: 1fr; }
  .sense-content, header, fieldset { padding: 12px; }
  .sense-current button { margin: 4px 8px 4px 0; }
}
</style>
