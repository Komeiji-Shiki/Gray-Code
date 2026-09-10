<script setup lang="ts">
import { computed, ref, watch } from 'vue';
const props = defineProps<{ raw: unknown; busy?: boolean }>();
const emit = defineEmits<{ save: [raw: Record<string, unknown> | unknown[]] }>();
const mode = ref<'simple' | 'advanced'>('simple');
const draft = ref<any>({ entries: [] });
const jsonText = ref('');
const error = ref('');

const search = ref('');
const loadedDefinition = ref('');
const dirty = computed(() => {
  try { return JSON.stringify(mode.value === 'advanced' ? JSON.parse(jsonText.value) : draft.value) !== loadedDefinition.value; }
  catch { return true; }
});
const rows = computed<{ key: string; value: Record<string, any> }[]>(() => {
  const entries = Array.isArray(draft.value) ? draft.value : draft.value?.entries ?? [];
  return Object.entries(entries).map(([key, value]) => ({ key, value: value as Record<string, any> }));
});
const visible = computed(() => rows.value.filter(row => !search.value || `${row.value.comment ?? row.value.name ?? ''} ${row.value.content ?? ''} ${keys(row.value)}`.toLocaleLowerCase().includes(search.value.toLocaleLowerCase())));
watch(() => props.raw, raw => {
  const serialized = JSON.stringify(raw);
  if (serialized === loadedDefinition.value) return;
  loadedDefinition.value = serialized;
  draft.value = JSON.parse(serialized); jsonText.value = JSON.stringify(raw, null, 2); error.value = '';
}, { immediate: true });
function enabled(entry: Record<string, any>) { return entry.enabled !== false && entry.disable !== true; }
function strategy(entry: Record<string, any>) { return entry.constant || entry.activationMode === 'always' ? 'always' : entry.vectorized || entry.activationMode === 'vector' || entry.extensions?.vectorized ? 'vector' : 'keyword'; }
function keys(entry: Record<string, any>) { const values = entry.keys ?? entry.key; return Array.isArray(values) ? values.join('\n') : ''; }
function update(entry: Record<string, any>, field: string, value: any) {
  if (field === 'enabled') { entry.enabled = value; if ('disable' in entry) entry.disable = !value; }
  else if (field === 'strategy') {
    entry.constant = value === 'always';
    if ('activationMode' in entry) entry.activationMode = value;
    if ('vectorized' in entry) entry.vectorized = false;
    if (entry.extensions && 'vectorized' in entry.extensions) entry.extensions.vectorized = false;
  } else if (field === 'keys') {
    const names = String(value).split('\n').map(item => item.trim()).filter(Boolean);
    if ('keys' in entry || !('key' in entry)) entry.keys = names; else entry.key = names;
  } else entry[field] = value;

}
function advancedFeatures(entry: Record<string, any>) {
  const merged = { ...entry.extensions, ...entry };
  const features: string[] = [];
  if ((merged.secondary_keys ?? merged.keysecondary ?? merged.secondaryKey)?.length) features.push('附加关键词条件');
  if (merged.probability !== undefined && merged.probability !== 100) features.push('概率');
  if (merged.group) features.push('包含组');
  if (merged.sticky || merged.cooldown || merged.delay) features.push('黏性／冷却／延迟');
  if (merged.preventRecursion || merged.excludeRecursion || merged.delayUntilRecursion) features.push('递归规则');
  if (merged.scanDepth !== undefined || merged.scan_depth !== undefined) features.push('独立扫描范围');
  const position = merged.position;
  if (position !== undefined && ![0, 1, 'before_char', 'after_char', 'beforeChar', 'afterChar'].includes(position)) features.push('指定插入位置');
  if (merged.use_regex || merged.matchWholeWords || merged.caseSensitive) features.push('匹配规则');
  if (strategy(entry) === 'vector') features.push('向量激活');
  return features;
}
function add() {
  if (!Array.isArray(draft.value) && (!draft.value.entries || typeof draft.value.entries !== 'object')) draft.value.entries = [];
  const container = Array.isArray(draft.value) ? draft.value : draft.value.entries;
  const ids = rows.value.map(row => Number(row.value.id ?? row.value.uid ?? row.key)).filter(Number.isSafeInteger);
  const id = ids.length ? Math.max(...ids) + 1 : 0;
  const entry = { id, comment: '新条目', content: '', keys: [], constant: false, enabled: true, position: 'before_char', insertion_order: id };
  if (Array.isArray(container)) container.push(entry); else container[String(id)] = entry;

}
function remove(key: string) {
  const container = Array.isArray(draft.value) ? draft.value : draft.value.entries;
  if (Array.isArray(container)) container.splice(Number(key), 1); else delete container[key];

}
function switchMode(next: 'simple' | 'advanced') {
  error.value = '';
  if (next === 'simple' && mode.value === 'advanced') {
    try { const value = JSON.parse(jsonText.value); if (!Array.isArray(value) && (!value || typeof value !== 'object' || !value.entries || typeof value.entries !== 'object')) throw new Error(); draft.value = value; }
    catch { error.value = 'JSON 格式有误，请修改后再切换。'; return; }
  } else if (next === 'advanced') jsonText.value = JSON.stringify(draft.value, null, 2);
  mode.value = next;
}
function save() {
  try { emit('save', mode.value === 'advanced' ? JSON.parse(jsonText.value) : draft.value); }
  catch { error.value = 'JSON 格式有误，请修改后保存。'; }
}
</script>
<template>
  <section class="worldbook-editor" :inert="busy"><header><strong>世界书条目</strong><nav><button :aria-pressed="mode === 'simple'" @click="switchMode('simple')">简单模式</button><button :aria-pressed="mode === 'advanced'" @click="switchMode('advanced')">高级模式</button></nav><span v-if="dirty">未保存</span></header>
    <p>常驻条目每次参与，关键词条目在最近的对话提到关键词时参与。扫描范围和总 Token 上限在角色对话配置中设置。</p>
    <p v-if="error" class="worldbook-error">{{ error }}</p>
    <template v-if="mode === 'simple'"><div class="worldbook-toolbar"><input v-model="search" placeholder="搜索关键词或正文"><button :disabled="busy" @click="add">添加关键词条目</button></div>
      <p v-if="draft?.enabled === false">这本世界书整体已停用，可以在高级模式中修改文件级 enabled 字段。</p>
      <p v-if="!rows.length">添加一个条目，写下需要模型记住的人物、地点或设定。</p>
      <article v-for="row in visible" :key="row.key" class="worldbook-entry"><div class="worldbook-entry-top"><input class="entry-name" :value="row.value.comment ?? row.value.name ?? ''" placeholder="条目名称（自己看的）" @input="update(row.value, 'comment' in row.value || !('name' in row.value) ? 'comment' : 'name', ($event.target as HTMLInputElement).value)"><label class="enabled-check"><input type="checkbox" :checked="enabled(row.value)" @change="update(row.value, 'enabled', ($event.target as HTMLInputElement).checked)">启用</label><button :disabled="busy" @click="remove(row.key)">删除条目</button></div>
        <label>什么时候使用<select :value="strategy(row.value)" @change="update(row.value, 'strategy', ($event.target as HTMLSelectElement).value)"><option value="keyword">提到关键词时</option><option value="always">常驻</option><option v-if="strategy(row.value) === 'vector'" value="vector">高级规则：向量激活</option></select></label>
        <label v-if="strategy(row.value) === 'keyword'">关键词<textarea :value="keys(row.value)" rows="2" placeholder="每行一个关键词，命中其中一个即可；高级附加条件仍会生效" @input="update(row.value, 'keys', ($event.target as HTMLTextAreaElement).value)"></textarea></label>
        <label>给模型的正文<textarea :value="row.value.content ?? ''" rows="5" placeholder="例如：青石镇位于山谷中，每周三举行集市。" @input="update(row.value, 'content', ($event.target as HTMLTextAreaElement).value)"></textarea></label>
        <p v-if="advancedFeatures(row.value).length" class="advanced-active">此条目还使用：{{ advancedFeatures(row.value).join('、') }}。简单模式会保留这些规则。</p>
      </article>
    </template>
    <template v-else><p>高级模式编辑完整 JSON。原有字段和扩展会保留，修改后可返回简单模式继续编辑。</p><textarea v-model="jsonText" class="worldbook-json" spellcheck="false"></textarea></template>
    <footer><button :disabled="busy || !dirty" @click="save">保存世界书</button><span>新条目使用角色设定前的位置；具体插入仍由预设控制。</span></footer>
  </section>
