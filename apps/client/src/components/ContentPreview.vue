<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { call, subscribe } from '../api';
import { report, state } from '../state';
interface PreviewGroupItem { id: string; title: string; mimeType?: string }
interface Preview {
  id: string; title: string; content?: string; language?: string; data?: string; mimeType?: string;
  group?: { index: number; items: PreviewGroupItem[] };
}
const value = ref<Preview>();
const dialog = ref<HTMLElement>();
const stage = ref<HTMLElement>();
const url = ref('');
let previousFocus: HTMLElement | null = null;
function currentFocus(): HTMLElement | null {
  let element = document.activeElement as HTMLElement | null;
  // 聊天在同源 iframe 中，保存真正的附件按钮，不能只保存外层 iframe。
  while (element?.tagName === 'IFRAME') {
    const nested = (element as HTMLIFrameElement).contentDocument?.activeElement as HTMLElement | null;
    if (!nested) break;
    element = nested;
  }
  return element;
}

// ========== 图片查看状态（缩放 / 平移 / 旋转，仅图片预览使用） ==========
const rotation = ref(0);
/** 相对"适应窗口"的缩放倍率；1 表示适应窗口。 */
const zoom = ref(1);
const pan = ref({ x: 0, y: 0 });
const fitScale = ref(1);
const naturalSize = ref<{ width: number; height: number }>();
const dragging = ref(false);
let dragState: { pointerId: number; startX: number; startY: number; panX: number; panY: number } | null = null;

const isImage = computed(() => value.value?.mimeType?.startsWith('image/') ?? false);
const group = computed(() => value.value?.group);
const groupItems = computed(() => group.value?.items ?? []);
const groupIndex = computed(() => group.value?.index ?? 0);
const hasPrevious = computed(() => !!group.value && groupIndex.value > 0);
const hasNext = computed(() => !!group.value && groupIndex.value < groupItems.value.length - 1);
const zoomPercent = computed(() => `${Math.round(fitScale.value * zoom.value * 100)}%`);
const imageStyle = computed(() => ({
  transform: `translate(${pan.value.x}px, ${pan.value.y}px) scale(${fitScale.value * zoom.value}) rotate(${rotation.value}deg)`,
}));

// ========== 预览加载与多图切换 ==========
/** 组内图片数据缓存：preview id → ObjectURL，切回看过的图片不重复请求核心。 */
const urls = new Map<string, string>();
let generation = 0;

function releaseUrls() {
  for (const cached of urls.values()) URL.revokeObjectURL(cached);
  urls.clear();
}

function createUrl(data: string, mimeType?: string) {
  const bytes = Uint8Array.from(atob(data), character => character.charCodeAt(0));
  return URL.createObjectURL(new Blob([bytes], { type: mimeType ?? 'application/octet-stream' }));
}

/** 关闭预览资源：组内图片一次全部关闭；无组时关闭自身。 */
function closePreviews(target?: Preview) {
  if (!target) return;
  const ids = target.group?.items.map(item => item.id) ?? [target.id];
  for (const id of ids) void call('ui.request', { type: 'preview.close', data: { id } }).catch(() => {});
}

function resetImageState() {
  rotation.value = 0; zoom.value = 1; pan.value = { x: 0, y: 0 };
  naturalSize.value = undefined; fitScale.value = 1;
  dragState = null; dragging.value = false;
}

/** 舞台与当前图片（含旋转）的尺寸信息；图片未加载完成时返回 null。 */
function fitSize() {
  const rect = stage.value?.getBoundingClientRect();
  if (!rect || !naturalSize.value) return null;
  const rotated = rotation.value % 180 !== 0;
  const width = rotated ? naturalSize.value.height : naturalSize.value.width;
  const height = rotated ? naturalSize.value.width : naturalSize.value.height;
  return { rect, width, height };
}

function updateFit() {
  const size = fitSize();
  if (!size || size.width <= 0 || size.height <= 0) return;
  fitScale.value = Math.min(size.rect.width / size.width, size.rect.height / size.height);
}

