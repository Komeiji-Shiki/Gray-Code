<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch, type ComponentPublicInstance } from 'vue'
import CustomScrollbar from '../../common/CustomScrollbar.vue'
import { escapeHtml } from '../../common/markdownUtils'
import { useOpenWorkspaceFile } from '../../../composables/useOpenWorkspaceFile'

interface SearchMatch { file: string; line: number; column: number; match: string; context: string }
const props = withDefaults(defineProps<{ matches: SearchMatch[]; compact?: boolean; maxHeight?: number }>(), { maxHeight: 300 })
const { openFileAt } = useOpenWorkspaceFile()
const scrollbar = ref<InstanceType<typeof CustomScrollbar>>()
const scrollTop = ref(0)
const viewportHeight = ref(props.maxHeight)
const measured = shallowRef(new Map<SearchMatch, number>())
const elements = new Map<number, HTMLElement>()
const highlights = new WeakMap<SearchMatch, { context: string; match: string; html: string }>()
const expressions = new Map<string, RegExp>()
let observer: ResizeObserver | undefined
let container: HTMLElement | null = null
let width = 0
let disposed = false
const virtual = computed(() => props.matches.length > 30)
const offsets = computed(() => {
  const result = [0]
  for (const match of props.matches) result.push(result.at(-1)! + (measured.value.get(match) ?? (props.compact ? 28 : 80)))
  return result
})
function indexAt(position: number, positions = offsets.value): number {
  let low = 0
  let high = positions.length - 1
  while (low < high) {
    const middle = Math.floor((low + high + 1) / 2)
    if (positions[middle] <= position) low = middle
    else high = middle - 1
  }
  return Math.min(low, Math.max(0, positions.length - 2))
}
const startIndex = computed(() => virtual.value ? indexAt(Math.max(0, scrollTop.value - 160)) : 0)
const endIndex = computed(() => virtual.value
  ? Math.min(props.matches.length, indexAt(scrollTop.value + viewportHeight.value + 160) + 1) : props.matches.length)
// 旧 ref 回调也必须保留当次渲染的绝对编号，不能在卸载时读取新窗口的起点。
const visible = computed(() => props.matches.slice(startIndex.value, endIndex.value)
  .map((match, index) => ({ match, index: startIndex.value + index })))
watch(() => props.matches, matches => {
  const retained = new Set(matches)
  measured.value = new Map([...measured.value].filter(([match]) => retained.has(match)))
})
watch(virtual, enabled => {
  if (!observer || !container) return
  observer.disconnect()
  if (enabled) {
    viewportHeight.value = container.clientHeight
    observer.observe(container)
    for (const element of elements.values()) observer.observe(element)
  }
}, { flush: 'post' })
function bindRow(index: number, node: Element | ComponentPublicInstance | null) {
  const before = elements.get(index)
  if (before === node) return
  if (before) observer?.unobserve(before)
  if (node instanceof HTMLElement) { elements.set(index, node); if (virtual.value) observer?.observe(node) }
  else elements.delete(index)
}
function onScroll() { scrollTop.value = container?.scrollTop ?? 0 }
async function navigate(event: KeyboardEvent) {
  if (!virtual.value || props.compact || !container || !(event.target instanceof HTMLElement)) return
  const row = event.target.closest<HTMLElement>('[data-match-index]')
  if (!row) return
  const current = Number(row.dataset.matchIndex)
  let target: number
  if (event.key === 'ArrowDown') target = current + 1
  else if (event.key === 'ArrowUp') target = current - 1
  else if (event.key === 'Home') target = 0
  else if (event.key === 'End') target = props.matches.length - 1
  else if (event.key === 'Tab' && !event.shiftKey && current === endIndex.value - 1 && event.target.classList.contains('line-info')) target = current + 1
  else if (event.key === 'Tab' && event.shiftKey && current === startIndex.value && event.target.classList.contains('file-path')) target = current - 1
  else return
  if (target < 0 || target >= props.matches.length) return
  event.preventDefault()
  container.scrollTop = offsets.value[target]
  onScroll()
  await nextTick()
  elements.get(target)?.querySelector<HTMLElement>(event.shiftKey && event.key === 'Tab' ? '.line-info' : '.file-path')?.focus({ preventScroll: true })
}
onMounted(() => {
  container = scrollbar.value?.getContainer() ?? null
  if (!container) return
  width = container.clientWidth
  viewportHeight.value = container.clientHeight
  container.addEventListener('scroll', onScroll, { passive: true })
  observer = new ResizeObserver(entries => {
    if (!container) return
    const anchor = indexAt(container.scrollTop)
    const anchorMatch = props.matches[anchor]
    const within = container.scrollTop - offsets.value[anchor]
    const resized = width !== container.clientWidth
    width = container.clientWidth
    viewportHeight.value = container.clientHeight
    const next = resized ? new Map<SearchMatch, number>() : new Map(measured.value)
    let changed = resized
    // 上下文允许换行，按实际行块高度建偏移；尺寸变化时保留当前阅读位置。
    for (const entry of entries) {
      const element = entry.target as HTMLElement
      const index = Number(element.dataset.matchIndex)
      const match = props.matches[index]
      if (element === container || !match || elements.get(index) !== element) continue
      const height = entry.borderBoxSize?.[0]?.blockSize ?? element.getBoundingClientRect().height
      if (height > 0 && next.get(match) !== height) { next.set(match, height); changed = true }
    }
    if (!changed) return
    measured.value = next
    if (virtual.value) void nextTick(() => {
      if (disposed || !container || props.matches[anchor] !== anchorMatch) return
      const height = offsets.value[anchor + 1] - offsets.value[anchor]
      container.scrollTop = offsets.value[anchor] + Math.min(Math.max(0, within), Math.max(0, height - 1))
      onScroll()
    })
  })
  if (virtual.value) {
    observer.observe(container)
    for (const element of elements.values()) observer.observe(element)
  }
})
onBeforeUnmount(() => { disposed = true; observer?.disconnect(); container?.removeEventListener('scroll', onScroll) })

