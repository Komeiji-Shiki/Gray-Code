<script setup lang="ts">
import { computed, ref,onMounted,onUnmounted } from 'vue';
import type { CharacterResource } from '@graycode/contracts';
import { call } from '../api';
import WorldbookEditor from './WorldbookEditor.vue';
import MemoryLibrary from './MemoryLibrary.vue';

type ResourceRow = Omit<CharacterResource, 'raw' | 'source'> & { revision: number; resolvedReferences?: Record<string, string> };
const emit = defineEmits<{ close: []; play: [id: string]; pets: [] }>();
const props = defineProps<{ initialTab?: 'resources' | 'memory' }>();
const dialog=ref<HTMLDialogElement>();
const tab=ref<'resources'|'memory'>(props.initialTab ?? 'resources');
const memoryOpened=ref(props.initialTab === 'memory');
const memoryLibrary=ref<{dirty:boolean;busy:boolean;discardChanges():void}>();
const worldbookEditor=ref<{dirty:boolean;discardChanges():void}>();
function requestClose(){navigate(()=>emit('close'),true);}
onMounted(()=>dialog.value?.showModal());
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
const bindingBaseline = ref('');
const pendingNavigation = ref<{action:()=>Promise<void>|void;leaveDialog:boolean}|null>(null);
let selectionEpoch = 0;
const bindingDraft = () => JSON.stringify([name.value, worldbookIds.value, regexIds.value, references.value]);
const bindingDirty = computed(() => !!selected.value && bindingDraft() !== bindingBaseline.value);
const resourceDirty = computed(() => bindingDirty.value || !!worldbookEditor.value?.dirty);
const navigationBusy = computed(() => busy.value || !!memoryLibrary.value?.busy);
const kinds: Record<string, string> = { character: '角色卡', worldbook: '世界书', regex: '正则' };
const visible = computed(() => items.value.filter(item => !filter.value || item.name.toLocaleLowerCase().includes(filter.value.toLocaleLowerCase())));
const books = computed(() => items.value.filter(item => item.kind === 'worldbook'));
const regexes = computed(() => items.value.filter(item => item.kind === 'regex'));
const rpc = <T,>(type: string, data: Record<string, unknown> = {}) => call<T>('ui.request', { type, data });
async function perform(action: () => Promise<void>) {
  if(busy.value)return;
  busy.value = true; error.value = '';
  try { await action(); } catch (cause) { error.value = (cause as Error).message; }
  finally { busy.value = false; }
}
function navigate(action:()=>Promise<void>|void,leaveDialog=false){
  if(navigationBusy.value)return;
  if(resourceDirty.value||leaveDialog&&memoryLibrary.value?.dirty){pendingNavigation.value={action,leaveDialog};return;}
  void perform(async()=>{await action();});
}
function restoreBindings(){
  const item=selected.value;if(!item)return;
  name.value=item.name;worldbookIds.value=[...item.bindings.worldbookIds];regexIds.value=[...item.bindings.regexIds];references.value={...item.resolvedReferences};
  bindingBaseline.value=bindingDraft();
}
function discardAndContinue(){
  const pending=pendingNavigation.value;if(!pending)return;pendingNavigation.value=null;
  restoreBindings();worldbookEditor.value?.discardChanges();if(pending.leaveDialog)memoryLibrary.value?.discardChanges();
  void perform(async()=>{await pending.action();});
}
function openPets(){navigate(()=>{emit('close');emit('pets');},true);}
function play(){if(selected.value){const id=selected.value.id;navigate(()=>{emit('close');emit('play',id);},true);}}
async function reload() { items.value = await rpc<ResourceRow[]>('characters.list'); }
async function choose(id: string) {
  const epoch = ++selectionEpoch;
  const result = await rpc<{ info: ResourceRow & { source: { mimeType: string } }; resource: Pick<CharacterResource, 'raw'>; revision: number }>('characters.get', { id });
  if (epoch !== selectionEpoch) return;
  let image='';
  if (result.info.source.mimeType === 'image/png') {
    const source = await rpc<CharacterResource['source']>('characters.original', { id });
    if (epoch !== selectionEpoch) return;
    image = 'data:image/png;base64,' + source.inlineData.data;
  }
  selected.value = { ...result.info, revision: result.revision }; raw.value = result.resource.raw;previewImage.value=image;restoreBindings();
  missing.value = [...new Set([...result.info.bindings.missing, ...Object.keys(references.value)])];
}
async function importFiles(event: Event) {
  const input = event.target as HTMLInputElement;
  const files = [...input.files ?? []]; input.value = '';
  if(!files.length)return;
  navigate(async () => {
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
  selected.value = null;raw.value=undefined; await reload();
}
onUnmounted(()=>{selectionEpoch++;});
void perform(reload);
</script>
<template>
  <dialog ref="dialog" class="resource-library" aria-label="资料库" @cancel.prevent="requestClose">
    <header><strong>资料库</strong><nav aria-label="资料类型"><button :aria-pressed="tab==='resources'" @click="tab='resources'">角色资料</button><button :aria-pressed="tab==='memory'" @click="tab='memory';memoryOpened=true">长期记忆</button></nav><span v-if="tab==='resources'">角色卡 · 世界书 · 正则</span><label v-if="tab==='resources'" class="import-resource" :class="{ disabled: busy }">导入 PNG / JSON<input type="file" accept=".png,.json" multiple :disabled="busy" @change="importFiles"></label><button class="resource-close" :disabled="navigationBusy" @click="requestClose">关闭</button></header>
    <div v-if="pendingNavigation" class="resource-confirm" role="status"><p>资料库还有未保存的更改。可以继续编辑，或放弃后继续刚才的操作。</p><button @click="pendingNavigation=null">继续编辑</button><button :disabled="navigationBusy" @click="discardAndContinue">放弃更改并继续</button></div>
    <div class="pet-library-entry"><button :disabled="navigationBusy" @click="openPets">桌宠与 Live2D</button></div>
    <MemoryLibrary v-if="memoryOpened" v-show="tab==='memory'" ref="memoryLibrary" @close="emit('close')" />
    <p v-if="tab==='resources'&&error" class="resource-error">{{ error }}</p>
    <div v-show="tab==='resources'" class="resource-columns"><aside><input v-model="filter" placeholder="搜索资料名称" aria-label="搜索资料"><p v-if="!items.length" class="resource-hint">导入一张角色卡，内嵌世界书与随卡正则会分别保存并保持绑定。</p>
      <button v-for="item in visible" :key="item.id" class="resource-row" :aria-pressed="selected?.id === item.id" :disabled="busy" @click="navigate(() => choose(item.id))"><span>{{ kinds[item.kind] }}</span><strong>{{ item.name }}</strong><small v-if="item.bindings.missing.length">{{ item.bindings.missing.length }} 个外部引用待绑定</small></button>
    </aside><main v-if="selected" :inert="busy"><div class="resource-heading"><span>{{ kinds[selected.kind] }}</span><code>{{ selected.id }}</code><span v-if="resourceDirty">未保存</span></div>
      <img v-if="previewImage" :src="previewImage" :alt="selected.name" class="character-image"><label>资料名称<input v-model="name" :disabled="busy"></label>
      <template v-if="selected.kind === 'character'"><fieldset><legend>绑定世界书</legend><label v-for="book in books" :key="book.id" class="resource-check"><input v-model="worldbookIds" type="checkbox" :value="book.id">{{ book.name }}</label><p v-if="!books.length" class="resource-hint">可以继续导入独立世界书。</p></fieldset>
        <fieldset><legend>绑定正则</legend><label v-for="regex in regexes" :key="regex.id" class="resource-check"><input v-model="regexIds" type="checkbox" :value="regex.id">{{ regex.name }}</label></fieldset>
        <fieldset v-if="missing.length"><legend>外部引用对应关系</legend><label v-for="reference in missing" :key="reference">{{ reference }}<select v-model="references[reference]"><option value="">尚未绑定</option><option v-for="book in books" :key="book.id" :value="book.id">{{ book.name }}</option></select></label></fieldset>
      </template>
      <p class="resource-hint">资料按固定 ID 关联，重名文件不会合并。原文件和未知扩展字段会保留。</p>
      <div class="resource-actions"><button v-if="selected.kind === 'character'" :disabled="navigationBusy" @click="play">开始角色对话</button><button :disabled="busy||!bindingDirty" @click="perform(save)">保存名称与绑定</button><button :disabled="busy" @click="perform(exportOriginal)">导出原文件</button><button :disabled="busy" @click="navigate(archive)">移出资料库</button></div>
      <p class="resource-hint">移出后不再显示在列表中，已有会话引用与回合记录仍然保留。</p>
      <WorldbookEditor v-if="selected.kind === 'worldbook'" :key="selected.id" ref="worldbookEditor" :raw="raw" :busy="busy" @save="value => perform(() => saveWorldbook(value))" />
      <details><summary>查看当前定义</summary><pre>{{ JSON.stringify(raw, null, 2) }}</pre></details>
    </main><main v-else class="resource-hint">选择资料以查看内容和绑定关系。</main></div>
  </dialog>
</template>
<style scoped>
.resource-library{margin:0;padding:0;width:auto;height:auto;max-width:none;max-height:none}.resource-library::backdrop{background:#0008}.resource-library>header>nav{display:flex;gap:5px}.resource-library>header>nav>button[aria-pressed="true"]{color:var(--accent);border-bottom:2px solid var(--accent)}.resource-close{margin-left:auto}.resource-library button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.resource-confirm{padding:12px 18px;border-block:1px solid #8f784f;background:#c39d5910;line-height:1.8;font-size:12px}.resource-confirm p{margin:0 0 8px}.resource-confirm button{margin-right:8px}.resource-library button:disabled{opacity:.5;cursor:default}.resource-confirm~.resource-columns{min-height:0}
.character-image{max-width:200px;max-height:260px;object-fit:contain;display:block;margin-bottom:18px}.resource-library{position:fixed;inset:50px 18px 32px;z-index:60;background:var(--background,#15171b);color:var(--text);border:1px solid var(--border);display:flex;flex-direction:column;box-shadow:0 16px 60px #0008}.resource-library>header{display:flex;align-items:center;gap:16px;border-bottom:1px solid var(--border);padding:14px 18px}.resource-library>header>span{color:var(--muted);font-size:12px}.import-resource{margin-left:auto;cursor:pointer;border:1px solid var(--border);padding:7px 12px}.import-resource input{display:none}.resource-library button,.resource-library input,.resource-library select{font:inherit;background:var(--surface);color:var(--text);border:1px solid var(--border);border-radius:0;padding:7px 10px}.resource-library button{cursor:pointer}.resource-columns{display:grid;grid-template-columns:260px minmax(0,1fr);flex:1;min-height:0}.resource-columns>aside{border-right:1px solid var(--border)}.resource-columns>aside,.resource-columns>main{overflow:auto;padding:18px}.resource-columns>aside>input{width:100%;box-sizing:border-box;margin-bottom:14px}.resource-row{display:flex;flex-direction:column;gap:7px;width:100%;text-align:left;margin-bottom:8px}.resource-row[aria-pressed="true"]{border-left:3px solid var(--accent)}.resource-row span,.resource-row small{color:var(--muted);font-size:11px}.resource-heading{display:flex;gap:14px;margin-bottom:20px;color:var(--muted);font-size:12px;flex-wrap:wrap}.resource-columns>main>label,.resource-library fieldset>label{display:flex;flex-direction:column;gap:8px;margin:12px 0}.resource-library fieldset{border:1px solid var(--border);margin:22px 0;padding:12px 16px}.resource-library fieldset>label.resource-check{flex-direction:row;align-items:center}.resource-hint{font-size:12px;color:var(--muted);line-height:1.8}.resource-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:20px}.resource-library pre{font:12px/1.7 var(--code-font,monospace);white-space:pre-wrap;overflow-wrap:anywhere}.resource-library summary{cursor:pointer}.resource-error{color:#df7474;margin:8px 18px}.disabled{opacity:.5}@media(max-width:650px){.resource-library{inset:80px 4px 24px}.resource-columns{grid-template-columns:150px minmax(0,1fr)}.resource-columns>aside,.resource-columns>main{padding:10px}.resource-library>header{gap:8px;flex-wrap:wrap}.resource-library>header>span{display:none}}
</style>
