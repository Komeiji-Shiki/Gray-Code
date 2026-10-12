<script setup lang="ts">
import { shellText as t, shellLocale } from '../i18n';
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import type { MemoryImportFile } from '@graycode/contracts';
import { loadMemoryImportFile, memoryFileSize } from '../memoryImports';

const props = defineProps<{ datasetId: string; file: MemoryImportFile }>();
const emit = defineEmits<{ close: [] }>();
const busy = ref(false),
  error = ref(''),
  loadedBytes = ref(0),
  url = ref(''),
  text = ref(''),
  clipped = ref(false),
  verified = ref(false);
const previewElement = ref<HTMLElement>();
const image = computed(() => /^image\/(png|jpeg|webp|gif)$/.test(props.file.mimeType));
const readable = computed(() => props.file.mimeType.startsWith('text/') || ['application/json', 'application/x-ndjson'].includes(props.file.mimeType));
const previewable = computed(() => props.file.bytes <= 2 * 1024 * 1024 && (readable.value || image.value));
let controller: AbortController | undefined;
function reset() {
  controller?.abort();
  controller = undefined;
  if (url.value) URL.revokeObjectURL(url.value);
  url.value = '';
  text.value = '';
  error.value = '';
  busy.value = false;
  verified.value = false;
  clipped.value = false;
  loadedBytes.value = 0;
}
async function load(download = false) {
  if (busy.value) return;
  const request = new AbortController();
  controller = request;
  busy.value = true;
  error.value = '';
  try {
    if (!url.value) {
      const blob = await loadMemoryImportFile(props.datasetId, props.file, request.signal, (bytes) => (loadedBytes.value = bytes));
      const body = readable.value && previewable.value ? await blob.text() : '';
      request.signal.throwIfAborted();
      url.value = URL.createObjectURL(blob);
      verified.value = true;
      text.value = body.slice(0, 100000);
      clipped.value = body.length > 100000;
    }
    if (download) {
      const anchor = document.createElement('a');
      anchor.href = url.value;
      anchor.download = props.file.path.split('/').at(-1) || 'memory-file';
      anchor.click();
    }
  } catch (cause) {
    if (!request.signal.aborted) error.value = (cause as Error).message;
  } finally {
    if (controller === request) busy.value = false;
  }
}
watch(
  () => `${props.datasetId}/${props.file.id}`,
  () => {
    reset();
    if (previewable.value) void load();
    void nextTick(() => previewElement.value?.scrollIntoView({ block: 'nearest' }));
  },
  { immediate: true },
);
onBeforeUnmount(reset);
</script>
<template>
  <section ref="previewElement" class="import-file" :aria-label="t('uiMemoryImportFileOriginalFilePreview')">
    <header>
      <div>
        <strong>{{ file.path }}</strong>
        <small>{{ memoryFileSize(file.bytes) }} · {{ file.mimeType }}</small>
      </div>
      <button @click="emit('close')">{{ t('uiMemoryImportFileClosePreview') }}</button>
    </header>
    <p v-if="busy" role="status" class="memory-muted">
      {{ t('uiMemoryImportFileReadingAndVerifying') }} {{ memoryFileSize(loadedBytes) }} / {{ memoryFileSize(file.bytes) }}
      <button @click="reset">{{ t('uiMemoryImportFileCancelReading') }}</button>
    </p>
    <p v-if="error" class="memory-error" role="alert">{{ error }}</p>
    <div v-if="!busy" class="import-file-actions">
      <button @click="load(true)">{{ t('uiMemoryImportFileDownloadOriginalFile') }}</button>
      <span v-if="verified" class="memory-muted">{{ t('uiMemoryImportFileChecksumVerified') }}</span>
    </div>
    <img v-if="image && url" :src="url" :alt="file.path" />
    <pre v-else-if="readable && url && previewable">{{ text }}</pre>
    <p v-if="clipped" class="memory-muted">{{ t('uiMemoryImportFilePreviewLimitHelp') }}</p>
    <p v-if="!previewable" class="memory-muted">{{ t('uiMemoryImportFileOriginalFileHelp') }}</p>
    <details>
      <summary>{{ t('uiMemoryImportFileOriginalFileInformation') }}</summary>
      <dl>
        <dt>{{ t('uiMemoryImportFileModifiedTime') }}</dt>
        <dd>{{ file.modifiedAt ? new Date(file.modifiedAt).toLocaleString(shellLocale) : t('uiMemoryImportFileNotRecorded') }}</dd>
        <dt>{{ t('uiMemoryImportFileCreatedTime') }}</dt>
        <dd>{{ file.createdAt ? new Date(file.createdAt).toLocaleString(shellLocale) : t('uiMemoryImportFileNotRecorded') }}</dd>
        <dt>SHA-256</dt>
        <dd class="import-file-hash">{{ file.sha256 }}</dd>
      </dl>
    </details>
  </section>
</template>
<style scoped>
.import-file {
  border: 1px solid var(--gc-border-subtle);
  border-top: 2px solid var(--gc-accent);
  padding: 16px;
  min-width: 0;
  margin-top: 16px;
}
.import-file header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
}
.import-file header div {
  min-width: 0;
}
.import-file strong {
  display: block;
  font-weight: 500;
  overflow-wrap: anywhere;
  line-height: 1.7;
}
.import-file small {
  display: block;
  color: var(--gc-text-muted);
  margin: 5px 0;
  font-size: 11px;
}
.import-file header button {
  flex: none;
}
.import-file-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin: 12px 0;
}
.import-file img {
  max-width: 100%;
  max-height: 560px;
  object-fit: contain;
  display: block;
  margin: 18px auto;
  background: var(--gc-surface-base);
}
.import-file pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 480px;
  overflow: auto;
  font: 12px/1.8 var(--gc-font-code);
  padding: 14px;
  background: var(--gc-surface-base);
}
.import-file details {
  margin-top: 16px;
  color: var(--gc-text-muted);
  font-size: 11px;
}
.import-file dl {
  display: grid;
  grid-template-columns: 80px minmax(0, 1fr);
  gap: 10px;
}
.import-file dd {
  margin: 0;
  overflow-wrap: anywhere;
}
.import-file-hash {
  font-family: monospace;
}
@media (max-width: 480px) {
  .import-file {
    padding: 12px;
  }
  .import-file header {
    flex-direction: column;
  }
  .import-file pre {
    padding: 8px;
  }
}
</style>
