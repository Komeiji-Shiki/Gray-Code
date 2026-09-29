<script setup lang="ts">
import { useI18n } from '../../../i18n'
import PlatformText from './PlatformText.vue'

defineProps<{ data: Record<string, unknown> }>()
const { t } = useI18n()
</script>

<template>
  <div class="process-output">
    <p v-if="data.outputLost === true || data.truncated === true" class="platform-notice warning output-truncated">{{ t('components.tools.platform.process.truncated') }}</p>
    <h4 class="platform-section-title">{{ t('components.tools.platform.process.output') }}</h4>
    <PlatformText v-if="typeof data.output === 'string' && data.output.length" :text="data.output" code />
    <p v-else class="platform-empty">{{ t(typeof data.output === 'string' ? 'components.tools.platform.process.noOutput' : 'components.tools.platform.noData') }}</p>
    <p v-if="data.hasMore === true" class="platform-notice process-continuation">{{ t('components.tools.platform.process.moreOutput') }}</p>
  </div>
</template>

<style scoped src="./platform.css"></style>
