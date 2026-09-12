<script setup lang="ts">
import { computed, onUnmounted, reactive, ref, watch } from 'vue';
import type { ProjectReplacement, ProjectSearchQuery, ProjectSearchResult, SourceRange } from '@graycode/contracts';
import type { EditBatchHandle } from '../../../../shared/editorBatchHistory';
import { call } from '../api';
const props = defineProps<{ workspaceId: string; flush: () => Promise<unknown>;
  apply: (workspaceId: string, edits: ProjectReplacement[]) => Promise<EditBatchHandle>; saveAll: () => Promise<void> }>();
const emit = defineEmits<{ open: [path: string, range: SourceRange, workspaceId: string] }>();
const options = reactive<ProjectSearchQuery>({ query: '', regex: false, caseSensitive: false, wholeWord: false, include: '', exclude: '' });
const replacement = ref(''); const replacing = ref(false); const busy = ref(false); const notice = ref(''); const error = ref('');
const result = ref<ProjectSearchResult>(); const selected = ref<string[]>([]); const searched = ref('');
let requestId: string | undefined; let generation = 0; let lastBatch: EditBatchHandle | undefined;
const batchAvailable = ref(false);
const stale = computed(() => searched.value !== JSON.stringify(options));
function cancel() {
  generation++; busy.value = false;
  if (requestId) void call('files.searchCancel', { requestId }).catch(() => {});
  requestId = undefined;
}
async function search() {
  cancel(); const current = generation; const workspaceId = props.workspaceId;
  if (!workspaceId) { error.value = '请先选择项目。'; return; }
  const query = structuredClone({ ...options });
  busy.value = true; error.value = ''; notice.value = ''; result.value = undefined;
  requestId = crypto.randomUUID();
  try {
    await props.flush();
    if (current !== generation) return;
    const value = await call<ProjectSearchResult>('files.search', { workspaceId, requestId, options: query });
    if (current !== generation) return;
    result.value = value; selected.value = value.files.map(file => file.path); searched.value = JSON.stringify(query);
  } catch (cause) { if (current === generation) error.value = String(cause); }
  finally { if (current === generation) { busy.value = false; requestId = undefined; } }
}
async function replace() {
  if (!result.value || result.value.truncated || stale.value || busy.value) return;
  const workspaceId = props.workspaceId, current = generation;
  busy.value = true; error.value = ''; notice.value = '';
  try {
    await props.flush();
    const edits = await call<ProjectReplacement[]>('files.replacePreview', { workspaceId, options: { ...options }, replacement: replacement.value,
      files: result.value.files.filter(file => selected.value.includes(file.path)).map(({ path, hash }) => ({ path, hash })) });
    if (current !== generation) return;
    const applied = await props.apply(workspaceId, edits);
    if (current !== generation) return;
    lastBatch = applied; batchAvailable.value = edits.length > 0;
    notice.value = edits.length ? `已修改 ${edits.length} 个文件的编辑内容。可以撤销整批修改，确认后再保存。` : '替换后内容没有变化。';
    result.value = undefined;
  } catch (cause) { if (current === generation) error.value = String(cause); }
  finally { if (current === generation) busy.value = false; }
}
async function batch(undo: boolean) {
  if (!lastBatch || busy.value) return;
  busy.value = true; error.value = '';
  try { await (undo ? lastBatch.undo() : lastBatch.redo()); await props.flush(); notice.value = undo ? '已撤销整批替换。' : '已重做整批替换。'; }
  catch (cause) { error.value = String(cause); }
  finally { busy.value = false; }
}
async function save() {
  busy.value = true; error.value = '';
  try { await props.saveAll(); notice.value = '已保存打开文件的修改。'; }
  catch (cause) { error.value = String(cause); }
  finally { busy.value = false; }
}
watch(() => props.workspaceId, () => { cancel(); result.value = undefined; lastBatch = undefined; batchAvailable.value = false; notice.value = ''; error.value = ''; });
onUnmounted(cancel);
</script>
<template>
  <section class="search-panel">
    <header><strong>项目搜索</strong><button :aria-pressed="replacing" @click="replacing = !replacing">{{ replacing ? '收起替换' : '显示替换' }}</button></header>
    <form class="search-form" @submit.prevent="search">
      <div class="search-row"><input v-model="options.query" aria-label="项目搜索内容" placeholder="搜索项目中的文本" /><button v-if="requestId" type="button" @click="cancel">停止</button><button v-else :disabled="busy || !options.query">搜索</button></div>
      <div class="search-options"><label><input v-model="options.caseSensitive" type="checkbox" />区分大小写</label><label><input v-model="options.wholeWord" type="checkbox" />全词</label><label><input v-model="options.regex" type="checkbox" />正则表达式</label></div>
      <div class="search-paths"><input v-model="options.include" aria-label="搜索包含文件" placeholder="包含文件，例如 **/*.ts" /><input v-model="options.exclude" aria-label="搜索排除文件" placeholder="额外排除，例如 **/generated/**" /></div>
      <div v-if="replacing" class="search-row"><input v-model="replacement" aria-label="替换内容" :placeholder="options.regex ? '替换内容，可使用 $1 等捕获组' : '替换内容，留空表示删除匹配文本'" /><button type="button" :disabled="busy || stale || !selected.length || !result || result.truncated" @click="replace">替换所选文件</button></div>
    </form>
    <p v-if="busy" class="search-notice" role="status">正在处理…</p><p v-if="error" class="search-error" role="alert">{{ error }}</p><p v-if="notice" class="search-notice" role="status">{{ notice }}</p>
    <div v-if="batchAvailable" class="search-batch"><button :disabled="busy" @click="batch(true)">撤销这次替换</button><button :disabled="busy" @click="batch(false)">重做这次替换</button><button :disabled="busy" @click="save">保存全部</button></div>
    <div class="search-results">
      <template v-if="result">
        <p class="search-notice">{{ result.count }} 处匹配，{{ result.files.length }} 个文件<span v-if="stale"> · 条件已变化，请重新搜索</span></p>
        <p v-if="result.truncated" class="search-notice">结果达到数量限制，请缩小搜索范围后再替换。</p>
        <details v-for="file in result.files" :key="file.path" open class="search-file">
          <summary><input v-if="replacing" v-model="selected" type="checkbox" :value="file.path" :aria-label="'选择替换 ' + file.path" @click.stop /><span>{{ file.path }}</span><small>{{ file.matches.length }}<span v-if="file.draft"> · 未保存</span></small></summary>
          <button v-for="(match, index) in file.matches" :key="index" class="search-match" :title="`${file.path}:${match.range.start.line + 1}:${match.range.start.character + 1}`" @click="emit('open', file.path, match.range, workspaceId)"><span>{{ match.range.start.line + 1 }}</span><code>{{ match.preview }}</code></button>
        </details>
        <details v-if="result.skipped.length" class="search-skipped"><summary>{{ result.skipped.length }} 个文件无法作为文本搜索</summary><p v-for="file in result.skipped" :key="file.path">{{ file.path }} · {{ file.reason }}</p></details>
      </template>
      <p v-else-if="!busy && !notice" class="search-notice">输入关键词后按 Enter。搜索包含本窗口的未保存内容，并沿用文件搜索设置中的排除规则。</p>
    </div>
  </section>
