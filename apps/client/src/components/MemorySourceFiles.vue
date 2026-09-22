<script setup lang="ts">
import { computed, ref } from 'vue';
import type { LongMemorySource, MemoryImportFile as ImportFile } from '@graycode/contracts';
import { call } from '../api';
import { memoryFileSize } from '../memoryImports';
import MemoryImportFile from './MemoryImportFile.vue';

const props = defineProps<{ source: LongMemorySource }>();
const datasetId = computed(() => /^memory-import:([a-f0-9]{64}):/.exec(props.source.reference?.resourceId ?? '')?.[1]);
const files = ref<ImportFile[]>(), selected = ref<ImportFile>(), busy = ref(false), error = ref('');
async function load() {
  if (busy.value || !datasetId.value) return;
  busy.value = true; error.value = '';
  try { files.value = await call<ImportFile[]>('memory.import.source', { id: datasetId.value, sourceId: props.source.id }); }
  catch (cause) { error.value = (cause as Error).message; }
  finally { busy.value = false; }
}
</script>
<template>
  <div v-if="datasetId" class="memory-source-files">
    <button v-if="!files" :disabled="busy" @click="load">{{ busy ? '正在读取附件…' : '查看原始文件与附件' }}</button>
    <div v-else class="source-file-list"><button v-for="file in files" :key="file.id" @click="selected=file">{{ file.path.split('/').at(-1) }} <small>{{ memoryFileSize(file.bytes) }}</small></button><p v-if="!files.length" class="memory-muted">原始档案的关联清单未随本次归档恢复。</p></div>
    <p v-if="error" class="memory-error" role="alert">{{ error }}</p>
    <MemoryImportFile v-if="selected" :dataset-id="datasetId" :file="selected" @close="selected=undefined" />
  </div>
</template>
<style scoped>
.memory-source-files{margin:12px 0}.source-file-list{display:flex;gap:8px;flex-wrap:wrap}.source-file-list button{max-width:100%;overflow-wrap:anywhere;text-align:left}.source-file-list small{color:var(--muted);font-size:11px;margin-left:7px}
</style>
