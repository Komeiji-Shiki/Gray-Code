<script setup lang="ts">
/**
 * MermaidZoomModal - Mermaid 图表沉浸式全屏查看（缩放/平移/拖拽/键盘可达性）
 *
 * 从 MarkdownRenderer.vue 抽取：父组件仅保留 visible/content/title 触发状态，
 * 缩放、平移、焦点管理与 Esc 关闭等展示逻辑全部内聚于此。
 * 契约：props visible/content/title + emit close（等价于父组件原来的
 * isZoomModalVisible/zoomedContent/zoomTitle 状态与直接赋值关闭）。
 */
import { ref, watch, nextTick, onMounted, onUnmounted } from 'vue'
import { useI18n } from '@/i18n'

const props = defineProps<{
  visible: boolean
  /** 要展示的 Mermaid SVG 内容（innerHTML） */
  content: string
  /** 预览标题（保留字段，与拆分前 zoomTitle 语义一致） */
  title: string
}>()

const emit = defineEmits<{
  close: []
}>()

const { t } = useI18n()

// 放大浮层关闭按钮引用（用于打开时初始聚焦）
const zoomFloatingCloseRef = ref<HTMLButtonElement | null>(null)
// 打开浮层前的焦点元素（关闭后归还焦点）
let zoomPreviousFocus: HTMLElement | null = null

// 放大浮层：Esc 关闭 + 初始聚焦（键盘可达性）
function handleZoomKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && props.visible) {
    // 浮层打开期间 Esc 完全归本浮层所有：stopImmediatePropagation 会同时阻止 document 上
    // 其他 keydown 监听（如底层 Modal/Drawer 的全局 Esc 关闭）触发，避免「Esc 双关」；
    // 本监听仅在浮层打开时挂载（watch visible 注册/移除），不会误伤其他场景
    e.stopImmediatePropagation()
    emit('close')
  }
}

watch(() => props.visible, (visible) => {
  if (visible) {
    // 每次打开重置缩放状态（原父组件 handleMermaidClick 中 resetZoom() 的等价位置：
    // 打开瞬间即恢复默认缩放/平移，展示层无感知差异）
    resetZoom()
    // 记录打开前的焦点元素，浮层关闭后归还
    zoomPreviousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    document.addEventListener('keydown', handleZoomKeydown)
    nextTick(() => {
      // 初始聚焦：把焦点移入浮层关闭按钮，支持纯键盘关闭
      zoomFloatingCloseRef.value?.focus()
    })
  } else {
    document.removeEventListener('keydown', handleZoomKeydown)
    // 关闭后把焦点归还给浮层打开前的元素（若仍存在；不可聚焦元素的 focus() 为 no-op，无害）
    const previousFocus = zoomPreviousFocus
    zoomPreviousFocus = null
    if (previousFocus && previousFocus.isConnected) {
      try {
        previousFocus.focus()
      } catch {
        // 忽略：元素不可聚焦或已被移除
      }
    }
  }
})

// 缩放与平移状态
const zoomScale = ref(1)
const panOffset = ref({ x: 0, y: 0 })
const isDragging = ref(false)
const startPos = ref({ x: 0, y: 0 })

/**
 * 缩放控制
 */
function handleZoomIn() {
  zoomScale.value = Math.min(zoomScale.value + 0.2, 5)
}

function handleZoomOut() {
  zoomScale.value = Math.max(zoomScale.value - 0.2, 0.2)
}

function resetZoom() {
  zoomScale.value = 1
  panOffset.value = { x: 0, y: 0 }
}

/**
 * 滚轮缩放
 */
function handleWheel(event: WheelEvent) {
  event.preventDefault()
  const delta = event.deltaY > 0 ? -0.1 : 0.1
  const newScale = Math.min(Math.max(zoomScale.value + delta, 0.1), 10)
  zoomScale.value = newScale
}

/**
 * 鼠标拖拽平移
 */
function handleMouseDown(event: MouseEvent) {
  if (event.button !== 0) return // 仅左键拖拽
  isDragging.value = true
  startPos.value = { x: event.clientX - panOffset.value.x, y: event.clientY - panOffset.value.y }
  
  // 防止文本选中
  event.preventDefault()
}

