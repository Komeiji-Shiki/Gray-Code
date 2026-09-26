<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from '../../../i18n'

const props = defineProps<{ text: string; startLine?: number; code?: boolean }>()
const { t } = useI18n()
const limit = ref(12000)
const visible = computed(() => props.text.slice(0, limit.value))
const lines = computed(() => visible.value.split(/\r\n|\n|\r/))
watch(() => props.text, () => { limit.value = 12000 })
</script>

<template>
  <div class="platform-text" :class="{ 'is-code': code }">
    <pre v-if="startLine !== undefined" class="platform-code" tabindex="0"><span v-for="(line, index) in lines" :key="index" class="numbered-line"><span class="line-number" aria-hidden="true">{{ startLine + index }}</span><code>{{ line }}{{ index < lines.length - 1 ? '\n' : '' }}</code></span></pre>
    <pre v-else tabindex="0">{{ visible }}</pre>
    <button v-if="text.length > limit" type="button" class="platform-more" @click="limit += 24000">{{ t('components.tools.structured.moreText', { count: text.length - limit }) }}</button>
  </div>
</template>

<style scoped>
.platform-text{min-width:0}.platform-text pre{margin:0;max-height:360px;overflow:auto;overscroll-behavior:contain;white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;line-height:1.7;tab-size:2}.is-code pre{font:12px/1.6 var(--vscode-editor-font-family,monospace);background:var(--vscode-editor-background);padding:10px}.platform-code{counter-reset:line}.numbered-line{display:flex;min-width:0}.line-number{flex:0 0 4em;user-select:none;text-align:right;padding-right:12px;color:var(--vscode-editorLineNumber-foreground,var(--vscode-descriptionForeground))}.numbered-line code{font:inherit;min-width:0;white-space:pre-wrap;overflow-wrap:anywhere}.platform-more{margin-top:8px;border:0;border-radius:0;padding:4px 0;color:var(--vscode-textLink-foreground);background:none;cursor:pointer;font:inherit;font-size:11px}button:focus-visible,pre:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:2px}
</style>
