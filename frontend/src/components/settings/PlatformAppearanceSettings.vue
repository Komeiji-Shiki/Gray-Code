<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { AppSettings } from '../../../../packages/contracts/src/settings';
import { sendToExtension } from '../../utils/vscode';
import { useDesktopSettingsDraft } from '../../platform/settingsDraft';
import BackgroundGallery from './BackgroundGallery.vue';
import MarkdownRenderer from '../common/MarkdownRenderer.vue';
import { resourceUrl } from '../../platform/resources';
const settings = ref<AppSettings>();
const fonts = ref<string[]>([]);
const filter = ref('');
const error = ref('');
const galleryOpen = ref(false);
const previewText = '### 从想法到实现\n\n这是统一正文预览，包含 **粗体**、*斜体*、~~删除线~~ 和 `行内代码`。\n\n> “把问题说明白，再把事情做好。”\n\n- 普通列表与 [链接](https://example.com)\n- [x] 已完成的事项\n- [ ] 接下来的工作\n\n```typescript\nconst greeting: string = "你好，主人";\nconsole.log(greeting);\n```\n\n| 项目 | 状态 |\n| --- | --- |\n| 正文排版 | 即时预览 |\n| 字体与配色 | 统一呈现 |\n\n行内公式 $E = mc^2$，以及分隔线：\n\n---\n';
const previewStyle = computed(() => {
  const config = settings.value?.appearance; if (!config) return {};
  return { fontFamily: config.textFont === 'inherit' ? config.uiFont : config.textFont, fontSize: `${config.fontSize}px`, lineHeight: config.lineHeight,
    color: config.colors.text, backgroundColor: config.colors.background,
    '--vscode-editor-font-family': config.codeFont, '--vscode-editor-font-size': `${config.codeFontSize}px`,
    '--vscode-textLink-foreground': config.colors.accent, '--gc-accent': config.colors.accent };
});
async function applyBackground(url: string, opacity: number) {
  if (!settings.value) return;
  settings.value.appearance.backgroundImage = url; settings.value.appearance.backgroundOpacity = opacity; galleryOpen.value = false;
  await save();
}
const fontFields = [ { key: 'uiFont', name: '界面字体' }, { key: 'textFont', name: '正文字体' }, { key: 'codeFont', name: '代码字体' } ] as const;
const colors = [{ key: 'background', name: '背景', value: '#17191e' }, { key: 'panel', name: '面板', value: '#22252c' }, { key: 'text', name: '文字', value: '#dedee3' }, { key: 'accent', name: '强调色', value: '#6ba6ff' }, { key: 'border', name: '边框', value: '#323742' }];
const fontValue = (family: string) => JSON.stringify(family);
const isInstalledFont = (value: string) => fonts.value.some(font => fontValue(font) === value);
async function save() {
  if (!settings.value) return;
  try { await sendToExtension('platform.settings.update', { settings: settings.value }); }
  catch (e) { error.value = (e as Error).message; throw e; }
}
async function loadFonts(refresh = false) {
  try { fonts.value = await sendToExtension('desktop.fonts', { refresh }); }
  catch (e) { error.value = (e as Error).message; }
}
onMounted(async () => { settings.value = await sendToExtension('platform.settings.get', {}); await loadFonts(); });
useDesktopSettingsDraft(save, () => !!settings.value);
</script>
<template>
  <section v-if="settings" class="platform-appearance" @change="save">
    <h3>桌面外观</h3>
    <div class="appearance-row"><div><strong>主题</strong><p>默认使用暗色界面和蓝色强调色。</p></div><select v-model="settings.appearance.theme"><option value="dark">暗色</option><option value="light">浅色</option><option value="system">跟随系统</option></select></div>
    <div class="appearance-row"><div><strong>系统字体</strong><p>读取系统已安装的字体，包括当前用户安装的字体。</p></div><button @click="loadFonts(true)">刷新 {{ fonts.length }} 个字体</button></div>
    <input v-model="filter" placeholder="搜索系统字体…" aria-label="搜索系统字体" data-preference-transient @change.stop />
    <div v-for="field in fontFields" :key="field.key" class="appearance-row">
      <div><strong>{{ field.name }}</strong></div>
      <select v-model="settings.appearance[field.key]" :aria-label="field.name">
        <option v-if="settings.appearance[field.key] !== 'inherit' && !isInstalledFont(settings.appearance[field.key])" :value="settings.appearance[field.key]">当前默认字体组合</option>
        <option v-if="field.key === 'textFont'" value="inherit">跟随界面字体</option>
        <option v-for="font in fonts.filter(item => item.toLowerCase().includes(filter.toLowerCase()))" :key="font" :value="fontValue(font)" :style="{ fontFamily: fontValue(font) }">{{ font }}</option>
      </select>
    </div>
    <div class="appearance-row"><div><strong>界面字号</strong></div><input v-model.number="settings.appearance.fontSize" type="number" min="10" max="30" /></div>
    <div class="appearance-row"><div><strong>代码字号</strong></div><input v-model.number="settings.appearance.codeFontSize" type="number" min="10" max="30" /></div>
    <div class="appearance-row"><div><strong>行高</strong></div><input v-model.number="settings.appearance.lineHeight" type="number" min="1" max="3" step="0.1" /></div>
    <div class="appearance-row"><strong>布局密度</strong><select v-model="settings.appearance.density"><option value="compact">紧凑</option><option value="comfortable">舒适</option></select></div>
    <div class="color-grid"><label v-for="color in colors" :key="color.key"><span>{{ color.name }}</span><input type="color" :value="settings.appearance.colors[color.key] ?? color.value" @input="settings.appearance.colors[color.key] = ($event.target as HTMLInputElement).value" :aria-label="color.name" /><input class="color-code" :value="settings.appearance.colors[color.key] ?? color.value" @input="settings.appearance.colors[color.key] = ($event.target as HTMLInputElement).value" :aria-label="color.name + '颜色代码'" /></label></div>
    <div class="appearance-row"><div><strong>对话背景</strong><p>{{ settings.appearance.backgroundImage ? '已启用背景图片' : '保持纯色背景' }}</p></div><button @click="galleryOpen = true">管理背景</button></div>
    <section class="unified-preview" :style="previewStyle"><header>正文预览 <span>字体、配色与排版统一呈现</span></header><div class="preview-content"><div class="preview-background" :style="{ backgroundImage: settings.appearance.backgroundImage ? `url(${JSON.stringify(resourceUrl(settings.appearance.backgroundImage))})` : 'none', opacity: settings.appearance.backgroundOpacity }"></div><MarkdownRenderer :content="previewText" /></div></section>
    <details class="css-editor"><summary>自定义 CSS</summary><textarea v-model="settings.appearance.customCss" rows="5" spellcheck="false" placeholder=":root { --gc-accent: #6ba6ff; }"></textarea></details>
    <BackgroundGallery :visible="galleryOpen" :value="settings.appearance.backgroundImage" :opacity="settings.appearance.backgroundOpacity" @close="galleryOpen = false" @apply="applyBackground" />
    <p v-if="error" role="alert">{{ error }}</p>
  </section>
