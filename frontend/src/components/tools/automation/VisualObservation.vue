<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from '../../../i18n'
import { toolImage } from '../../../utils/toolPresentation'
import ToolResultValue from '../common/ToolResultValue.vue'
import { dimensions, numeric, record, text, type ResultRecord } from './automationResult'
const props = defineProps<{ value: ResultRecord }>()
const { t, actualLanguage } = useI18n()
const screenshot = computed(() => record(props.value.screenshot))
const capturedAt = computed(() => {
  const value = numeric(props.value.capturedAt)
  return value !== undefined && !Number.isNaN(new Date(value).getTime()) ? new Date(value).toLocaleString(actualLanguage.value) : ''
})
</script>

<template>
  <div v-if="value.id || Object.keys(screenshot).length" class="automation-observation automation-section">
    <dl class="automation-fields">
      <div v-if="value.id"><dt>{{ t('components.tools.automation.observation') }}</dt><dd><code class="automation-code">{{ text(value.id) }}</code></dd></div>
      <div v-if="dimensions(screenshot)"><dt>{{ t('components.tools.automation.dimensions') }}</dt><dd>{{ dimensions(screenshot) }} px</dd></div>
      <div v-if="capturedAt"><dt>{{ t('components.tools.automation.capturedAt') }}</dt><dd>{{ capturedAt }}</dd></div>
    </dl>
    <p v-if="value.coordinateSpace === 'image'" class="automation-muted">{{ t('components.tools.automation.imageCoordinates') }}</p>
    <!-- 旧历史可能内嵌截图；现代工具的附件仍由外层公共面板统一显示。 -->
    <ToolResultValue v-if="toolImage(screenshot)" :value="screenshot" />
  </div>
</template>

<style scoped src="./automation.css"></style>