</template>
<style scoped>
.search-panel{height:100%;min-height:0;display:flex;flex-direction:column;background:var(--panel)}header{display:flex;align-items:center;justify-content:space-between;padding:13px 15px;border-bottom:1px solid var(--border)}button,input{font:inherit;font-size:12px;border-radius:0}button{cursor:pointer;background:transparent;border:1px solid var(--border);padding:5px 8px;color:var(--text)}button:disabled{opacity:.45;cursor:default}button:hover:not(:disabled){background:var(--hover)}input:not([type=checkbox]){min-width:0;width:100%;background:var(--surface);border:1px solid var(--border);color:var(--text);padding:8px}.search-form{display:grid;gap:9px;padding:12px 14px;border-bottom:1px solid var(--border)}.search-row{display:flex;gap:6px}.search-row button{white-space:nowrap}.search-options{display:flex;gap:12px;flex-wrap:wrap;font-size:11px;color:var(--muted)}.search-options label{display:flex;align-items:center;gap:3px}.search-paths{display:grid;gap:6px}.search-notice,.search-error{margin:10px 14px;font-size:12px;line-height:1.6;overflow-wrap:anywhere}.search-notice{color:var(--muted)}.search-error{color:var(--danger,#f08080)}.search-batch{display:flex;gap:6px;padding:0 14px 10px;flex-wrap:wrap}.search-results{flex:1;min-height:0;overflow:auto}.search-file{border-bottom:1px solid var(--border)}.search-file summary{display:flex;gap:6px;align-items:center;padding:9px 14px;cursor:pointer;font-size:12px}.search-file summary>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.search-file small{color:var(--muted);white-space:nowrap;margin-left:auto}.search-match{display:flex;width:100%;text-align:left;border:0;padding:6px 14px;gap:10px;overflow:hidden}.search-match>span{min-width:30px;color:var(--muted);text-align:right}.search-match code{font:inherit;font-family:var(--code-font,monospace);white-space:pre;overflow:hidden;text-overflow:ellipsis}.search-skipped{padding:12px 14px;color:var(--muted);font-size:11px;overflow-wrap:anywhere}button:focus-visible,input:focus-visible,summary:focus-visible{outline:1px solid var(--accent);outline-offset:-1px}
</style>
