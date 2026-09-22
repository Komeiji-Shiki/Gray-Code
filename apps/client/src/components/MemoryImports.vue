<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref } from 'vue';
import type { MemoryImportSummary, MemoryImportFile as ImportFile } from '@graycode/contracts';
import { call } from '../api';
import { memoryFileSize } from '../memoryImports';
import MemoryImportFile from './MemoryImportFile.vue';

const emit = defineEmits<{ browse: [scopeId: string] }>();
const libraries = ref<MemoryImportSummary[]>([]), selectedId = ref(''), error = ref(''), busy = ref(false), loading = ref(false);
const query = ref(''), appliedQuery = ref(''), files = ref<ImportFile[]>([]), total = ref(0), offset = ref(0), nextOffset = ref<number>(), preview = ref<ImportFile>();
const selected = computed(() => libraries.value.find(library => library.id === selectedId.value));
let epoch = 0;
async function loadFiles(next = 0) {
  if (!selectedId.value) return;
  const current = ++epoch; loading.value = true; error.value = '';
  try {
    const page = await call<{ files: ImportFile[]; total: number; offset: number; nextOffset?: number }>('memory.import.files', { id: selectedId.value, query: appliedQuery.value, offset: next, limit: 40 });
    if (current !== epoch) return;
    files.value = page.files; total.value = page.total; offset.value = page.offset; nextOffset.value = page.nextOffset;
  } catch (cause) { if (current === epoch) error.value = (cause as Error).message; }
  finally { if (current === epoch) loading.value = false; }
}
async function choose(id: string) { selectedId.value = id; preview.value = undefined; query.value = ''; appliedQuery.value = ''; await loadFiles(); }
async function setRecall(enabled: boolean) {
  if (busy.value || !selected.value) return;
  const item = selected.value; busy.value = true; error.value = '';
  try { await call('memory.import.recall', { id: item.id, enabled }); item.recallEnabled = enabled; }
  catch (cause) { error.value = (cause as Error).message; }
  finally { busy.value = false; }
}
onMounted(async () => {
  busy.value = true;
  try { libraries.value = await call<MemoryImportSummary[]>('memory.import.list'); if (libraries.value[0]) await choose(libraries.value[0].id); }
  catch (cause) { error.value = (cause as Error).message; }
  finally { busy.value = false; }
});
onBeforeUnmount(() => epoch++);
</script>
<template>
  <section class="memory-imports" aria-label="独立导入资料库">
    <div class="settings-guide"><strong>先核对，再参与对话</strong><p>资料库保留全部原始文件。可编辑记忆与原文件分别保存，确认状态可以逐条修改。启用后，只召回已确认的有效条目；群聊和角色剧情不会使用这里的私人资料。</p></div>
    <p v-if="error" class="memory-error" role="alert">{{ error }}</p>
    <p v-if="!libraries.length" class="memory-muted">{{ busy ? '正在读取资料库…' : '还没有导入资料库。使用 LifeBook 导入命令迁入后，会在这里显示。' }}</p>
    <div v-if="libraries.length" class="import-library-picker"><label>资料库<select :value="selectedId" :disabled="busy" @change="choose(($event.target as HTMLSelectElement).value)"><option v-for="item in libraries" :key="item.id" :value="item.id">{{ item.name }}</option></select></label><button :disabled="busy" @click="emit('browse', selectedId ? selected!.scopeId : '')">查看与编辑记忆</button></div>
    <template v-if="selected">
      <div class="import-stats"><span><strong>{{ selected.originalFileCount.toLocaleString() }}</strong>原始文件</span><span><strong>{{ selected.records.toLocaleString() }}</strong>初次导入条目</span><span><strong>{{ memoryFileSize(selected.bytes) }}</strong>含迁移清单</span></div>
      <div class="import-recall"><label><input type="checkbox" :checked="selected.recallEnabled" :disabled="busy" @change="setRecall(($event.target as HTMLInputElement).checked)">已核对，允许在私人对话中自动召回</label><small>{{ selected.recallEnabled ? '资料库已启用。待核对和存在争议的条目仍不自动召回，全局记忆开关与每轮预算继续生效。' : '当前只供浏览编辑，模型不会自动读取这个资料库。' }}</small></div>
      <details class="import-notes"><summary>迁移说明与图谱数量</summary><p v-for="note in selected.notes" :key="note">{{ note }}</p><p v-if="selected.graph">图谱：{{ selected.graph.entities }} 个实体、{{ selected.graph.facts }} 条事实、{{ selected.graph.episodes }} 个事件、{{ selected.graph.connections }} 条原始连接。</p></details>
      <form class="memory-search" @submit.prevent="appliedQuery=query;loadFiles()"><input v-model="query" aria-label="搜索原始文件路径" placeholder="按文件夹、文件名或后缀筛选"><button :disabled="loading" type="submit">查找文件</button></form>
      <div class="import-page"><span>{{ total ? `${offset + 1}–${Math.min(offset + files.length, total)} / ${total}` : '没有匹配的文件' }}</span><span v-if="loading" role="status">正在读取…</span><button :disabled="loading||offset===0" @click="loadFiles(Math.max(0,offset-40))">上一页</button><button :disabled="loading||nextOffset===undefined" @click="loadFiles(nextOffset)">下一页</button></div>
      <div class="import-files"><button v-for="file in files" :key="file.id" :aria-pressed="preview?.id===file.id" @click="preview=file"><span>{{ file.path }}</span><small>{{ memoryFileSize(file.bytes) }}</small></button></div>
      <MemoryImportFile v-if="preview" :dataset-id="selected.id" :file="preview" @close="preview=undefined" />
    </template>
  </section>
</template>
<style scoped>
.memory-imports{padding:20px 24px;min-width:0;overflow:auto;flex:1}.import-library-picker{display:flex;align-items:flex-end;gap:12px;flex-wrap:wrap;margin:20px 0}.import-library-picker label{display:flex;flex-direction:column;gap:7px;flex:1;min-width:160px}.import-library-picker select{width:100%;min-width:0}.import-stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));border-block:1px solid var(--border);margin:18px 0}.import-stats span{color:var(--muted);font-size:11px;padding:15px;border-right:1px solid var(--border)}.import-stats span:first-child{padding-left:0}.import-stats span:last-child{border-right:0}.import-stats strong{display:block;font-size:21px;color:var(--text);font-weight:500;margin-bottom:7px;overflow-wrap:anywhere}.import-recall{margin:20px 0}.import-recall label{display:flex;gap:9px;align-items:center;line-height:1.8}.import-recall small{display:block;color:var(--muted);font-size:12px;line-height:1.8;margin:6px 0 0 26px}.import-notes{font-size:12px;line-height:1.8;margin-bottom:22px;color:var(--muted)}.import-page{display:flex;gap:8px;align-items:center;padding:12px 0;font-size:11px;color:var(--muted);flex-wrap:wrap}.import-page>span:first-child{margin-right:auto}.import-files{border-top:1px solid var(--border);max-height:340px;overflow:auto}.import-files>button{border:0;border-bottom:1px solid var(--border);background:transparent;display:flex;width:100%;gap:16px;text-align:left;align-items:center;padding:9px 4px}.import-files>button>span{flex:1;min-width:0;overflow-wrap:anywhere;line-height:1.6}.import-files small{color:var(--muted);font-size:11px;white-space:nowrap}.import-files>button[aria-pressed=true]{background:var(--hover);border-left:2px solid var(--accent)}@media(max-width:700px){.memory-imports{padding:14px}.import-stats span{padding:10px}.import-stats strong{font-size:17px}}
</style>
