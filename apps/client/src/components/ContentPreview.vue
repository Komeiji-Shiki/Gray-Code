<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { call, subscribe } from '../api';
import { report, state } from '../state';
import { shellText as t } from '../i18n';
interface PreviewGroupItem { id: string; title: string; mimeType?: string }
interface Preview {
  id: string; title: string; content?: string; language?: string; data?: string; mimeType?: string;
  group?: { index: number; items: PreviewGroupItem[] };
}
const value = ref<Preview>();
const dialog = ref<HTMLElement>();
const stage = ref<HTMLElement>();
const imageElement = ref<HTMLImageElement>();
const imageMenu = ref<{ x: number; y: number }>();
const imageMenuElement = ref<HTMLElement>();
const copyingImage = ref(false);
const imageAction = ref<{ message: string; failed: boolean }>();
let imageCopyRequest = 0;
const url = ref('');
let menuFocus: HTMLElement | null = null;
const copyShortcut = /Mac/i.test(navigator.platform) ? '⌘C' : 'Ctrl+C';
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
  transform: `translate(-50%, -50%) translate(${pan.value.x}px, ${pan.value.y}px) scale(${fitScale.value * zoom.value}) rotate(${rotation.value}deg)`,
}));

// ========== 预览加载与多图切换 ==========
/** 组内图片数据缓存：preview id → ObjectURL，切回看过的图片不重复请求核心。 */
const urls = new Map<string, string>();
let generation = 0;
let requestedPreviewId: string | undefined;

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
  dismissImageMenu(false);
  imageCopyRequest++;
  copyingImage.value = false; imageAction.value = undefined;
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
  if (!size || size.width <= 0 || size.height <= 0 || size.rect.width <= 0 || size.rect.height <= 0) return;
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
  // 适应窗口可能把小图片放大十倍以上；100% 仍需能够回到原始像素尺寸。
  const minZoom = Math.min(0.1, 1 / fitScale.value);
  const clamped = Math.min(maxZoom, Math.max(minZoom, next));
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

function actualSize() { applyZoom(1 / fitScale.value); }

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

function onImageError() {
  naturalSize.value = undefined;
  imageAction.value = { message: t('previewImageLoadFailed'), failed: true };
}

// 剪贴板使用原始像素，查看器的缩放、旋转与平移不改变复制或保存的内容。
function imagePng(image: HTMLImageElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d');
    if (!context) { reject(new Error(t('previewCopyFailed'))); return; }
    try {
      context.drawImage(image, 0, 0);
      canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error(t('previewCopyFailed'))), 'image/png');
    } catch (error) { reject(error); }
  });
}

function pngBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error(t('previewCopyFailed')));
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.readAsDataURL(blob);
  });
}

async function copyImage() {
  const image = imageElement.value;
  if (!image || !naturalSize.value || copyingImage.value) return;
  const request = ++imageCopyRequest;
  copyingImage.value = true; imageAction.value = undefined;
  try {
    const desktop = window.graycode?.kind === 'desktop';
    if (!desktop && (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined'))
      throw new Error(t('previewCopyUnavailable'));
    const png = imagePng(image);
    if (desktop) await call('desktop.clipboard.writeImage', { data: await pngBase64(await png) });
    // 在用户手势内发起写入，把异步编码放入 ClipboardItem，保留浏览器所需的激活状态。
    else await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
    if (request === imageCopyRequest) imageAction.value = { message: t('copied'), failed: false };
  } catch (error) {
    console.warn('图片复制失败：', error);
    if (request === imageCopyRequest) imageAction.value = { message: error instanceof Error && error.message === t('previewCopyUnavailable')
      ? error.message : t('previewCopyFailed'), failed: true };
  } finally {
    if (request === imageCopyRequest) copyingImage.value = false;
  }
}

function dismissImageMenu(restoreFocus = true) {
  if (!imageMenu.value) return;
  imageMenu.value = undefined;
  const target = menuFocus; menuFocus = null;
  if (restoreFocus && target?.isConnected) target.focus({ preventScroll: true });
}

async function showImageMenu(event: MouseEvent) {
  if (!url.value) return;
  menuFocus = imageMenu.value ? menuFocus : currentFocus();
  const rect = stage.value!.getBoundingClientRect();
  imageMenu.value = { x: event.clientX || rect.left + rect.width / 2, y: event.clientY || rect.top + rect.height / 2 };
  const opened = imageMenu.value;
  await nextTick();
  const element = imageMenuElement.value;
  if (imageMenu.value !== opened || !element) return;
  opened.x = Math.max(8, Math.min(opened.x, window.innerWidth - element.offsetWidth - 8));
  opened.y = Math.max(8, Math.min(opened.y, window.innerHeight - element.offsetHeight - 8));
  element.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus();
}

function menuAction(action: () => unknown) { dismissImageMenu(); void action(); }

function onMenuKeydown(event: KeyboardEvent) {
  event.stopPropagation();
  if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); dismissImageMenu(); return; }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c') { event.preventDefault(); menuAction(copyImage); return; }
  if (event.key === ' ' && document.activeElement?.tagName === 'A') {
    event.preventDefault(); (document.activeElement as HTMLAnchorElement).click(); return;
  }
  if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const items = [...imageMenuElement.value?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? []];
  const current = items.indexOf(document.activeElement as HTMLElement);
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
    : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
  items[next]?.focus();
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
  dismissImageMenu();
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
  if (imageMenu.value) { onMenuKeydown(event); return; }
  if (event.key === 'Escape') { event.stopPropagation(); event.preventDefault(); void close(); return; }
  if (event.key === 'Tab') { trapTab(event); return; }
  if (event.key === 'ArrowLeft') { event.preventDefault(); step(-1); return; }
  if (event.key === 'ArrowRight') { event.preventDefault(); step(1); return; }
  if (!isImage.value || !url.value) return;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c' && document.getSelection()?.isCollapsed !== false) {
    event.preventDefault(); void copyImage();
  }
  else if (event.key === '+' || event.key === '=') { event.preventDefault(); zoomBy(1.25); }
  else if (event.key === '-' || event.key === '_') { event.preventDefault(); zoomBy(1 / 1.25); }
  else if (event.key === '0') { event.preventDefault(); fitToWindow(); }
}

