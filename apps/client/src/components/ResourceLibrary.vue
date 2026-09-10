<script setup lang="ts">
import { computed, ref } from 'vue';
import type { CharacterResource } from '@graycode/contracts';
import { call } from '../api';
import WorldbookEditor from './WorldbookEditor.vue';

type ResourceRow = Omit<CharacterResource, 'raw' | 'source'> & { revision: number; resolvedReferences?: Record<string, string> };
const emit = defineEmits<{ close: []; play: [id: string] }>();
const items = ref<ResourceRow[]>([]);
const selected = ref<ResourceRow | null>(null);
const raw = ref<unknown>();
const previewImage = ref('');
const name = ref('');
const worldbookIds = ref<string[]>([]);
const regexIds = ref<string[]>([]);
const references = ref<Record<string, string>>({});
const missing = ref<string[]>([]);
const error = ref('');
const busy = ref(false);
const filter = ref('');
let selectionEpoch = 0;
const kinds: Record<string, string> = { character: '角色卡', worldbook: '世界书', regex: '正则' };
const visible = computed(() => items.value.filter(item => !filter.value || item.name.toLocaleLowerCase().includes(filter.value.toLocaleLowerCase())));
const books = computed(() => items.value.filter(item => item.kind === 'worldbook'));
const regexes = computed(() => items.value.filter(item => item.kind === 'regex'));
const rpc = <T,>(type: string, data: Record<string, unknown> = {}) => call<T>('ui.request', { type, data });
async function perform(action: () => Promise<void>) {
  busy.value = true; error.value = '';
  try { await action(); } catch (cause) { error.value = (cause as Error).message; }
  finally { busy.value = false; }
}
async function reload() { items.value = await rpc<ResourceRow[]>('characters.list'); }
async function choose(id: string) {
  const epoch = ++selectionEpoch;
  const result = await rpc<{ info: ResourceRow & { source: { mimeType: string } }; resource: Pick<CharacterResource, 'raw'>; revision: number }>('characters.get', { id });
  if (epoch !== selectionEpoch) return;
  selected.value = { ...result.info, revision: result.revision }; raw.value = result.resource.raw;
  previewImage.value = '';
  if (result.info.source.mimeType === 'image/png') {
    const source = await rpc<CharacterResource['source']>('characters.original', { id });
    if (epoch !== selectionEpoch) return;
    previewImage.value = 'data:image/png;base64,' + source.inlineData.data;
  }
  name.value = result.info.name; worldbookIds.value = [...result.info.bindings.worldbookIds]; regexIds.value = [...result.info.bindings.regexIds];
  references.value = { ...result.info.resolvedReferences };
  missing.value = [...new Set([...result.info.bindings.missing, ...Object.keys(references.value)])];
}
async function importFiles(event: Event) {
  const input = event.target as HTMLInputElement;
  const files = [...input.files ?? []]; input.value = '';
  await perform(async () => {
    let lastId = '';
    for (const file of files) {
      if (file.size > 32 * 1024 * 1024) throw new Error(`${file.name} 超过 32 MiB。`);
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = () => reject(reader.error); reader.readAsDataURL(file);
      });
      const result = await rpc<{ id: string }>('characters.import', { name: file.name, data }); lastId = result.id;
    }
    await reload(); if (lastId) await choose(lastId);
  });
}
async function save() {
  if (!selected.value) return;
  await rpc('characters.bind', { id: selected.value.id, revision: selected.value.revision, name: name.value,
    worldbookIds: worldbookIds.value, regexIds: regexIds.value, resolvedReferences: references.value });
  await reload(); await choose(selected.value.id);
}
async function saveWorldbook(value: Record<string, unknown> | unknown[]) {
  if (!selected.value) return;
  await rpc('characters.worldbook.update', { id: selected.value.id, revision: selected.value.revision, raw: value, name: name.value });
  await reload(); await choose(selected.value.id);
}
async function exportOriginal() {
  if (!selected.value) return;
  const source = await rpc<CharacterResource['source']>('characters.original', { id: selected.value.id });
  const bytes = Uint8Array.from(atob(source.inlineData.data), char => char.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: source.inlineData.mimeType }));
  const link = document.createElement('a'); link.href = url; link.download = source.name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function archive() {
  if (!selected.value) return;
  await rpc('characters.archive', { id: selected.value.id, revision: selected.value.revision });
  selected.value = null; await reload();
}
void perform(reload);
</script>
<template>
  <section class="resource-library" aria-label="角色资料库">
    <header><strong>资料库</strong><span>角色卡 · 世界书 · 正则</span><label class="import-resource" :class="{ disabled: busy }">导入 PNG / JSON<input type="file" accept=".png,.json" multiple :disabled="busy" @change="importFiles"></label><button @click="emit('close')">关闭</button></header>
    <p v-if="error" class="resource-error">{{ error }}</p>
    <div class="resource-columns"><aside><input v-model="filter" placeholder="搜索资料名称" aria-label="搜索资料"><p v-if="!items.length" class="resource-hint">导入一张角色卡，内嵌世界书与随卡正则会分别保存并保持绑定。</p>
      <button v-for="item in visible" :key="item.id" class="resource-row" :aria-pressed="selected?.id === item.id" :disabled="busy" @click="perform(() => choose(item.id))"><span>{{ kinds[item.kind] }}</span><strong>{{ item.name }}</strong><small v-if="item.bindings.missing.length">{{ item.bindings.missing.length }} 个外部引用待绑定</small></button>
    </aside><main v-if="selected"><div class="resource-heading"><span>{{ kinds[selected.kind] }}</span><code>{{ selected.id }}</code></div>
      <img v-if="previewImage" :src="previewImage" :alt="selected.name" class="character-image"><label>资料名称<input v-model="name"></label>
      <template v-if="selected.kind === 'character'"><fieldset><legend>绑定世界书</legend><label v-for="book in books" :key="book.id" class="resource-check"><input v-model="worldbookIds" type="checkbox" :value="book.id">{{ book.name }}</label><p v-if="!books.length" class="resource-hint">可以继续导入独立世界书。</p></fieldset>
        <fieldset><legend>绑定正则</legend><label v-for="regex in regexes" :key="regex.id" class="resource-check"><input v-model="regexIds" type="checkbox" :value="regex.id">{{ regex.name }}</label></fieldset>
        <fieldset v-if="missing.length"><legend>外部引用对应关系</legend><label v-for="reference in missing" :key="reference">{{ reference }}<select v-model="references[reference]"><option value="">尚未绑定</option><option v-for="book in books" :key="book.id" :value="book.id">{{ book.name }}</option></select></label></fieldset>
      </template>
      <p class="resource-hint">资料按固定 ID 关联，重名文件不会合并。原文件和未知扩展字段会保留。</p>
      <div class="resource-actions"><button v-if="selected.kind === 'character'" :disabled="busy" @click="emit('play', selected.id)">开始角色对话</button><button :disabled="busy" @click="perform(save)">保存名称与绑定</button><button :disabled="busy" @click="perform(exportOriginal)">导出原文件</button><button :disabled="busy" @click="perform(archive)">移出资料库</button></div>
      <p class="resource-hint">移出后不再显示在列表中，已有会话引用与回合记录仍然保留。</p>
      <WorldbookEditor v-if="selected.kind === 'worldbook'" :key="selected.id" :raw="raw" :busy="busy" @save="value => perform(() => saveWorldbook(value))" />
      <details><summary>查看当前定义</summary><pre>{{ JSON.stringify(raw, null, 2) }}</pre></details>
    </main><main v-else class="resource-hint">选择资料以查看内容和绑定关系。</main></div>
  </section>