</template>
<style scoped>
.platform-appearance { margin-bottom: 32px; }
.appearance-row { display: flex; gap: 20px; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--gc-border-subtle); padding: 10px 0; min-height: 35px; }
.appearance-row strong { font-size: var(--gc-font-size-control); font-weight: 500; }
.appearance-row p { color: var(--gc-text-muted); font-size: var(--gc-font-size-body); margin: 6px 0 0; }
.appearance-row input, .appearance-row select { max-width: 46%; min-width: 120px; }
.appearance-row input[type=number] { width: 88px; min-width: 0; }
input, select, textarea { background: var(--vscode-input-background); color: var(--vscode-foreground); border: 1px solid var(--gc-border-control); padding: 7px 10px; font: inherit; border-radius: 0; }
.css-editor { display: grid; gap: 12px; padding-top: 24px; }
textarea { resize: vertical; font-family: var(--vscode-editor-font-family); }
.color-grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px;margin:18px 0}.color-grid label{display:grid;grid-template-columns:1fr 28px;align-items:center;gap:7px;font-size:12px}.color-grid input[type=color]{width:28px;height:26px;padding:2px;min-width:0}.color-code{grid-column:1/-1;width:100%;min-width:0;box-sizing:border-box;font-size:11px;padding:5px!important}.unified-preview{border:1px solid var(--gc-border-subtle);margin-top:22px}.unified-preview>header{display:flex;justify-content:space-between;gap:12px;border-bottom:1px solid var(--gc-border-subtle);padding:11px 16px;font:12px var(--vscode-font-family)}.unified-preview header span{color:var(--gc-text-muted)}.preview-content{position:relative;padding:18px 22px;overflow:hidden}.preview-background{position:absolute;inset:0;background-size:cover;background-position:center;pointer-events:none}.preview-content :deep(.markdown-content){position:relative;font-family:inherit!important;font-size:inherit!important;line-height:inherit!important}.css-editor textarea{width:100%;box-sizing:border-box;margin-top:12px}.css-editor summary{cursor:pointer;color:var(--gc-text-muted);font-size:12px}
</style>
