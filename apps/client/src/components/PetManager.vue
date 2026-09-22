<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import type { PetCommandInput, PetConfiguration, PetParameter, PetResource, PetSnapshot } from '@graycode/contracts';
import { call } from '../api';
import { collectPetImport, fileBase64, selectedPath } from '../pets/importFiles';
import playerNotices from '../../public/pets-notices.txt?raw';
import { petAnimations } from '../../../../shared/petFormat';
import PetPlayer from './PetPlayer.vue';
const emit = defineEmits<{ close: []; screenSense: [] }>();
const dialog = ref<HTMLDialogElement>(), player = ref<InstanceType<typeof PetPlayer>>();
const resources = ref<PetResource[]>([]), snapshot = ref<PetSnapshot>(), selected = ref(''), parameters = ref<PetParameter[]>([]);
const error = ref(''), notice = ref(''), busy = ref(false), previewReady = ref(false), confirmLeave = ref(false), confirmingRemove = ref(false), previewKey = ref(0);
const pendingFiles = ref<File[]>([]), entry = ref(''), source = ref(''), license = ref(''), importName = ref('');
const action = ref(''), expression = ref(''), angle = ref(0), parameterId = ref(''), parameterValue = ref(0), duration = ref(6);
const configuration = reactive<PetConfiguration>({ visible: false, surface: 'app', scale: 1, reducedMotion: false, stopped: false, taskAnimations: true, mappings: {} });
const leaveDestination = ref<'close' | 'screenSense'>('close');
let savedDraft = '';
const dirty = computed(() => !!savedDraft && (JSON.stringify(configuration) !== savedDraft || selected.value !== (configuration.resourceId ?? resources.value[0]?.id ?? '') || pendingFiles.value.length > 0));
const resource = computed(() => resources.value.find(item => item.id === selected.value));
const manifests = computed(() => pendingFiles.value.filter(file => /(?:^|\/)pet\.json$|\.model3\.json$/i.test(selectedPath(file))));
const selectedParameter = computed(() => parameters.value.find(parameter => parameter.id === parameterId.value));
const previewConfiguration = computed(() => ({ ...configuration, stopped: false }));
const formatBytes = (value: number) => `${(value / 1024 / 1024).toFixed(2)} MiB`;
async function perform(work: () => Promise<void>) { if (busy.value) return; busy.value = true; error.value = ''; notice.value = ''; try { await work(); } catch (cause) { error.value = (cause as Error).message; } finally { busy.value = false; } }
async function reload() {
  const dirty = !!savedDraft && JSON.stringify(configuration) !== savedDraft; const prior = snapshot.value;
  [resources.value, snapshot.value] = await Promise.all([call('pets.list'), call('pets.status')]);
  if (!dirty) { Object.assign(configuration, snapshot.value!.configuration); savedDraft = JSON.stringify(configuration); } else if (prior) snapshot.value!.revision = prior.revision;
  if (!resources.value.some(item => item.id === selected.value)) selected.value = configuration.resourceId ?? resources.value[0]?.id ?? '';
}
function chooseFiles(event: Event) {
  pendingFiles.value = [...((event.target as HTMLInputElement).files ?? [])]; entry.value = '';
  if (manifests.value.length === 1) entry.value = selectedPath(manifests.value[0]!);
  if (!manifests.value.length) error.value = '所选文件中没有 pet.json 或 model3.json 清单。';
  (event.target as HTMLInputElement).value = '';
}
async function importResource() {
  const bundle = await collectPetImport(pendingFiles.value, entry.value);
  const result = await call<PetResource>('pets.import', { ...bundle, name: importName.value, source: source.value, license: license.value });
  pendingFiles.value = []; entry.value = ''; selected.value = result.id; await reload(); notice.value = '已导入，可在预览确认后选择显示。';
}
async function importRuntime(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]; (event.target as HTMLInputElement).value = ''; if (!file) return;
  await perform(async () => { await call('pets.runtime.import', { name: file.name, data: await fileBase64(file) }); await reload(); previewKey.value++; notice.value = '本地运行库已导入。'; });
}
async function save() {
  if (!snapshot.value || !resource.value) return;
  await call('pets.configure', { revision: snapshot.value.revision, configuration: { ...configuration, resourceId: resource.value.id, mappings: configuration.resourceId === resource.value.id ? configuration.mappings : {} } });
  savedDraft = ''; await reload(); notice.value = '桌宠显示设置已保存。';
}
async function remove() { await call('pets.remove', { id: selected.value, revision: snapshot.value?.revision }); selected.value = ''; confirmingRemove.value = false; await reload(); }
async function preview(command: PetCommandInput) {
  if (command.action !== 'cancel' && (!Number.isFinite(duration.value) || duration.value < 0.1 || duration.value > 120)) throw new Error('持续时间请填写 0.1 至 120 秒。');
  if (command.action === 'parameters') {
    const parameter = selectedParameter.value;
    if (!parameter || !Number.isFinite(parameterValue.value) || parameterValue.value < parameter.min || parameterValue.value > parameter.max) throw new Error(`参数值需要在 ${parameter?.min} 至 ${parameter?.max} 之间。`);
  }
  await player.value?.apply({ ...command, durationMs: duration.value * 1000 }); notice.value = '预览已应用。';
}
function leave() { emit('close'); if (leaveDestination.value === 'screenSense') emit('screenSense'); }
function close(destination: 'close' | 'screenSense' = 'close') {
  if (busy.value) return; leaveDestination.value = destination;
  if (dirty.value) confirmLeave.value = true; else leave();
}
watch(selected, () => { parameters.value = []; previewReady.value = false; previewKey.value++; confirmingRemove.value = false; action.value = ''; expression.value = ''; parameterId.value = ''; });
watch(parameterId, () => { parameterValue.value = selectedParameter.value?.default ?? 0; });
watch(() => configuration.reducedMotion, () => { if (previewReady.value) void player.value?.apply({ action: 'cancel' }).catch(cause => { error.value = cause.message; }); });
onMounted(() => { dialog.value?.showModal(); void perform(reload); });
</script>
<template>
  <dialog ref="dialog" class="pet-manager" aria-labelledby="pet-title" @cancel.prevent="close()">
    <header><div><h2 id="pet-title">桌宠与 Live2D</h2><p>导入本地资源，预览动作，再选择显示位置。</p></div><button :disabled="busy" @click="close()">关闭</button></header>
    <p v-if="error" class="error" role="alert">{{ error }}</p><p v-if="notice" class="notice" role="status">{{ notice }}</p>
    <div class="pet-columns"><aside>
      <button :disabled="busy" @click="close('screenSense')">屏幕感知设置</button><p>独立开启屏幕采集与交流。</p>
      <div class="import-buttons"><label>选择资源目录<input type="file" webkitdirectory multiple :disabled="busy" @change="chooseFiles"></label><label>选择多个文件<input type="file" multiple :disabled="busy" @change="chooseFiles"></label></div>
      <form v-if="pendingFiles.length" class="import-form" @submit.prevent="perform(importResource)"><label>资源清单<select v-model="entry"><option value="">请选择</option><option v-for="file in manifests" :key="selectedPath(file)" :value="selectedPath(file)">{{ selectedPath(file) }}</option></select></label><label>显示名称（可选）<input v-model="importName"></label><label>来源（可选）<input v-model="source" placeholder="作者、来源页面或本地来源"></label><label>使用许可（可选）<textarea v-model="license" rows="2" placeholder="保留素材的许可说明" /></label><button :disabled="busy || !entry">校验并导入</button><button type="button" @click="pendingFiles = []">取消导入</button></form>
      <button v-for="item in resources" :key="item.id" class="pet-row" :aria-pressed="selected === item.id" @click="selected = item.id"><strong>{{ item.name }}</strong><span>{{ item.kind === 'sprite' ? `精灵图 · v${item.sprite?.version}` : 'Live2D · Cubism 3 格式' }}<b v-if="configuration.resourceId === item.id">当前选择</b></span></button>
      <p v-if="!resources.length && !busy">尚未导入桌宠。支持 Codex v1/v2 图集，以及包含全部引用文件的 model3.json 模型目录。</p>
      <details class="runtime"><summary>Live2D 本地运行库</summary><p>从官方 Cubism SDK 的 Core 目录选择文件。运行库只保存在本机应用数据中；公开程序包不附带 Core。</p><details><summary>播放器与框架许可</summary><pre>{{ playerNotices }}</pre></details><a href="https://www.live2d.com/en/sdk/download/web/" target="_blank" rel="noreferrer">官方 SDK 与使用条款</a><p>{{ snapshot?.runtime ? `${snapshot.runtime.name} · ${formatBytes(snapshot.runtime.bytes)}` : '尚未导入' }}</p><label class="file-button">导入运行库<input type="file" accept=".js" :disabled="busy" @change="importRuntime"></label><button v-if="snapshot?.runtime" :disabled="busy" @click="perform(async () => { await call('pets.runtime.remove'); await reload(); previewKey++; })">移除运行库</button></details>
    </aside><main v-if="resource">
      <div class="settings-guide"><strong>先预览，再应用</strong><p>动作、表情和模型参数只影响此处预览；“保存并应用”保存下方的显示设置。Live2D 需要完整模型目录和本地 Cubism Core 运行库。</p></div>
      <div class="pet-heading"><div><h3>{{ resource.name }}</h3><p>{{ resource.description || `${resource.files.length} 个文件 · ${formatBytes(resource.files.reduce((sum, file) => sum + file.bytes, 0))}` }}</p></div><button @click="confirmingRemove = true">移除资源</button></div>
      <div class="preview-layout"><div class="pet-preview"><PetPlayer :key="`${selected}/${previewKey}`" ref="player" :resource="resource" :configuration="previewConfiguration" @ready="value => { parameters = value; previewReady = true; }" @failed="value => { error = value; }" /></div><section class="preview-controls"><h4>动作预览</h4><label>动作<select v-model="action"><option value="">请选择实际动作</option><option v-for="item in resource.actions" :key="item.id" :value="item.id">{{ item.name }}</option></select></label><button :disabled="!previewReady || !action || busy" @click="perform(() => preview({ action: 'play', id: action }))">播放动作</button><template v-if="resource.expressions.length"><label>表情<select v-model="expression"><option value="">请选择</option><option v-for="item in resource.expressions" :key="item.id" :value="item.id">{{ item.name }}</option></select></label><button :disabled="!previewReady || !expression || busy" @click="perform(() => preview({ action: 'expression', id: expression }))">应用表情</button></template><label>持续时间（秒）<input v-model.number="duration" type="number" min="0.1" max="120" step="0.1" aria-label="预览持续时间"><small class="settings-help">0.1～120 秒，控制本次预览多久后恢复正面，不改变动作播放速度。查看表情可用 2～6 秒，检查长动作可适当延长。</small></label><button :disabled="!previewReady" @click="perform(() => preview({ action: 'cancel' }))">停止并恢复正面</button><p>预览不改变正在显示的桌宠。</p></section></div>
      <details><summary>视线与模型参数</summary><div class="control-grid"><label>观察方向（0° 向上，90° 向右）<input v-model.number="angle" type="range" min="0" max="337.5" step="22.5"><span>{{ angle }}°</span><small class="settings-help">每格 22.5°，共 16 个方向。180° 向下、270° 向左；v1 精灵图不支持定向视线。模型的实际转动幅度取决于素材。</small><button :disabled="!previewReady || resource.sprite?.version === 1" @click="perform(() => preview({ action: 'look', angle }))">应用视线</button></label><label v-if="parameters.length">模型参数<select v-model="parameterId"><option value="">请选择</option><option v-for="item in parameters" :key="item.id" :value="item.id">{{ item.name || item.id }}（{{ item.min }} ～ {{ item.max }}）</option></select><input v-if="selectedParameter" v-model.number="parameterValue" type="number" :min="selectedParameter.min" :max="selectedParameter.max" step="any" aria-label="模型参数值"><small v-if="selectedParameter" class="settings-help">此模型的默认值为 {{ selectedParameter.default }}，范围为 {{ selectedParameter.min }}～{{ selectedParameter.max }}。接近端点通常表示更强的形变；不同模型含义不同，可从默认值附近小幅调整。</small><button :disabled="!parameterId || busy || !previewReady" @click="perform(() => preview({ action: 'parameters', parameters: { [parameterId]: parameterValue } }))">应用参数</button></label></div></details>
      <fieldset><legend>显示设置</legend><div class="control-grid"><label>显示位置<select v-model="configuration.surface"><option value="app">应用内</option><option value="floating" :disabled="!snapshot?.floatingAvailable">桌面悬浮</option></select></label><label>缩放 · {{ configuration.scale.toFixed(1) }} 倍<input v-model.number="configuration.scale" type="range" min="0.4" max="3" step="0.1" aria-label="桌宠缩放"><small class="settings-help">1 倍为基础尺寸。0.4～0.8 倍适合节省空间；1.5～3 倍便于看清细节，但占用更多画面，Live2D 绘制负担也可能增加。</small></label></div><label class="check"><input v-model="configuration.visible" type="checkbox">显示所选桌宠</label><label class="check"><input v-model="configuration.reducedMotion" type="checkbox">减少动态效果，只显示姿势</label><p class="settings-help">适合不希望持续动画或需要节省资源时使用。动作会停在姿势画面；关闭此项后才会连续播放。</p><label class="check"><input v-model="configuration.stopped" type="checkbox">停止全部动作，直到我手动恢复</label><label class="check"><input v-model="configuration.taskAnimations" type="checkbox">根据实际任务状态显示动画</label><p class="settings-help">Live2D 的动作名称来自模型。先保存所选模型，再为待机、运行、等待、审查和失败指定动作；未指定时不会为该状态发起新动作，已有动作可能持续到结束。</p><div v-if="resource.kind === 'live2d' && configuration.resourceId === resource.id" class="control-grid"><label v-for="state in petAnimations.filter(item => ['idle','running','waiting','review','failed'].includes(item.id))" :key="state.id">{{ state.name }}<select :value="configuration.mappings[state.id] ?? ''" @change="event => { const id = (event.target as HTMLSelectElement).value; if (id) configuration.mappings[state.id] = id; else delete configuration.mappings[state.id]; }"><option value="">不指定动作</option><option v-for="item in resource.actions" :key="item.id" :value="item.id">{{ item.name }}</option></select></label></div><button class="primary" :disabled="busy" @click="perform(save)">保存并应用此桌宠</button><button :disabled="busy" @click="perform(async () => { savedDraft = ''; await reload(); selected = configuration.resourceId ?? resources[0]?.id ?? ''; notice = '已重新读取保存的显示设置。'; })">放弃更改并读取已保存设置</button><p>手动操作优先于模型表达，模型表达优先于任务动画。隐藏或停止桌宠不取消后台任务。</p></fieldset>
      <details><summary>来源、许可与文件</summary><p>{{ resource.source || '未填写来源' }}</p><pre>{{ resource.license || '未填写素材许可' }}</pre><p v-for="file in resource.files" :key="file.path">{{ file.path }} · {{ formatBytes(file.bytes) }}</p></details>
      <section v-if="confirmingRemove" class="confirm" role="alert"><p>移除“{{ resource.name }}”？正在使用的桌宠会同时隐藏，原始导入目录不会改变。</p><button @click="confirmingRemove = false">保留</button><button @click="perform(remove)">移除</button></section>
    </main><main v-else class="empty"><h3>让陪伴有一个看得见的形象。</h3><p>先选择资源目录。导入后可以逐项查看动作、透明图集和模型参数。</p></main></div>
    <footer v-if="confirmLeave" class="confirm" role="alert"><p>还有未保存的显示设置或待导入文件。</p><button @click="confirmLeave = false">继续编辑</button><button @click="leave">放弃更改并继续</button></footer>
  </dialog>
