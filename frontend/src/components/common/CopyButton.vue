<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import IconButton from './IconButton.vue'
import { copyToClipboard } from '../../utils/format'
import { t } from '../../i18n'

const props = defineProps<{ text: string }>()
const copiedText = ref<string | null>(null)
const failed = ref(false)
const copying = ref(false)
const copied = computed(() => copiedText.value === props.text)
const label = computed(() => failed.value ? t('common.copyFailed')
  : copied.value ? t('components.common.tooltip.copied') : t('common.copy'))
watch(() => props.text, () => { copiedText.value = null; failed.value = false })

async function copy() {
  const text = props.text
  copying.value = true
  const success = await copyToClipboard(text)
  copying.value = false
  // 复制等待期间错误可能变化，只为当前内容显示结果。
  if (props.text === text) { copiedText.value = success ? text : null; failed.value = !success }
}
</script>

<template>
  <IconButton :icon="failed ? 'codicon-warning' : copied ? 'codicon-check' : 'codicon-copy'"
    size="small" :tooltip="label" :disabled="copying" @click="copy" />
  <span class="copy-feedback" role="status">{{ copied || failed ? label : '' }}</span>
</template>

<style scoped>
.copy-feedback { font-size: 11px; }
.copy-feedback:empty { display: none; }
</style>
