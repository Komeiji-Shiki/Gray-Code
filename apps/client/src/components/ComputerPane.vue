<script setup lang="ts">
import { computed, ref, watch, onUnmounted } from 'vue';
import type { ComputerAction, ComputerElement, ComputerObservation, ComputerOperation, ComputerWindows } from '@graycode/contracts';
import { call, subscribe } from '../api';
import { computerState, refreshComputerStatus } from '../computer';
import './computerPane.css';

const props = defineProps<{ visible: boolean }>();
const controlLabels:Record<string,string>={Window:'窗口',Text:'文本',Document:'正文',Edit:'输入框',Button:'按钮',Pane:'区域',ScrollBar:'滚动条',CheckBox:'复选框',RadioButton:'单选项',ComboBox:'下拉框',List:'列表',ListItem:'列表项',Menu:'菜单',MenuItem:'菜单项',Tab:'标签组',TabItem:'标签页',Tree:'树形列表',TreeItem:'树形项目',Slider:'滑块',ToolBar:'工具栏',Group:'分组',Custom:'自定义'};
const actionLabels:Record<string,string>={focusWindow:'切换窗口',focusElement:'聚焦控件',invoke:'点击控件',setValue:'填写内容',select:'选中',toggle:'切换状态',expand:'展开',collapse:'收起',click:'点击',type:'输入文字',key:'发送按键',scroll:'滚动',drag:'拖动'};
const resultLabels:Record<string,string>={dispatching:'已派发',completed:'已完成',failed:'失败',unknown:'结果待核实'};
const inventory = ref<ComputerWindows>();
const selectedWindow = ref('');
const observation = ref<ComputerObservation>();
const selectedElement = ref('');
const filter = ref('');
const text = ref('');
const key = ref('Control+A');
const error = ref('');
const notice = ref('');
const busy = ref(false);
const screenshotEnabled = ref(false);
const history = ref<ComputerOperation[]>([]);
const tab = ref<'observe' | 'history'>('observe');
const pointerMode = ref<'inspect' | 'click' | 'drag'>('inspect');
const dragStart = ref<{x:number;y:number}>();
let epoch = 0;
const windows = computed(() => inventory.value?.windows.filter(value => !filter.value || `${value.title} ${value.executable}`.toLocaleLowerCase().includes(filter.value.toLocaleLowerCase())) ?? []);
const element = computed(() => observation.value?.elements.find(value => value.id === selectedElement.value));
const elements = computed(() => observation.value?.elements.filter(value => !value.offscreen) ?? []);
const status = computed(() => computerState.status);
const patternActions = computed(() => {
  const patterns = element.value?.patterns ?? [];
  return ([['Invoke','invoke','点击控件'],['Value','setValue','填写内容'],['SelectionItem','select','选中'],['Toggle','toggle','切换'],['ExpandCollapse','expand','展开'],['ExpandCollapse','collapse','收起']] as const)
    .filter(([pattern]) => patterns.includes(pattern));
});
async function perform(action: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true; error.value = ''; notice.value = '';
  try { await action(); } catch (cause) { error.value = (cause as Error).message; }
  finally { busy.value = false; await refreshComputerStatus(); }
}
async function readWindows() {
  const value = await call<ComputerWindows>('computer.windows'); inventory.value = value;
  if (selectedWindow.value && !value.windows.some(item => item.id === selectedWindow.value)) { selectedWindow.value = ''; observation.value = undefined; selectedElement.value = ''; }
}
async function observe() {
  if (!selectedWindow.value) return;
  const current = ++epoch;
  const value = await call<ComputerObservation>('computer.observe', { windowId: selectedWindow.value, screenshot: screenshotEnabled.value });
  if (current !== epoch) return;
  observation.value = value; selectedElement.value = ''; pointerMode.value = 'inspect';
}
async function chooseWindow(id: string) { selectedWindow.value = id; observation.value = undefined; selectedElement.value = ''; await observe(); }
async function action(args: Omit<ComputerAction,'observationId'>) {
  const current = observation.value; if (!current) throw new Error('请先观察窗口。');
  await call('computer.acquire', { windowIds: [current.window.id] });
  try { await call('computer.action', { ...args, observationId: current.id, operationId: crypto.randomUUID() }); notice.value = '操作已执行。下面显示重新观察的结果。'; }
  finally { await call('computer.release'); observation.value = undefined; selectedElement.value = ''; }
  await observe();
}
function chooseElement(value: ComputerElement) { selectedElement.value = value.id; }
function point(event: PointerEvent) {
  const rect = (event.currentTarget as HTMLImageElement).getBoundingClientRect(), image = observation.value!.screenshot!;
  return { x: Math.max(0,Math.min(image.width-1,Math.floor((event.clientX-rect.x)*image.width/rect.width))), y: Math.max(0,Math.min(image.height-1,Math.floor((event.clientY-rect.y)*image.height/rect.height))) };
}
function pointerDown(event: PointerEvent) {
  if (pointerMode.value !== 'drag' || busy.value) return;
  dragStart.value = point(event); (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
}
function pointerUp(event: PointerEvent) {
  if (busy.value || pointerMode.value === 'inspect') return;
  const end = point(event), start = dragStart.value; dragStart.value = undefined;
  if (pointerMode.value === 'drag' && start) void perform(() => action({ action:'drag',coordinateSpace:'image',...start,toX:end.x,toY:end.y }));
  else if (pointerMode.value === 'click') void perform(() => action({ action:'click',coordinateSpace:'image',...end }));
}
async function loadHistory() { tab.value='history';history.value=await call<ComputerOperation[]>('computer.recent'); }
watch(() => props.visible, visible => { if (visible && !inventory.value) void perform(readWindows); }, { immediate: true });
const unsubscribe = subscribe(event => {
  if (event.type === 'computer.changed' && props.visible) void refreshComputerStatus();
});
onUnmounted(() => { epoch++;unsubscribe();void call('computer.release').catch(()=>{}); });
</script>
<template>
  <section class="computer-pane" aria-label="电脑控制">
    <header class="computer-toolbar"><strong>本机电脑</strong><span>{{ status?.active ? '控制中' : '未取得控制权' }}</span><button :disabled="busy" @click="perform(readWindows)">刷新窗口</button><button v-if="status?.active" class="computer-stop" @click="call('computer.stop').catch(cause => error = cause.message)">立即停止</button></header>
    <p v-if="status?.error" class="computer-error">{{ status.error }}</p>
    <p v-if="error" class="computer-error" role="alert">{{ error }}</p><p v-if="notice" class="computer-notice" role="status">{{ notice }}</p>
    <div v-if="status?.pausedRunId" class="computer-paused"><span>主人已接管。任务不会自动恢复电脑操作。</span><button @click="perform(async()=>{await call('computer.allowRun',{runId:status?.pausedRunId});})">允许该任务继续</button></div>
    <nav class="computer-tabs"><button :aria-pressed="tab==='observe'" @click="tab='observe'">窗口与控件</button><button :disabled="busy" :aria-pressed="tab==='history'" @click="perform(loadHistory)">本次启动的操作</button></nav>
    <div v-if="tab==='history'" class="computer-history"><p v-if="!history.length">还没有电脑操作记录。</p><article v-for="entry in history" :key="entry.id"><strong>{{ actionLabels[entry.action] || entry.action }} · {{ entry.window.title }}</strong><span>{{ resultLabels[entry.status] || entry.status }} · {{ new Date(entry.requestedAt).toLocaleString() }}</span><code>PID {{ entry.window.processId }} · {{ entry.window.executable }}</code><p v-if="entry.error">{{ entry.error }}</p></article></div>
    <div v-else class="computer-body">
      <aside class="computer-window-list"><input v-model="filter" type="search" placeholder="查找应用或窗口" aria-label="查找窗口"><p v-if="!inventory">刷新后选择需要查看的窗口。</p><button v-for="item in windows" :key="item.id" :disabled="busy" :aria-pressed="selectedWindow===item.id" @click="perform(()=>chooseWindow(item.id))"><strong>{{ item.title }}</strong><small>PID {{ item.processId }} · {{ item.dpi }} DPI{{ item.minimized ? ' · 已最小化' : '' }}</small></button><div class="computer-displays"><div v-for="display in inventory?.displays" :key="display.id">{{ display.id }} · {{ display.bounds.width }} × {{ display.bounds.height }} · {{ Math.round(display.scaleFactor*100) }}%</div></div></aside>
      <div class="computer-observation">
        <div class="computer-observe-toolbar"><label><input v-model="screenshotEnabled" type="checkbox" :disabled="!status?.screenshotAvailable || busy">附带窗口截图</label><button :disabled="busy || !selectedWindow" @click="perform(observe)">重新观察</button><button :disabled="busy || !observation" @click="perform(()=>action({action:'focusWindow'}))">切换到窗口</button></div>
        <template v-if="observation">
          <details class="computer-identity"><summary>{{ observation.window.title }} · {{ new Date(observation.capturedAt).toLocaleTimeString() }}</summary><dl><dt>进程</dt><dd>{{ observation.window.processId }} · {{ observation.window.executable || '路径不可读' }}</dd><dt>启动时间</dt><dd>{{ observation.window.processStartedAt || '不可读' }}</dd><dt>启动命令</dt><dd>{{ observation.window.commandLine || '不可读' }}</dd><dt>窗口位置</dt><dd>{{ observation.window.bounds.x }}, {{ observation.window.bounds.y }} · {{ observation.window.bounds.width }} × {{ observation.window.bounds.height }} · {{ observation.window.dpi }} DPI</dd></dl></details>
          <p v-if="observation.accessibilityError" class="computer-error">{{ observation.accessibilityError }}</p>
          <div v-if="observation.screenshot" class="computer-picture"><div><span>{{ observation.screenshot.width }} × {{ observation.screenshot.height }} 像素</span><select v-model="pointerMode" :disabled="busy" aria-label="截图操作"><option value="inspect">仅查看</option><option value="click">点击图中位置</option><option value="drag">在图中拖动</option></select></div><img :src="'data:image/png;base64,'+observation.screenshot.data" alt="所选窗口的当前截图" draggable="false" :class="{interactive:pointerMode!=='inspect'}" @pointerdown="pointerDown" @pointerup="pointerUp" @pointercancel="dragStart=undefined"></div>
          <div class="computer-elements" role="list" aria-label="可见控件"><button v-for="item in elements" :key="item.id" role="listitem" :aria-pressed="selectedElement===item.id" :disabled="busy" @click="chooseElement(item)"><small :title="item.type">{{ controlLabels[item.type] || item.type }}</small><span>{{ item.name || item.automationId || '未命名控件' }}</span><small v-if="item.focused">焦点</small><span v-if="item.value" class="computer-value">{{ item.value }}</span></button></div><p v-if="observation.truncated" class="computer-hint">控件列表已截断，当前焦点仍单独保留。可缩小窗口内的展开范围后重新观察。</p>
          <div class="computer-input"><p>{{ element ? `已选择：${element.name || element.type}` : '选择控件，或使用已核实的焦点输入文字。' }}</p><textarea v-model="text" placeholder="要输入的文字" aria-label="电脑输入文字" :disabled="busy"></textarea><div><button v-for="[,type,label] in patternActions" :key="type" :disabled="busy || element?.password" @click="perform(()=>action({action:type,elementId:selectedElement,text}))">{{ label }}</button><button :disabled="busy || !element || element.password" @click="perform(()=>action({action:'focusElement',elementId:selectedElement}))">聚焦控件</button><button :disabled="busy || !text || (!element && !observation.focusedElementId)" @click="perform(()=>action({action:'type',text,elementId:selectedElement || undefined}))">输入到当前焦点</button></div><div><input v-model="key" aria-label="按键组合" placeholder="Control+A"><button :disabled="busy || !key" @click="perform(()=>action({action:'key',key,elementId:selectedElement || undefined}))">发送按键</button><button :disabled="busy || !element" @click="perform(()=>action({action:'scroll',elementId:selectedElement,scrollY:3}))">向下滚动</button><button :disabled="busy || !element" @click="perform(()=>action({action:'scroll',elementId:selectedElement,scrollY:-3}))">向上滚动</button></div></div>
        </template><p v-else class="computer-hint">从左侧选择实际窗口。每次操作后重新读取控件和画面；查看截图不会发送给模型。</p>
      </div>
    </div>
  </section>
</template>