</template>
<style scoped>
.worldbook-editor{border-top:1px solid var(--border);margin-top:26px;padding-top:18px}.worldbook-editor header,.worldbook-toolbar,.worldbook-entry-top,.worldbook-editor footer{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.worldbook-editor header nav{margin-left:auto;display:flex;gap:4px}.worldbook-editor p,.worldbook-editor footer span{font-size:12px;line-height:1.7;color:var(--muted)}.worldbook-editor button,.worldbook-editor input,.worldbook-editor textarea,.worldbook-editor select{font:inherit;color:var(--text);background:var(--surface);border:1px solid var(--border);border-radius:0;padding:7px 10px}.worldbook-editor button{cursor:pointer}.worldbook-editor button[aria-pressed="true"]{color:var(--accent);border-bottom-color:var(--accent)}.worldbook-editor label{display:flex;flex-direction:column;gap:7px;margin-top:14px}.worldbook-toolbar{margin:20px 0}.worldbook-toolbar>input{flex:1;min-width:150px}.worldbook-entry{border:1px solid var(--border);border-left:3px solid var(--accent);padding:16px;margin-bottom:16px}.worldbook-entry .entry-name{flex:1;min-width:130px}.worldbook-entry .enabled-check{flex-direction:row;align-items:center;margin:0}.worldbook-entry textarea{resize:vertical}.worldbook-editor footer{margin-top:16px}.worldbook-json{width:100%;min-height:420px;box-sizing:border-box;font:12px/1.7 var(--code-font,monospace)!important;resize:vertical}.worldbook-editor .worldbook-error{color:#df7474}.advanced-active{border-top:1px solid var(--border);padding-top:10px}
</style>