function highlighted(match: SearchMatch): string {
  const previous = highlights.get(match)
  if (previous?.context === match.context && previous.match === match.match) return previous.html
  let expression = expressions.get(match.match)
  if (match.match && !expression) {
    expression = new RegExp(`(${match.match.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi')
    expressions.set(match.match, expression)
    if (expressions.size > 64) expressions.delete(expressions.keys().next().value!)
  }
  const html = expression ? (match.context || '').split(expression)
    .map((part, index) => index % 2 ? `<mark>${escapeHtml(part)}</mark>` : escapeHtml(part)).join('') : escapeHtml(match.context || '')
  highlights.set(match, { context: match.context, match: match.match, html })
  return html
}
</script>

<template>
  <CustomScrollbar ref="scrollbar" :max-height="maxHeight">
    <div class="match-list" :style="virtual ? { height: offsets.at(-1) + 'px' } : undefined" @keydown="navigate">
      <div :style="virtual ? { position: 'absolute', width: '100%', transform: `translateY(${offsets[startIndex]}px)` } : undefined">
        <div v-for="row in visible" :key="`${row.match.file}:${row.match.line}:${row.index}`"
          :ref="node => bindRow(row.index, node)" :data-match-index="row.index"
          class="match-item" :class="{ compact }">
          <template v-if="compact">
            <span class="line-info">:{{ row.match.line }}:{{ row.match.column }}</span>
            <code class="match-text">{{ row.match.match }}</code>
          </template>
          <template v-else>
            <div class="match-header">
              <span class="codicon codicon-file file-icon"></span>
              <button type="button" class="file-path gc-link-button" :title="row.match.file"
                @click="openFileAt(row.match.file, row.match.line)">{{ row.match.file }}</button>
              <button type="button" class="line-info gc-link-button"
                @click="openFileAt(row.match.file, row.match.line)">:{{ row.match.line }}:{{ row.match.column }}</button>
            </div>
            <pre class="match-context"><code v-html="highlighted(row.match)"></code></pre>
          </template>
        </div>
      </div>
    </div>
  </CustomScrollbar>
</template>

<style scoped>
.match-list { position: relative; overflow-anchor: none; }
.match-item { border-bottom: 1px solid var(--gc-border-subtle); }
.match-header, .compact { display: flex; align-items: center; gap: 4px; padding: 4px 8px; font-size: 11px; }
.match-header { background: var(--gc-surface-muted); }
.file-icon { color: var(--gc-text-muted); }
.file-path { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--gc-link); text-align: left; }
.line-info { color: var(--gc-chart-orange); font-family: var(--gc-font-code); margin-left: auto; flex-shrink: 0; }
.compact { gap: 8px; }
.compact .line-info { margin-left: 0; }
.match-text { font-family: var(--gc-font-code); color: var(--gc-text-primary); background: var(--gc-highlight-bg); padding: 0 4px; }
pre { margin: 0; padding: 4px 8px; background: var(--gc-surface-base); font: 11px/1.4 var(--gc-font-code); white-space: pre-wrap; word-break: break-all; }
code { font-family: inherit; }
:deep(mark) { background: var(--gc-highlight-bg); color: inherit; padding: 0 2px; border-radius: var(--gc-radius-xs); }
</style>