/** 平移限制在图片边缘之内：图片小于舞台时保持居中，放大后可拖到任意角落。 */
function clampPan() {
  const size = fitSize();
  if (!size) return;
  const displayWidth = size.width * fitScale.value * zoom.value;
  const displayHeight = size.height * fitScale.value * zoom.value;
  const limitX = Math.max(0, (displayWidth - size.rect.width) / 2);
  const limitY = Math.max(0, (displayHeight - size.rect.height) / 2);
  pan.value = {
    x: Math.min(limitX, Math.max(-limitX, pan.value.x)),
    y: Math.min(limitY, Math.max(-limitY, pan.value.y)),
  };
}

/** 以锚点（默认舞台中心）缩放：锚点下的图片内容保持不动。 */
function applyZoom(next: number, clientX?: number, clientY?: number) {
  const size = fitSize();
  if (!size) return;
  const maxZoom = Math.max(8, 2 / fitScale.value);
  const clamped = Math.min(maxZoom, Math.max(0.1, next));
  const k = clamped / zoom.value;
  const anchorX = clientX === undefined ? size.rect.width / 2 : clientX - size.rect.left;
  const anchorY = clientY === undefined ? size.rect.height / 2 : clientY - size.rect.top;
  pan.value = {
    x: k * pan.value.x + (1 - k) * (anchorX - size.rect.width / 2),
    y: k * pan.value.y + (1 - k) * (anchorY - size.rect.height / 2),
  };
  zoom.value = clamped;
  clampPan();
}

function zoomBy(factor: number) { applyZoom(zoom.value * factor); }

function fitToWindow() {
  zoom.value = 1; pan.value = { x: 0, y: 0 };
  updateFit();
}

function rotate(delta: number) {
  rotation.value = (rotation.value + delta + 360) % 360;
  zoom.value = 1; pan.value = { x: 0, y: 0 };
  updateFit();
}

function onDoubleClick(event: MouseEvent) {
  if (!naturalSize.value) return;
  // 双击在 100% 原始尺寸与适应窗口之间切换。
  if (Math.abs(fitScale.value * zoom.value - 1) < 0.02) { fitToWindow(); return; }
  applyZoom(1 / fitScale.value, event.clientX, event.clientY);
}

function onWheel(event: WheelEvent) {
  if (!naturalSize.value) return;
  applyZoom(zoom.value * Math.exp(-event.deltaY * 0.0015), event.clientX, event.clientY);
}

function onImageLoad(event: Event) {
  const image = event.target as HTMLImageElement;
  if (!image.naturalWidth || !image.naturalHeight) return;
  naturalSize.value = { width: image.naturalWidth, height: image.naturalHeight };
  updateFit();
  clampPan();
}

function onPointerDown(event: PointerEvent) {
  if (!naturalSize.value || event.button !== 0) return;
  dragState = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, panX: pan.value.x, panY: pan.value.y };
  dragging.value = true;
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
}

function onPointerMove(event: PointerEvent) {
  if (!dragState || event.pointerId !== dragState.pointerId) return;
  pan.value = { x: dragState.panX + (event.clientX - dragState.startX), y: dragState.panY + (event.clientY - dragState.startY) };
  clampPan();
}

function onPointerUp(event: PointerEvent) {
  if (!dragState || event.pointerId !== dragState.pointerId) return;
  dragState = null; dragging.value = false;
}

function step(delta: number) {
  const current = value.value;
  if (!current?.group) return;
  const target = current.group.items[current.group.index + delta];
  if (target) void switchTo(target.id);
}