</template>
<style scoped>
.pet-manager{width:min(1080px,calc(100vw - 28px));height:min(820px,calc(100dvh - 40px));padding:0;margin:auto;border:1px solid var(--border);border-radius:0;background:var(--background);color:var(--text);box-sizing:border-box;overflow:hidden}.pet-manager[open]{display:flex;flex-direction:column}.pet-manager::backdrop{background:#0009}header,.pet-heading{display:flex;justify-content:space-between;align-items:center;gap:18px}header{padding:16px 20px;border-bottom:1px solid var(--border)}h2,h3,h4{margin:0;font-weight:600}h2{font-size:18px}h3{font-size:17px}h4{font-size:14px}p,pre{font-size:12px;line-height:1.7;color:var(--muted)}p{font-size:12px;line-height:1.7}header p{margin:5px 0 0}button,input,textarea,select,.file-button,.import-buttons label{border:1px solid var(--border);border-radius:0;background:var(--surface);color:var(--text);font:inherit;padding:7px 9px;min-width:0;box-sizing:border-box}button,.file-button,.import-buttons label,summary{cursor:pointer}button:disabled{opacity:.5;cursor:default}input[type=checkbox]{margin:0}input[type=range]{padding:0}label{display:flex;flex-direction:column;gap:7px;font-size:12px;margin:12px 0}a{color:var(--accent);font-size:12px}.pet-columns{display:grid;grid-template-columns:280px minmax(0,1fr);min-height:0;flex:1}.pet-columns>aside,.pet-columns>main{overflow:auto;padding:20px}.pet-columns>aside{border-right:1px solid var(--border)}.import-buttons{display:flex;flex-wrap:wrap;gap:8px}.import-buttons label{margin:0}.import-buttons input,.file-button input{display:none}.import-form{border-block:1px solid var(--border);padding:8px 0 16px;margin:16px 0}.pet-row{display:flex;flex-direction:column;width:100%;text-align:left;gap:7px;margin:12px 0}.pet-row[aria-pressed=true]{border-left:3px solid var(--accent)}.pet-row span{font-size:11px;color:var(--muted)}.pet-row b{display:block;font-weight:400;color:var(--accent);margin-top:5px}.runtime{margin-top:26px}.file-button{display:inline-flex}.preview-layout{display:grid;grid-template-columns:minmax(180px,1fr) 210px;gap:22px;margin:18px 0}.pet-preview{height:320px;border:1px solid var(--border);background:repeating-conic-gradient(#78839412 0% 25%,transparent 0% 50%) 0 0/28px 28px}.preview-controls button{font-size:12px}.control-grid{display:grid;grid-template-columns:1fr 1fr;gap:0 18px;min-width:0}.check{flex-direction:row;align-items:center}.pet-manager details{margin:16px 0;padding-top:12px;border-top:1px solid var(--border)}fieldset{margin:24px 0;border:1px solid var(--border);padding:14px 18px}legend{padding:0 6px;font-size:13px}.primary{background:var(--accent);color:#10141b;margin-top:12px}pre{white-space:pre-wrap;overflow-wrap:anywhere}.error,.notice{margin:10px 20px 0}.error{color:#e8a2a2}.confirm{padding:14px 20px;background:var(--panel);border-top:1px solid var(--border)}.confirm button+button{margin-left:10px}.empty{display:flex;flex-direction:column;justify-content:center}.empty h3{font-size:22px;font-weight:400}@media(max-width:700px){.pet-manager{width:calc(100vw - 12px);height:calc(100dvh - 20px)}header{padding:12px}.pet-columns{grid-template-columns:1fr;overflow:auto;display:block}.pet-columns>aside{border-right:0;border-bottom:1px solid var(--border)}.pet-columns>aside,.pet-columns>main{overflow:visible;padding:14px}.preview-layout{grid-template-columns:1fr}.pet-preview{height:280px}.control-grid{grid-template-columns:1fr}.pet-heading{align-items:flex-start}.pet-row{margin:8px 0}}
</style>
