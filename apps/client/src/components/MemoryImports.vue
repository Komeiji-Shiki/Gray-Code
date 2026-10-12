<script setup lang="ts">
import { shellText as t, shellLocale } from '../i18n';
import { computed, onMounted, onBeforeUnmount, ref } from 'vue';
import type { MemoryImportSummary, MemoryImportFile as ImportFile } from '@graycode/contracts';
import { call } from '../api';
import { memoryFileSize } from '../memoryImports';
import MemoryImportFile from './MemoryImportFile.vue';

const emit = defineEmits<{ browse: [scopeId: string] }>();
const libraries = ref<MemoryImportSummary[]>([]),
  selectedId = ref(''),
  error = ref(''),
  busy = ref(false),
  loading = ref(false);
const query = ref(''),
  appliedQuery = ref(''),
  files = ref<ImportFile[]>([]),
  total = ref(0),
  offset = ref(0),
  nextOffset = ref<number>(),
  preview = ref<ImportFile>();
const selected = computed(() => libraries.value.find((library) => library.id === selectedId.value));
let epoch = 0;
async function loadFiles(next = 0) {
  if (!selectedId.value) return;
  const current = ++epoch;
  loading.value = true;
  error.value = '';
  try {
    const page = await call<{ files: ImportFile[]; total: number; offset: number; nextOffset?: number }>('memory.import.files', {
      id: selectedId.value,
      query: appliedQuery.value,
      offset: next,
      limit: 40,
    });
    if (current !== epoch) return;
    files.value = page.files;
    total.value = page.total;
    offset.value = page.offset;
    nextOffset.value = page.nextOffset;
  } catch (cause) {
    if (current === epoch) error.value = (cause as Error).message;
  } finally {
    if (current === epoch) loading.value = false;
  }
}
async function choose(id: string) {
  selectedId.value = id;
  preview.value = undefined;
  query.value = '';
  appliedQuery.value = '';
  await loadFiles();
}
async function setRecall(enabled: boolean) {
  if (busy.value || !selected.value) return;
  const item = selected.value;
  busy.value = true;
  error.value = '';
  try {
    await call('memory.import.recall', { id: item.id, enabled });
    item.recallEnabled = enabled;
  } catch (cause) {
    error.value = (cause as Error).message;
  } finally {
    busy.value = false;
  }
}
onMounted(async () => {
  busy.value = true;
  try {
    libraries.value = await call<MemoryImportSummary[]>('memory.import.list');
    if (libraries.value[0]) await choose(libraries.value[0].id);
  } catch (cause) {
    error.value = (cause as Error).message;
  } finally {
    busy.value = false;
  }
});
onBeforeUnmount(() => epoch++);
</script>
<template>
  <section class="memory-imports" :aria-label="t('uiMemoryImportsImportedLibrary')">
    <div class="settings-guide">
      <strong>{{ t('uiMemoryImportsVerifyBeforeUse') }}</strong>
      <p>{{ t('uiMemoryImportsImportedLibraryHelp') }}</p>
    </div>
    <p v-if="error" class="memory-error" role="alert">{{ error }}</p>
    <p v-if="!libraries.length" class="memory-muted">{{ busy ? t('uiMemoryImportsLoadingLibrary') : t('uiMemoryImportsNoImportedLibrary') }}</p>
    <div v-if="libraries.length" class="import-library-picker">
      <label>
        {{ t('library') }}
        <select :value="selectedId" :disabled="busy" @change="choose(($event.target as HTMLSelectElement).value)">
          <option v-for="item in libraries" :key="item.id" :value="item.id">{{ item.name }}</option>
        </select>
      </label>
      <button :disabled="busy" @click="emit('browse', selectedId ? selected!.scopeId : '')">{{ t('uiMemoryImportsViewEditMemories') }}</button>
    </div>
    <template v-if="selected">
      <div class="import-stats">
        <span>
          <strong>{{ selected.originalFileCount.toLocaleString(shellLocale) }}</strong>
          {{ t('uiMemoryImportsOriginalFiles') }}
        </span>
        <span>
          <strong>{{ selected.records.toLocaleString(shellLocale) }}</strong>
          {{ t('uiMemoryImportsInitialImportEntries') }}
        </span>
        <span>
          <strong>{{ memoryFileSize(selected.bytes) }}</strong>
          {{ t('uiMemoryImportsTotalArchiveSize') }}
        </span>
      </div>
      <div class="import-recall">
        <label>
          <input type="checkbox" :checked="selected.recallEnabled" :disabled="busy" @change="setRecall(($event.target as HTMLInputElement).checked)" />
          {{ t('uiMemoryImportsEnableVerifiedRecall') }}
        </label>
        <small>{{ selected.recallEnabled ? t('uiMemoryImportsEnabledLibraryHelp') : t('uiMemoryImportsDisabledLibraryHelp') }}</small>
      </div>
      <details class="import-notes">
        <summary>{{ t('uiMemoryImportsMigrationGraphSummary') }}</summary>
        <p v-for="note in selected.notes" :key="note">{{ note }}</p>
        <p v-if="selected.graph">
          {{ t('uiMemoryImportsGraphLabel') }}{{ selected.graph.entities }} {{ t('uiMemoryImportsEntityCountSuffix') }}{{ selected.graph.facts }}
          {{ t('uiMemoryImportsFactCountSuffix') }}{{ selected.graph.episodes }} {{ t('uiMemoryImportsEventCountSuffix') }}{{ selected.graph.connections }}
          {{ t('uiMemoryImportsConnectionCountSuffix') }}
        </p>
      </details>
      <form
        class="memory-search"
        @submit.prevent="
          appliedQuery = query;
          loadFiles();
        "
      >
        <input v-model="query" :aria-label="t('uiMemoryImportsSearchOriginalPaths')" :placeholder="t('uiMemoryImportsFileFilterPlaceholder')" />
        <button :disabled="loading" type="submit">{{ t('uiMemoryImportsFindFiles') }}</button>
      </form>
      <div class="import-page">
        <span>{{ total ? `${offset + 1}–${Math.min(offset + files.length, total)} / ${total}` : t('uiMemoryImportsNoMatchingFiles') }}</span>
        <span v-if="loading" role="status">{{ t('uiComputerPaneLoading') }}</span>
        <button :disabled="loading || offset === 0" @click="loadFiles(Math.max(0, offset - 40))">{{ t('uiMemoryImportsPreviousPage') }}</button>
        <button :disabled="loading || nextOffset === undefined" @click="loadFiles(nextOffset)">{{ t('uiMemoryImportsNextPage') }}</button>
      </div>
      <div class="import-files">
        <button v-for="file in files" :key="file.id" :aria-pressed="preview?.id === file.id" @click="preview = file">
          <span>{{ file.path }}</span>
          <small>{{ memoryFileSize(file.bytes) }}</small>
        </button>
      </div>
      <MemoryImportFile v-if="preview" :dataset-id="selected.id" :file="preview" @close="preview = undefined" />
    </template>
  </section>