function handleMouseMove(event: MouseEvent) {
  if (!isDragging.value) return
  panOffset.value = {
    x: event.clientX - startPos.value.x,
    y: event.clientY - startPos.value.y
  }
}

function handleMouseUp() {
  isDragging.value = false
}

// 监听全局鼠标松开，防止在外部松开后还在拖拽
onMounted(() => {
  window.addEventListener('mouseup', handleMouseUp)
})

onUnmounted(() => {
  window.removeEventListener('mouseup', handleMouseUp)
  document.removeEventListener('keydown', handleZoomKeydown)
})
</script>

<template>
  <Teleport to="body">
    <Transition name="fade">
      <div v-if="visible" role="dialog" aria-modal="true" class="mermaid-zoom-overlay">
        <!-- 悬浮关闭按钮 -->
        <button ref="zoomFloatingCloseRef" class="zoom-floating-close" @click="emit('close')" :title="t('components.common.markdownRenderer.mermaid.closePreview')">
          <i class="codicon codicon-close"></i>
        </button>

        <!-- 内容区 -->
        <div 
          class="zoom-body" 
          @wheel="handleWheel"
          @mousedown="handleMouseDown"
          @mousemove="handleMouseMove"
          :style="{ cursor: isDragging ? 'grabbing' : 'grab' }"
        >
          <div 
            class="zoomed-mermaid-content" 
            v-html="content" 
            :style="{ 
              transform: `translate(${panOffset.x}px, ${panOffset.y}px) scale(${zoomScale})`
            }"
          ></div>
        </div>

        <!-- 悬浮控制栏 -->
        <div class="zoom-controls">
          <div class="zoom-actions">
            <div class="zoom-btn-group">
              <button class="zoom-action-btn icon-only" @click="handleZoomOut" :title="t('components.common.markdownRenderer.mermaid.zoomOut')">
                <i class="codicon codicon-zoom-out"></i>
              </button>
              <button class="zoom-action-btn text-btn" @click="resetZoom" :title="t('components.common.markdownRenderer.mermaid.resetZoom')">
                {{ Math.round(zoomScale * 100) }}%
              </button>
              <button class="zoom-action-btn icon-only" @click="handleZoomIn" :title="t('components.common.markdownRenderer.mermaid.zoomIn')">
                <i class="codicon codicon-zoom-in"></i>
              </button>
            </div>
            <div class="zoom-divider"></div>
            <span class="zoom-status-tip">{{ t('components.common.markdownRenderer.mermaid.tip') }}</span>
            <div class="zoom-divider"></div>
            <button class="zoom-action-btn close-btn" @click="emit('close')" :title="t('components.common.markdownRenderer.mermaid.closePreview')">
              <i class="codicon codicon-close"></i>
              {{ t('components.common.markdownRenderer.mermaid.closePreview') }}
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
/* 沉浸式全屏查看样式 */
.mermaid-zoom-overlay {
  position: fixed;
  top: 0;
  left: 0;
  width: 100vw;
  height: 100vh;
  z-index: 9999;
  background: var(--vscode-editor-background);
  display: flex;
  flex-direction: column;
}

.zoom-floating-close {
  position: absolute;
  top: 20px;
  right: 20px;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: rgba(128, 128, 128, 0.2);
  border: 1px solid var(--vscode-panel-border, rgba(255, 255, 255, 0.1));
  color: var(--vscode-foreground);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  z-index: 10001;
  backdrop-filter: blur(8px);
  transition: all 0.2s;
}

.zoom-floating-close:hover {
  background: var(--vscode-toolbar-hoverBackground);
  transform: rotate(90deg);
}

.zoom-body {
  flex: 1;
  width: 100%;
  height: 100%;
  overflow: hidden; /* 拖拽模式不需要原生滚动条 */
  position: relative;
  user-select: none;
}

.zoomed-mermaid-content {
  display: flex;
  justify-content: center;
  align-items: center;
  width: 100%;
  height: 100%;
  transition: transform 0.05s linear; /* 缩放和平移需要平滑感 */
  pointer-events: none; /* 让事件透传给 zoom-body 处理 */
}