function trapTab(event: KeyboardEvent) {
  const controls = [...dialog.value?.querySelectorAll<HTMLElement>('a[href],button:not(:disabled),[tabindex="0"],audio[controls],video[controls],iframe') ?? []];
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

// 操作提示和工具文案会改变头部高度，重新按实际可用空间适配图片。
watch([imageAction, copyingImage], async () => { await nextTick(); updateFit(); clampPan(); });

// 画面尺寸变化后重算适配比例，保持缩放倍率与平移约束。
function onResize() {
  if (!value.value) return;
  dismissImageMenu();
  updateFit();
  clampPan();
}
onMounted(() => window.addEventListener('resize', onResize));

async function close() {
  generation++;
  resetImageState();
  requestedPreviewId = undefined; state.contentPreviewOpen = false;
  const previous = value.value;
  value.value = undefined;
  url.value = '';
  releaseUrls();
  const returnTo = previousFocus; previousFocus = null;
  await nextTick();
  if (returnTo?.isConnected) returnTo.focus({ preventScroll: true });
  closePreviews(previous);
}

const unsubscribe = subscribe(event => {
  if (event.type !== 'workspace.preview') return;
  const request = ++generation;
  requestedPreviewId = event.previewId;
  void call<Preview>('ui.request', { type: 'preview.get', data: { id: event.previewId } }).then(next => {
    if (request !== generation) {
      // 请求完成前被替换或关闭的预览也占用宿主内存；当前仍在使用的图片组继续保留。
      const ids = next.group?.items.map(item => item.id) ?? [next.id];
      if (!ids.includes(requestedPreviewId ?? '') && !ids.includes(value.value?.id ?? '')) closePreviews(next);
      return;
    }
    const previous = value.value;
    if (previous) closePreviews(previous);
    releaseUrls();
    resetImageState();
    const created = next.data ? createUrl(next.data, next.mimeType) : '';
    if (created) urls.set(next.id, created);
    url.value = created;
    value.value = next;
  }).catch(error => { if (request === generation) report(error); });
});
onUnmounted(() => { unsubscribe(); window.removeEventListener('resize', onResize); void close(); });
</script>
<template>
  <div v-if="value" class="content-preview-backdrop" @keydown="onKeydown"><section ref="dialog" class="content-preview" role="dialog" aria-modal="true" :aria-label="value.title">
    <header>
      <strong>{{ value.title }}</strong>
      <span v-if="group" class="preview-counter">{{ groupIndex + 1 }} / {{ groupItems.length }}</span>
      <div v-if="isImage && url" class="preview-tools" role="toolbar" :aria-label="t('previewImageTools')">
        <button type="button" :title="t('previewZoomOut')" :aria-label="t('previewZoomOut')" @click="zoomBy(1 / 1.25)">−</button>
        <span class="preview-zoom" :title="t('previewZoomPercent')">{{ zoomPercent }}</span>
        <button type="button" :title="t('previewZoomIn')" :aria-label="t('previewZoomIn')" @click="zoomBy(1.25)">＋</button>
        <button type="button" :title="t('previewFitToWindow')" @click="fitToWindow">{{ t('previewFit') }}</button>
        <button type="button" :title="t('previewRotateLeft')" :aria-label="t('previewRotateLeft')" @click="rotate(-90)">↺</button>
        <button type="button" :title="t('previewRotateRight')" :aria-label="t('previewRotateRight')" @click="rotate(90)">↻</button>
        <button type="button" :disabled="!naturalSize || copyingImage" :title="`${t('previewCopyImage')} (${copyShortcut})`" @click="copyImage">{{ t(copyingImage ? 'previewCopyingImage' : 'previewCopyImage') }}</button>
      </div>
      <a v-if="url" :href="url" :download="value.title">{{ t(isImage ? 'previewSaveImage' : 'previewSaveAttachment') }}</a>
      <button class="preview-close" @click="close">{{ t('close') }}</button>
    </header>
    <p v-if="imageAction" class="preview-action-status" :class="{ failed: imageAction.failed }" role="status">{{ imageAction.message }}</p>
    <div class="content-preview-body">
      <pre v-if="value.content !== undefined"><code>{{ value.content }}</code></pre>
      <template v-else-if="isImage">
        <div ref="stage" class="preview-stage" :class="{ dragging }" tabindex="0" :aria-label="t('previewImageTools')" @wheel.prevent="onWheel" @contextmenu.prevent.stop="showImageMenu"
          @pointerdown="onPointerDown" @pointermove="onPointerMove" @pointerup="onPointerUp" @pointercancel="onPointerUp">
          <img v-if="url" ref="imageElement" :src="url" :alt="value.title" :style="imageStyle" :class="{ ready: !!naturalSize }" draggable="false"
            :title="t('previewDoubleClick')" @load="onImageLoad" @error="onImageError" @dblclick="onDoubleClick" />
          <button v-if="hasPrevious" type="button" class="preview-nav previous" :aria-label="t('previewPrevious')" :title="`${t('previewPrevious')} (←)`" @pointerdown.stop @click="step(-1)">‹</button>
          <button v-if="hasNext" type="button" class="preview-nav next" :aria-label="t('previewNext')" :title="`${t('previewNext')} (→)`" @pointerdown.stop @click="step(1)">›</button>
        </div>
      </template>
      <audio v-else-if="value.mimeType?.startsWith('audio/')" :src="url" controls />
      <video v-else-if="value.mimeType?.startsWith('video/')" :src="url" controls />
      <iframe v-else-if="value.mimeType === 'application/pdf'" :src="url" :title="t('previewPdf')" sandbox=""></iframe>
      <p v-else>{{ t('previewUnsupported') }}</p>
    </div>
    <template v-if="imageMenu && isImage && url">
      <div class="preview-menu-backdrop" @pointerdown="dismissImageMenu()" @contextmenu.prevent="dismissImageMenu()"></div>
      <div ref="imageMenuElement" class="preview-image-menu" role="menu" :aria-label="t('previewImageMenu')" :style="{ left: imageMenu.x + 'px', top: imageMenu.y + 'px' }" @keydown="onMenuKeydown">
        <button type="button" role="menuitem" :disabled="!naturalSize || copyingImage" @click="menuAction(copyImage)"><span>{{ t(copyingImage ? 'previewCopyingImage' : 'previewCopyImage') }}</span><kbd>{{ copyShortcut }}</kbd></button>
        <a role="menuitem" :href="url" :download="value.title" @click="dismissImageMenu()">{{ t('previewSaveImage') }}</a>
        <div class="preview-menu-separator" role="separator"></div>
        <button type="button" role="menuitem" :disabled="!naturalSize" @click="menuAction(actualSize)">{{ t('previewActualSize') }}</button>
        <button type="button" role="menuitem" :disabled="!naturalSize" @click="menuAction(fitToWindow)">{{ t('previewFitToWindow') }}</button>
        <button type="button" role="menuitem" :disabled="!naturalSize" @click="menuAction(() => rotate(-90))">{{ t('previewRotateLeft') }}</button>
        <button type="button" role="menuitem" :disabled="!naturalSize" @click="menuAction(() => rotate(90))">{{ t('previewRotateRight') }}</button>
        <div class="preview-menu-separator" role="separator"></div>
        <button type="button" role="menuitem" @click="menuAction(close)"><span>{{ t('close') }}</span><kbd>Esc</kbd></button>
      </div>
    </template>
  </section></div>
</template>
<style scoped>
.content-preview-backdrop{position:fixed;inset:0;z-index:9500;background:#000b;display:grid;place-items:center}.content-preview{width:min(1100px,94vw);height:88vh;background:var(--gc-surface-sunken);border:1px solid var(--gc-border-subtle);display:flex;flex-direction:column}.content-preview header{display:flex;align-items:center;gap:12px;padding:12px 16px;border-bottom:1px solid var(--gc-border-subtle)}header strong{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.preview-counter{flex-shrink:0;color:var(--gc-text-muted);font-size:12px;font-variant-numeric:tabular-nums}.preview-tools{display:flex;align-items:center;gap:4px;flex-shrink:0}.preview-tools button{min-width:30px;padding:3px 8px;font-size:13px;line-height:1.4}.preview-zoom{flex-shrink:0;min-width:46px;text-align:center;color:var(--gc-text-muted);font-size:12px;font-variant-numeric:tabular-nums}header a{flex-shrink:0;color:var(--gc-accent);white-space:nowrap}.preview-close{flex-shrink:0;border-radius:var(--gc-radius-sm);white-space:nowrap}.content-preview-body{flex:1;min-height:0;overflow:auto;padding:16px;display:flex;align-items:flex-start;justify-content:center}.content-preview-body pre{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;width:100%;font:13px/1.6 var(--gc-font-code)}.preview-stage{position:relative;flex:1;align-self:stretch;min-width:0;overflow:hidden;cursor:grab;touch-action:none;user-select:none}.preview-stage.dragging{cursor:grabbing}.preview-stage img{position:absolute;left:50%;top:50%;margin:0;max-width:none;max-height:none;transform-origin:center;-webkit-user-drag:none;visibility:hidden}.preview-stage img.ready{visibility:visible}.preview-nav{position:absolute;top:50%;z-index:2;width:40px;height:64px;margin-top:-32px;padding:0;display:flex;align-items:center;justify-content:center;font-size:26px;line-height:1;color:rgb(255 255 255);background:#0009;border:0;cursor:pointer}.preview-nav:hover{background:#000c}.preview-nav.previous{left:8px}.preview-nav.next{right:8px}.content-preview-body video{max-width:100%;max-height:100%}.content-preview-body iframe{border:0;width:100%;height:100%;background:white}.content-preview-body audio{width:min(700px,100%)}
@media(max-width:640px){.content-preview header{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;padding:10px 12px}.content-preview header strong{grid-column:1;grid-row:1}.preview-close{grid-column:2;grid-row:1}.preview-tools{grid-column:1;grid-row:2;min-width:0;flex-wrap:wrap}.content-preview header a{grid-column:2;grid-row:2}.preview-counter{grid-column:1/-1;grid-row:3}.content-preview-body{padding:12px}}
.content-preview header{flex-wrap:wrap}.preview-tools{flex-wrap:wrap;max-width:100%}.preview-action-status{flex-shrink:0;margin:0;padding:8px 16px;color:var(--gc-text-muted);font-size:12px;border-bottom:1px solid var(--gc-border-subtle)}.preview-action-status.failed{color:var(--error,#ef9494)}.preview-stage:focus-visible{outline:1px solid var(--gc-accent);outline-offset:-1px}.preview-menu-backdrop{position:fixed;inset:0;z-index:3}.preview-image-menu{position:fixed;z-index:4;width:240px;max-width:calc(100vw - 16px);max-height:calc(100vh - 16px);overflow:auto;padding:4px;background:var(--gc-surface-raised);border:1px solid var(--gc-border-subtle);box-shadow:0 8px 28px #0006;cursor:default}.preview-image-menu button,.preview-image-menu a{display:flex;align-items:center;justify-content:space-between;gap:16px;width:100%;padding:9px 10px;border:0;border-radius:0;background:transparent;color:var(--gc-text-primary);font-size:13px;text-align:left;text-decoration:none;white-space:nowrap}.preview-image-menu a:hover,.preview-image-menu button:not(:disabled):hover{background:var(--gc-surface-hover)}.preview-image-menu [role=menuitem]:focus-visible{outline:1px solid var(--gc-accent);outline-offset:-1px;background:var(--gc-surface-hover)}.preview-image-menu kbd{color:var(--gc-text-muted);font:11px/1.4 var(--gc-font-code)}.preview-menu-separator{height:1px;margin:4px 6px;background:var(--gc-border-subtle)}
</style>
