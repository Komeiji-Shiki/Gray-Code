<script setup lang="ts">
import { ref, watch } from 'vue';
import { sendToExtension } from '../../utils/vscode';
import { resourceUrl } from '../../platform/resources';
const props = defineProps<{ visible: boolean; value: string; opacity: number }>();
const emit = defineEmits<{ close: []; apply: [url: string, opacity: number] }>();
interface ImageItem { id: string; name: string; url: string; thumbnail: string; width: number; height: number }
const images = ref<ImageItem[]>([]); const selected = ref(''); const strength = ref(.12); const error = ref(''); const uploading = ref(false);
async function load() { images.value = await sendToExtension('appearance.images.list', {}); }
watch(() => props.visible, async value => {
  if (!value) return;
  selected.value = props.value; strength.value = props.opacity; error.value = '';
  try { await load(); } catch (cause) { error.value = (cause as Error).message; }
});
async function upload(event: Event) {
  const input = event.target as HTMLInputElement; const file = input.files?.[0]; if (!file) return;
  uploading.value = true; error.value = '';
  try {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 10 * 1024 * 1024) throw new Error('请选择不超过 10 MB 的 JPG、PNG 或 WebP 图片。');
    const dataUrl = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsDataURL(file); });
    const image = new Image(); image.src = dataUrl; await image.decode();
    // 长截图也限制在同一个预览框内，避免固定宽度生成极高的画布。
    const thumbnailScale = Math.min(1, 320 / image.width, 320 / image.height);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.width * thumbnailScale));
    canvas.height = Math.max(1, Math.round(image.height * thumbnailScale));
    canvas.getContext('2d')!.drawImage(image, 0, 0, canvas.width, canvas.height);
    const result = await sendToExtension<{ url: string }>('appearance.images.add', { name: file.name, dataUrl,
      thumbnail: canvas.toDataURL('image/jpeg', .75), width: image.width, height: image.height });
    await load(); selected.value = result.url;
  } catch (cause) { error.value = (cause as Error).message; }
  finally { uploading.value = false; input.value = ''; }
}
async function remove(image: ImageItem) {
  try { await sendToExtension('appearance.images.remove', { id: image.id }); if (selected.value === image.url) selected.value = ''; await load(); }
  catch (cause) { error.value = (cause as Error).message; }
}
async function rename(image: ImageItem, event: Event) {
  try { await sendToExtension('appearance.images.rename', { id: image.id, name: (event.target as HTMLInputElement).value }); await load(); }
  catch (cause) { error.value = (cause as Error).message; }
}
</script>
<template>
  <Teleport to="body"><div v-if="visible" class="background-backdrop" data-preference-transient @click.self="emit('close')">
    <section class="background-dialog" role="dialog" aria-modal="true" aria-label="背景图片">
      <header><div><h3>背景图片</h3><p>选择一张图片，调整它在对话中的显示强度。</p></div><button aria-label="关闭" @click="emit('close')">×</button></header>
      <div class="background-body">
        <div class="background-preview"><div class="background-preview-image" :style="{ backgroundImage: selected ? `url(${JSON.stringify(resourceUrl(selected))})` : 'none', opacity: strength }"></div>
          <div class="background-preview-content"><small>效果预览</small><p>从一个想法开始，完成今天的工作。</p><div class="preview-input">接下来，我们做些什么？<span>↑</span></div></div>
        </div>
        <label class="strength-row"><strong>背景强度</strong><input v-model.number="strength" type="range" min="0" max="1" step=".01" /><span>{{ Math.round(strength * 100) }}%</span></label>
        <p class="gallery-note">0% 完全隐藏背景，100% 显示原图强度。数值越大，背景越明显，也更容易影响文字对比度，可结合上方预览调整。</p>
        <div class="gallery-heading"><strong>我的图片 <small>{{ images.length }} 张</small></strong><label class="upload-button">{{ uploading ? '正在上传…' : '上传图片' }}<input type="file" accept="image/jpeg,image/png,image/webp" hidden :disabled="uploading" @change="upload" /></label></div>
        <p class="gallery-note">JPG、PNG、WebP，每张不超过 10 MB。图库管理立即保存，应用背景后再统一保存设置。</p>
        <div class="image-grid">
          <button class="image-none" :class="{ selected: selected === '' }" @click="selected = ''"><span>∅</span>无背景</button>
          <article v-for="image in images" :key="image.id" class="image-tile"><button class="image-thumb" :class="{ selected: selected === image.url }" @click="selected = image.url"><img :src="resourceUrl(image.thumbnail || image.url)" :alt="image.name" /><span v-if="selected === image.url">✓</span></button><div class="image-caption"><input :value="image.name" aria-label="图片名称" @change="rename(image, $event)" /><button title="删除图片" @click="remove(image)">删除</button></div><small>{{ image.width }} × {{ image.height }}</small></article>
        </div>
        <details><summary>使用网络图片地址</summary><input v-model="selected" class="image-url" placeholder="https://…" /></details>
        <p v-if="error" role="alert" class="gallery-error">{{ error }}</p>
      </div>
      <footer><span>{{ images.find(image => image.url === selected)?.name || (selected ? '网络图片' : '无背景') }}</span><button @click="emit('close')">取消</button><button class="apply-background" @click="emit('apply', selected, strength)">应用背景</button></footer>
    </section>
  </div></Teleport>