async function switchTo(id: string) {
  const current = value.value;
  if (!current?.group || current.id === id) return;
  const target = current.group.items.find(item => item.id === id);
  if (!target) return;
  const request = ++generation;
  const cached = urls.get(id);
  if (cached) {
    resetImageState();
    url.value = cached;
    value.value = { id, title: target.title, mimeType: target.mimeType, group: { items: current.group.items, index: current.group.items.indexOf(target) } };
    return;
  }
  try {
    const next = await call<Preview>('ui.request', { type: 'preview.get', data: { id } });
    if (request !== generation) return;
    resetImageState();
    const created = next.data ? createUrl(next.data, next.mimeType) : '';
    if (created) urls.set(next.id, created);
    url.value = created;
    value.value = next;
  } catch (error) {
    if (request === generation) report(error);
  }
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') { event.stopPropagation(); event.preventDefault(); void close(); return; }
  if (event.key === 'Tab') { trapTab(event); return; }
  if (event.key === 'ArrowLeft') { event.preventDefault(); step(-1); return; }
  if (event.key === 'ArrowRight') { event.preventDefault(); step(1); return; }
  if (!isImage.value || !url.value) return;
  if (event.key === '+' || event.key === '=') { event.preventDefault(); zoomBy(1.25); }
  else if (event.key === '-' || event.key === '_') { event.preventDefault(); zoomBy(1 / 1.25); }
  else if (event.key === '0') { event.preventDefault(); fitToWindow(); }
}

function trapTab(event: KeyboardEvent) {
  const controls = [...dialog.value?.querySelectorAll<HTMLElement>('a[href],button:not(:disabled),audio[controls],video[controls],iframe') ?? []];
  const target = event.shiftKey ? controls.at(-1) : controls[0];
  const boundary = event.shiftKey ? controls[0] : controls.at(-1);
  if (target && document.activeElement === boundary) { event.preventDefault(); target.focus(); }
}

watch(value, async next => {
  state.contentPreviewOpen = !!next;
  if (!next) return;
  // 打开时记录来源焦点并聚焦关闭按钮；多图切换不打断当前焦点。
  const opening = !previousFocus;
  previousFocus ??= currentFocus();
  if (!opening) return;
  await nextTick();
  dialog.value?.querySelector<HTMLButtonElement>('.preview-close')?.focus();
});

// 画面尺寸变化后重算适配比例，保持缩放倍率与平移约束。
function onResize() {
  if (!value.value) return;
  updateFit();
  clampPan();
}
onMounted(() => window.addEventListener('resize', onResize));

async function close() {
  generation++;
  const previous = value.value;
  value.value = undefined;
  releaseUrls();
  const returnTo = previousFocus; previousFocus = null;
  await nextTick();
  if (returnTo?.isConnected) returnTo.focus({ preventScroll: true });
  closePreviews(previous);
}

