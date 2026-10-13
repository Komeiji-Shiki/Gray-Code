<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from '../../../i18n'
import { computeLineDiffCached } from '../../../utils/lineDiff'
import VirtualDiffLines from '../../common/VirtualDiffLines.vue'
import { useToolDiffPreviews } from './useToolDiffPreviews'

const props = defineProps<{ diffContentId: string }>()
const { t } = useI18n()
const expanded = ref(false)
const requested = ref(false)
// 首次展开才读取正文；再次折叠保留当前差异缓存，卡片卸载时由组合式函数清理。
const sources = computed(() => requested.value ? [{ key: props.diffContentId, diffContentId: props.diffContentId }] : [])
const { diffContents, diffLoadErrors, isLoadingDiff, loadDiffContent } = useToolDiffPreviews(sources, 'content')
const diff = computed(() => {
  const content = diffContents.value.get(props.diffContentId)
  return content ? computeLineDiffCached(content.originalContent, content.newContent) : undefined
})
function toggle(event: Event) {
  expanded.value = (event.target as HTMLDetailsElement).open
  if (expanded.value) requested.value = true
}
</script>

<template>
  <details class="tool-diff-preview" @toggle="toggle">
    <summary>{{ t('components.message.tool.viewDiff') }}</summary>
    <div v-if="expanded" class="preview-body">
      <p v-if="isLoadingDiff(diffContentId)" role="status">{{ t('common.loading') }}</p>
      <div v-else-if="diffLoadErrors.has(diffContentId)" class="preview-error" role="alert">
        <span>{{ diffLoadErrors.get(diffContentId) }}</span>
        <button type="button" class="gc-button gc-button--ghost" @click="loadDiffContent(diffContentId, diffContentId)">
          {{ t('common.retry') }}
        </button>
      </div>
      <template v-else-if="diff">
        <div class="preview-stats"><span class="removed">−{{ diff.deleted }}</span><span class="added">+{{ diff.added }}</span></div>
        <VirtualDiffLines :lines="diff.lines" :line-number-width="diff.lineNumberWidth" :max-height="300" />
      </template>
    </div>
  </details>
</template>

<style scoped>
.tool-diff-preview { margin-top: 8px; background: var(--gc-surface-sunken); }
summary { cursor: pointer; padding: 6px 8px; color: var(--gc-text-muted); font-size: 12px; }
.preview-body > p { padding: 8px; margin: 0; }
.preview-error, .preview-stats { display: flex; align-items: center; gap: 8px; padding: 6px 8px; }
.preview-error { color: var(--gc-danger); }
.removed { color: var(--gc-git-deleted); }
.added { color: var(--gc-git-added); }
</style>