</template>
<style scoped>
.background-backdrop{position:fixed;inset:0;z-index:6000;background:#0009;display:grid;place-items:center;padding:24px}.background-dialog{width:min(760px,100%);max-height:90vh;display:flex;flex-direction:column;background:var(--gc-surface-panel,#191c22);color:var(--gc-text-primary,#ddd);border:1px solid var(--gc-border-control,#3a404c);box-shadow:0 20px 80px #0006}.background-dialog header,.background-dialog footer{display:flex;align-items:center;gap:12px;padding:18px 22px}.background-dialog header{justify-content:space-between;border-bottom:1px solid var(--gc-border-subtle)}h3{margin:0;font-size:17px}header p,.gallery-note,small{font-size:12px;color:var(--gc-text-muted);margin:7px 0}.background-body{padding:22px;overflow:auto}.background-preview{position:relative;min-height:190px;background:var(--gc-surface-base);overflow:hidden;border:1px solid var(--gc-border-subtle)}.background-preview-image{position:absolute;inset:0;background-size:cover;background-position:center}.background-preview-content{position:relative;margin:28px auto;max-width:78%}.preview-input{display:flex;justify-content:space-between;background:var(--gc-surface-panel);padding:15px 18px;border:1px solid var(--gc-border-control);font-size:13px}.strength-row,.gallery-heading{display:flex;align-items:center;gap:16px;margin:24px 0 14px;font-size:13px}.strength-row strong,.gallery-heading strong{flex:1}.strength-row input{width:36%}.strength-row span{width:40px;text-align:right}.image-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:16px;margin:18px 0}.image-thumb,.image-none{position:relative;width:100%;height:125px;border:1px solid var(--gc-border-control);padding:0;background:var(--gc-surface-base);cursor:pointer}.image-thumb img{width:100%;height:100%;object-fit:cover}.image-thumb span{position:absolute;right:6px;top:6px;background:#15171de6;padding:3px 6px}.image-none{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px}.image-none>span{font-size:30px}.selected{outline:2px solid var(--gc-accent);outline-offset:2px}.image-caption{display:flex;margin-top:8px;gap:4px}.image-caption input{width:0;flex:1;border:0;background:transparent;padding:3px 0}.image-caption button{padding:3px 5px;font-size:11px}.background-dialog button,.upload-button{font:inherit;color:inherit;border:1px solid var(--gc-border-control);background:transparent;cursor:pointer;padding:7px 12px;border-radius:0}.background-dialog input{color:inherit}.background-dialog footer{border-top:1px solid var(--gc-border-subtle)}footer>span{flex:1;font-size:12px;color:var(--gc-text-muted)}.apply-background{background:var(--vscode-button-background)!important;color:var(--vscode-button-foreground)!important}.upload-button{font-size:12px}.image-url{width:100%;box-sizing:border-box;margin-top:12px;background:var(--gc-surface-base);border:1px solid var(--gc-border-control);padding:9px}.gallery-error{color:var(--gc-danger)}details{font-size:12px;color:var(--gc-text-muted)}
</style>
