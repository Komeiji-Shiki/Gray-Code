<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { formatDiffLineNumber, type LineDiffEntry } from '@/utils/lineDiff'

type DisplayLine = LineDiffEntry | {
  type: 'omitted'
  content: string
  oldLineNum?: undefined
  newLineNum?: undefined
}

const props = withDefaults(defineProps<{
  lines: DisplayLine[]
  lineNumberWidth: number
  maxHeight?: number
}>(), {
  maxHeight: 300
})

const rowHeight = 20
const overscan = 8
const container = ref<HTMLElement>()
const scrollTop = ref(0)
const viewportHeight = ref(300)

const useVirtualRows = computed(() => props.lines.length > 200)
const startIndex = computed(() => useVirtualRows.value
  ? Math.max(0, Math.floor(scrollTop.value / rowHeight) - overscan)
  : 0
)
const endIndex = computed(() => useVirtualRows.value
  ? Math.min(props.lines.length, Math.ceil((scrollTop.value + viewportHeight.value) / rowHeight) + overscan)
  : props.lines.length
)
const visibleLines = computed(() => props.lines.slice(startIndex.value, endIndex.value))
const totalHeight = computed(() => useVirtualRows.value ? props.lines.length * rowHeight : undefined)
const offsetY = computed(() => useVirtualRows.value ? startIndex.value * rowHeight : 0)

function updateViewport() {
  if (!container.value) return
  scrollTop.value = container.value.scrollTop
  viewportHeight.value = container.value.clientHeight
}

onMounted(updateViewport)
</script>

<template>
  <div
    ref="container"
    class="virtual-diff-scroll"
    :style="{ maxHeight: `${maxHeight}px` }"
    @scroll="updateViewport"
  >
    <div class="virtual-diff-spacer" :style="{ height: totalHeight ? `${totalHeight}px` : undefined }">
      <div class="virtual-diff-window" :style="{ transform: `translateY(${offsetY}px)` }">
        <div
          v-for="(line, visibleIndex) in visibleLines"
          :key="startIndex + visibleIndex"
          :class="['diff-line', `line-${line.type}`]"
        >
          <span class="line-nums">
            <span class="old-num">{{ formatDiffLineNumber(line.oldLineNum, lineNumberWidth) }}</span>
            <span class="new-num">{{ formatDiffLineNumber(line.newLineNum, lineNumberWidth) }}</span>
          </span>
          <span class="line-marker">
            <span v-if="line.type === 'deleted'" class="marker deleted">-</span>
            <span v-else-if="line.type === 'added'" class="marker added">+</span>
            <span v-else-if="line.type === 'omitted'" class="marker omitted">⋯</span>
            <span v-else class="marker unchanged">&nbsp;</span>
          </span>
          <span class="line-content">{{ line.content || ' ' }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.virtual-diff-scroll {
  overflow: auto;
  position: relative;
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: var(--vscode-editor-font-size, 12px);
}

.virtual-diff-spacer {
  min-width: max-content;
  position: relative;
}

.virtual-diff-window {
  left: 0;
  min-width: 100%;
  position: absolute;
  top: 0;
}

.virtual-diff-spacer:not([style*="height"]) .virtual-diff-window {
  position: static;
  transform: none !important;
}

.diff-line {
  align-items: stretch;
  display: flex;
  height: 20px;
  line-height: 20px;
  min-width: max-content;
  white-space: pre;
}

.line-unchanged { background: transparent; }
.line-deleted { background: rgba(255, 0, 0, 0.10); }
.line-added { background: rgba(0, 255, 0, 0.10); }
.line-omitted { color: var(--vscode-descriptionForeground); font-style: italic; }

.line-nums {
  color: var(--vscode-editorLineNumber-foreground);
  display: inline-flex;
  flex: 0 0 auto;
  user-select: none;
}

.old-num,
.new-num {
  box-sizing: content-box;
  padding: 0 6px;
  text-align: right;
}

.line-marker {
  display: inline-block;
  flex: 0 0 18px;
  text-align: center;
  user-select: none;
}

.marker.deleted { color: var(--vscode-gitDecoration-deletedResourceForeground, #f14c4c); }
.marker.added { color: var(--vscode-gitDecoration-addedResourceForeground, #73c991); }
.marker.omitted { color: var(--vscode-descriptionForeground); }
.line-content { padding-right: 12px; }
</style>