const unsubscribe = subscribe(event => {
  if (event.type !== 'workspace.preview') return;
  const request = ++generation;
  void call<Preview>('ui.request', { type: 'preview.get', data: { id: event.previewId } }).then(next => {
    if (request !== generation) return;
    const previous = value.value;
    if (previous) closePreviews(previous);
    releaseUrls();
    resetImageState();
    const created = next.data ? createUrl(next.data, next.mimeType) : '';
    if (created) urls.set(next.id, created);
    url.value = created;
    value.value = next;
  }).catch(report);
});
onUnmounted(() => { unsubscribe(); window.removeEventListener('resize', onResize); void close(); });
</script>
<template>
  <div v-if="value" class="content-preview-backdrop" @keydown="onKeydown"><section ref="dialog" class="content-preview" role="dialog" aria-modal="true" :aria-label="value.title">
    <header>
      <strong>{{ value.title }}</strong>
      <span v-if="group" class="preview-counter">{{ groupIndex + 1 }} / {{ groupItems.length }}</span>
      <div v-if="isImage && url" class="preview-tools" role="toolbar" aria-label="图片工具">
        <button type="button" title="缩小" aria-label="缩小" @click="zoomBy(1 / 1.25)">−</button>
        <span class="preview-zoom" title="当前缩放比例">{{ zoomPercent }}</span>
        <button type="button" title="放大" aria-label="放大" @click="zoomBy(1.25)">＋</button>
        <button type="button" title="适应窗口（重置缩放与平移）" aria-label="适应窗口" @click="fitToWindow">适应</button>
        <button type="button" title="向左旋转" aria-label="向左旋转" @click="rotate(-90)">↺</button>
        <button type="button" title="向右旋转" aria-label="向右旋转" @click="rotate(90)">↻</button>
      </div>
      <a v-if="url" :href="url" :download="value.title">保存附件</a>
      <button class="preview-close" @click="close">关闭</button>
    </header>
    <div class="content-preview-body">
      <pre v-if="value.content !== undefined"><code>{{ value.content }}</code></pre>
      <template v-else-if="isImage">
        <div ref="stage" class="preview-stage" :class="{ dragging }" @wheel.prevent="onWheel"
          @pointerdown="onPointerDown" @pointermove="onPointerMove" @pointerup="onPointerUp" @pointercancel="onPointerUp">
          <img v-if="url" :src="url" :alt="value.title" :style="imageStyle" :class="{ ready: !!naturalSize }" draggable="false"
            title="双击在 100% 与适应窗口之间切换" @load="onImageLoad" @dblclick="onDoubleClick" />
          <button v-if="hasPrevious" type="button" class="preview-nav previous" aria-label="上一张" title="上一张（←）" @pointerdown.stop @click="step(-1)">‹</button>
          <button v-if="hasNext" type="button" class="preview-nav next" aria-label="下一张" title="下一张（→）" @pointerdown.stop @click="step(1)">›</button>
        </div>
      </template>
      <audio v-else-if="value.mimeType?.startsWith('audio/')" :src="url" controls />
      <video v-else-if="value.mimeType?.startsWith('video/')" :src="url" controls />
      <iframe v-else-if="value.mimeType === 'application/pdf'" :src="url" title="PDF 预览" sandbox=""></iframe>
      <p v-else>此格式可以保存后使用本机应用打开。</p>
    </div>
  </section></div>
</template>
<style scoped>
.content-preview-backdrop{position:fixed;inset:0;z-index:9500;background:#000b;display:grid;place-items:center}.content-preview{width:min(1100px,94vw);height:88vh;background:var(--surface);border:1px solid var(--border);display:flex;flex-direction:column}.content-preview header{display:flex;align-items:center;gap:12px;padding:12px 16px;border-bottom:1px solid var(--border)}header strong{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.preview-counter{flex-shrink:0;color:var(--muted);font-size:12px;font-variant-numeric:tabular-nums}.preview-tools{display:flex;align-items:center;gap:4px;flex-shrink:0}.preview-tools button{min-width:30px;padding:3px 8px;font-size:13px;line-height:1.4}.preview-zoom{flex-shrink:0;min-width:46px;text-align:center;color:var(--muted);font-size:12px;font-variant-numeric:tabular-nums}header a{flex-shrink:0;color:var(--accent);white-space:nowrap}.preview-close{flex-shrink:0;border-radius:0;white-space:nowrap}.content-preview-body{flex:1;min-height:0;overflow:auto;padding:16px;display:flex;align-items:flex-start;justify-content:center}.content-preview-body pre{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;width:100%;font:13px/1.6 var(--code-font,monospace)}.preview-stage{position:relative;flex:1;align-self:stretch;min-width:0;overflow:hidden;cursor:grab;touch-action:none;user-select:none}.preview-stage.dragging{cursor:grabbing}.preview-stage img{position:absolute;inset:0;margin:auto;max-width:none;max-height:none;transform-origin:center;-webkit-user-drag:none;visibility:hidden}.preview-stage img.ready{visibility:visible}.preview-nav{position:absolute;top:50%;z-index:2;width:40px;height:64px;margin-top:-32px;padding:0;display:flex;align-items:center;justify-content:center;font-size:26px;line-height:1;color:#fff;background:#0009;border:0;cursor:pointer}.preview-nav:hover{background:#000c}.preview-nav.previous{left:8px}.preview-nav.next{right:8px}.content-preview-body video{max-width:100%;max-height:100%}.content-preview-body iframe{border:0;width:100%;height:100%;background:white}.content-preview-body audio{width:min(700px,100%)}
</style>