</template>
<style scoped>
.memory-imports {
  padding: 20px 24px;
  min-width: 0;
  overflow: auto;
  flex: 1;
}
.import-library-picker {
  display: flex;
  align-items: flex-end;
  gap: 12px;
  flex-wrap: wrap;
  margin: 20px 0;
}
.import-library-picker label {
  display: flex;
  flex-direction: column;
  gap: 7px;
  flex: 1;
  min-width: 160px;
}
.import-library-picker select {
  width: 100%;
  min-width: 0;
}
.import-stats {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  border-block: 1px solid var(--gc-border-subtle);
  margin: 18px 0;
}
.import-stats span {
  color: var(--gc-text-muted);
  font-size: 11px;
  padding: 15px;
  border-right: 1px solid var(--gc-border-subtle);
}
.import-stats span:first-child {
  padding-left: 0;
}
.import-stats span:last-child {
  border-right: 0;
}
.import-stats strong {
  display: block;
  font-size: 21px;
  color: var(--gc-text-primary);
  font-weight: 500;
  margin-bottom: 7px;
  overflow-wrap: anywhere;
}
.import-recall {
  margin: 20px 0;
}
.import-recall label {
  display: flex;
  gap: 9px;
  align-items: center;
  line-height: 1.8;
}
.import-recall small {
  display: block;
  color: var(--gc-text-muted);
  font-size: 12px;
  line-height: 1.8;
  margin: 6px 0 0 26px;
}
.import-notes {
  font-size: 12px;
  line-height: 1.8;
  margin-bottom: 22px;
  color: var(--gc-text-muted);
}
.import-page {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 12px 0;
  font-size: 11px;
  color: var(--gc-text-muted);
  flex-wrap: wrap;
}
.import-page > span:first-child {
  margin-right: auto;
}
.import-files {
  border-top: 1px solid var(--gc-border-subtle);
  max-height: 340px;
  overflow: auto;
}
.import-files > button {
  border: 0;
  border-bottom: 1px solid var(--gc-border-subtle);
  background: transparent;
  display: flex;
  width: 100%;
  gap: 16px;
  text-align: left;
  align-items: center;
  padding: 9px 4px;
}
.import-files > button > span {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
  line-height: 1.6;
}
.import-files small {
  color: var(--gc-text-muted);
  font-size: 11px;
  white-space: nowrap;
}
.import-files > button[aria-pressed='true'] {
  background: var(--gc-surface-hover);
  border-left: 2px solid var(--gc-accent);
}
@media (max-width: 700px) {
  .memory-imports {
    padding: 14px;
  }
  .import-stats span {
    padding: 10px;
  }
  .import-stats strong {
    font-size: 17px;
  }
}
</style>