</template>
<style scoped>
.character-image{max-width:200px;max-height:260px;object-fit:contain;display:block;margin-bottom:18px}.resource-library{position:fixed;inset:50px 18px 32px;z-index:60;background:var(--background,#15171b);color:var(--text);border:1px solid var(--border);display:flex;flex-direction:column;box-shadow:0 16px 60px #0008}.resource-library>header{display:flex;align-items:center;gap:16px;border-bottom:1px solid var(--border);padding:14px 18px}.resource-library>header>span{color:var(--muted);font-size:12px}.import-resource{margin-left:auto;cursor:pointer;border:1px solid var(--border);padding:7px 12px}.import-resource input{display:none}.resource-library button,.resource-library input,.resource-library select{font:inherit;background:var(--surface);color:var(--text);border:1px solid var(--border);border-radius:0;padding:7px 10px}.resource-library button{cursor:pointer}.resource-columns{display:grid;grid-template-columns:260px minmax(0,1fr);flex:1;min-height:0}.resource-columns>aside{border-right:1px solid var(--border)}.resource-columns>aside,.resource-columns>main{overflow:auto;padding:18px}.resource-columns>aside>input{width:100%;box-sizing:border-box;margin-bottom:14px}.resource-row{display:flex;flex-direction:column;gap:7px;width:100%;text-align:left;margin-bottom:8px}.resource-row[aria-pressed="true"]{border-left:3px solid var(--accent)}.resource-row span,.resource-row small{color:var(--muted);font-size:11px}.resource-heading{display:flex;gap:14px;margin-bottom:20px;color:var(--muted);font-size:12px;flex-wrap:wrap}.resource-columns>main>label,.resource-library fieldset>label{display:flex;flex-direction:column;gap:8px;margin:12px 0}.resource-library fieldset{border:1px solid var(--border);margin:22px 0;padding:12px 16px}.resource-library fieldset>label.resource-check{flex-direction:row;align-items:center}.resource-hint{font-size:12px;color:var(--muted);line-height:1.8}.resource-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:20px}.resource-library pre{font:12px/1.7 var(--code-font,monospace);white-space:pre-wrap;overflow-wrap:anywhere}.resource-library summary{cursor:pointer}.resource-error{color:#df7474;margin:8px 18px}.disabled{opacity:.5}@media(max-width:650px){.resource-library{inset:80px 4px 24px}.resource-columns{grid-template-columns:150px minmax(0,1fr)}.resource-columns>aside,.resource-columns>main{padding:10px}.resource-library>header{gap:8px;flex-wrap:wrap}.resource-library>header>span{display:none}}
</style>