.zoomed-mermaid-content :deep(svg) {
  max-width: none !important;
  max-height: none !important;
  width: auto !important;
  height: auto !important;
}

.zoom-controls {
  position: fixed;
  bottom: 30px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 10000;
  pointer-events: none;
}

.zoom-actions {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 6px 6px 6px 16px;
  border-radius: 30px;
  background: var(--vscode-sideBar-background);
  border: 1px solid var(--vscode-panel-border);
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
  pointer-events: auto;
  backdrop-filter: blur(12px);
}

.zoom-btn-group {
  display: flex;
  align-items: center;
  background: var(--vscode-editor-background);
  border-radius: 20px;
  border: 1px solid var(--vscode-panel-border);
  overflow: hidden;
}

.zoom-divider {
  width: 1px;
  height: 20px;
  background: var(--vscode-panel-border);
}

.zoom-status-tip {
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  padding-right: 12px;
}

.zoom-action-btn {
  height: 32px;
  border: none;
  background: transparent;
  color: var(--vscode-foreground);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.2s;
}

.zoom-action-btn.icon-only {
  width: 36px;
}

.zoom-action-btn.text-btn {
  padding: 0 10px;
  font-size: 12px;
  font-family: var(--vscode-editor-font-family, monospace);
  min-width: 50px;
  border-left: 1px solid var(--vscode-panel-border);
  border-right: 1px solid var(--vscode-panel-border);
}

.zoom-action-btn:hover {
  background: var(--vscode-toolbar-hoverBackground);
}

.zoom-action-btn.close-btn {
  padding: 0 16px;
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  border-radius: 16px;
  font-weight: 500;
  margin-left: 4px;

  /* 保证“关闭预览”始终单行显示 */
  white-space: nowrap;
  word-break: keep-all;
  flex-shrink: 0;
  gap: 6px;
}

.zoom-action-btn.close-btn:hover {
  background: var(--vscode-button-hoverBackground);
}

.zoom-action-btn.close-btn i {
  font-size: 14px;
}

/* 过渡动画 */
.fade-enter-active, .fade-leave-active {
  transition: opacity 0.3s ease;
}
.fade-enter-from, .fade-leave-to {
  opacity: 0;
}

/* 增加 Mermaid 文字对比度：跟随主题前景色 + 主题描边（Meme 字体风格），
 * 描边保证任何背景色下都清晰（与 MarkdownRenderer 内联 mermaid 的口径一致） */
.zoomed-mermaid-content :deep(text),
.zoomed-mermaid-content :deep(span) {
  fill: var(--vscode-foreground, #ffffff) !important;
  color: var(--vscode-foreground, #ffffff) !important;
  font-weight: 600 !important;
}

body.vscode-dark .zoomed-mermaid-content :deep(text),
body.vscode-dark .zoomed-mermaid-content :deep(span) {
  text-shadow:
    -1px -1px 0 #000,
     1px -1px 0 #000,
    -1px  1px 0 #000,
     1px  1px 0 #000,
     0px  0px 4px rgba(0,0,0,0.8) !important;
}

body.vscode-light .zoomed-mermaid-content :deep(text),
body.vscode-light .zoomed-mermaid-content :deep(span) {
  text-shadow:
    -1px -1px 0 #fff,
     1px -1px 0 #fff,
    -1px  1px 0 #fff,
     1px  1px 0 #fff,
     0px  0px 4px rgba(255,255,255,0.9) !important;
}

/* 节点样式微调 */
.zoomed-mermaid-content :deep(.node) {
  stroke-width: 1.5px !important;
}

/* 连线文字处理 */
.zoomed-mermaid-content :deep(.edgeLabel) {
  background-color: transparent !important;
  padding: 0 4px;
}

.mermaid-zoom-overlay {
  background: var(--vscode-editor-background);
  background-image: radial-gradient(var(--vscode-panel-border) 1px, transparent 1px);
  background-size: 20px 20px;
}
</style>
