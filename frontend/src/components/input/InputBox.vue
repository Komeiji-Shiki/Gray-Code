<script setup lang="ts">
/**
 * InputBox - 文本输入框
 * 支持文本和上下文徽章穿插的混合输入
 * 使用 contenteditable div 实现
 */

import { MESSAGE_NAMES } from '@shared/protocol'
import { ref, watch, nextTick, onMounted, onBeforeUnmount, computed } from 'vue'
import { useI18n } from '../../i18n'
import type { PromptContextItem } from '../../types/promptContext'
import type { EditorNode } from '../../types/editorNode'
import { getPlainText } from '../../types/editorNode'
import { getFileIcon } from '../../utils/fileIcons'
import { extractVscodeDropItems } from '../../utils/vscodeDragDrop'
import { sendToExtension, onExtensionCommand } from '../../utils/vscode'
import { createContextChipElement } from './inputBox/ContextChipFactory'
import { extractNodesFromEditor, renderNodesToDOM } from './inputBox/useEditorNodesDom'
import {
  getCaretTextOffset,
  getDomPointFromTextOffset,
  insertLineBreakAtCaret,
  insertPlainTextAsSingleUndo,
  insertTextAtCaret,
  getRangeInEditor,
  replaceTextRangeByOffsets
} from './inputBox/useEditorCaret'
import {
  removeContextBackward,
  removeContextForward,
  removeLineBreakBackward,
  removeLineBreakForward
} from './inputBox/useEditorDeletion'
import { useAtTrigger } from './inputBox/useAtTrigger'

const { t } = useI18n()

const props = withDefaults(defineProps<{
  /** 编辑器节点数组（文本和上下文徽章混合） */
  nodes: EditorNode[]
  disabled?: boolean
  placeholder?: string
  maxLength?: number
  minRows?: number
  maxRows?: number
  /** Enter 键行为：true=Enter 发送（Shift+Enter 换行）；false=Enter 换行 */
  submitOnEnter?: boolean
}>(), {
  submitOnEnter: true
})

const emit = defineEmits<{
  /** 节点数组更新 */
  'update:nodes': [nodes: EditorNode[]]
  /** 删除一个上下文徽章（点击 chip 上的删除按钮） */
  'remove-context': [id: string]
  send: []
  'composition-start': []
  'composition-end': []
  paste: [files: File[]]
  /** contenteditable 内部拖拽文件/URI：交给父层解析为工作区相对路径 */
  'drop-file-items': [items: string[], insertAsTextPath: boolean, dragMeta?: { shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean }]
  'trigger-at-picker': [query: string, triggerPosition: number]
  'close-at-picker': []
  'at-query-change': [query: string]
  'at-picker-keydown': [key: string]
  /** 点击徽章：交给父层决定如何打开预览 */
  'open-context': [ctx: PromptContextItem]
}>()

const editorRef = ref<HTMLDivElement>()
const currentRows = ref(props.minRows || 4)

// 调整高度时的检测状态
const cachedLineHeight = ref(0)
const manualEditorHeight = ref<number | null>(null)

// 拖拽状态
const isDragOver = ref(false)


// ========== 自定义撤销/重做历史栈 ==========
// VS Code Webview 中浏览器原生 undo 栈不可靠（execCommand 产生的记录常丢失），
// 因此自行维护历史快照，接管 Ctrl+Z / Ctrl+Y。
interface HistoryEntry {
  nodes: EditorNode[]
  caretOffset: number
}
const history = ref<HistoryEntry[]>([])
const historyIndex = ref(-1)
const MAX_HISTORY = 100
// 滚动条状态
const thumbHeight = ref(0)
const thumbTop = ref(0)
const showScrollbar = ref(false)
let isDragging = false
let startY = 0
let startScrollTop = 0
let isResizingEditor = false
let resizeStartY = 0
let resizeStartHeight = 0

// @ 触发状态
const atTrigger = useAtTrigger({
  onOpen: (query, triggerPosition) => emit('trigger-at-picker', query, triggerPosition),
  onClose: () => emit('close-at-picker'),
  onQueryChange: (query) => emit('at-query-change', query),
  onPickerKeydown: (key) => emit('at-picker-keydown', key)
})

// Some contexts may be inserted imperatively (e.g. after async file read).
// During that brief window, the chip exists in DOM but not yet in props.nodes.
const transientContexts = new Map<string, PromptContextItem>()

// 输入状态标记
let isInputting = false

// ========== height + overlay scrollbar ==========

function ensureCaretVisible(editor: HTMLElement, paddingPx: number = 8) {
  // Only adjust scroll when the editor is actively focused; avoid surprising jumps.
  if (document.activeElement !== editor) return

  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0) return

  const range = selection.getRangeAt(0)
  if (!range.collapsed) return
  if (!editor.contains(range.startContainer)) return

  // If the editor doesn't overflow, nothing to do.
  if (editor.scrollHeight <= editor.clientHeight) return

  let caretRect = range.getBoundingClientRect()
  // Some browsers may return an empty rect for a collapsed range; fall back to client rects.
  if (
    caretRect.width === 0 &&
    caretRect.height === 0 &&
    caretRect.top === 0 &&
    caretRect.left === 0
  ) {
    const rects = range.getClientRects()
    if (rects.length === 0) return
    caretRect = rects[0]
  }

  const editorRect = editor.getBoundingClientRect()
  const visibleTop = editorRect.top + paddingPx
  const visibleBottom = editorRect.bottom - paddingPx

  let nextScrollTop = editor.scrollTop
  if (caretRect.top < visibleTop) {
    nextScrollTop -= (visibleTop - caretRect.top)
  } else if (caretRect.bottom > visibleBottom) {
    nextScrollTop += (caretRect.bottom - visibleBottom)
  } else {
    return
  }

  const maxScrollTop = Math.max(0, editor.scrollHeight - editor.clientHeight)
  nextScrollTop = Math.min(Math.max(0, nextScrollTop), maxScrollTop)

  if (Math.abs(nextScrollTop - editor.scrollTop) >= 1) {
    editor.scrollTop = nextScrollTop
  }
}

function getEditorHeightBounds(editor: HTMLElement) {
  if (!cachedLineHeight.value) {
    cachedLineHeight.value = parseInt(getComputedStyle(editor).lineHeight) || 20
  }

  const minRows = props.minRows || 4
  const minHeight = minRows * cachedLineHeight.value
  const maxHeight = Math.max(minHeight, Math.floor(window.innerHeight * 0.72))
  return { minHeight, maxHeight }
}

function adjustHeight() {
  if (!editorRef.value) return

  const editor = editorRef.value
  const minRows = props.minRows || 4
  const maxRows = props.maxRows || 8

  if (!cachedLineHeight.value) {
    cachedLineHeight.value = parseInt(getComputedStyle(editor).lineHeight) || 20
  }

  const lineHeight = cachedLineHeight.value
  const minHeight = minRows * lineHeight
  const prevScrollTop = editor.scrollTop
  const prevWasAtBottom = editor.scrollTop + editor.clientHeight >= editor.scrollHeight - 2

  if (manualEditorHeight.value !== null) {
    const { minHeight: manualMinHeight, maxHeight } = getEditorHeightBounds(editor)
    const height = Math.min(Math.max(manualEditorHeight.value, manualMinHeight), maxHeight)
    manualEditorHeight.value = height
    editor.style.maxHeight = `${maxHeight}px`
    editor.style.height = `${height}px`
    currentRows.value = Math.max(minRows, Math.round(height / lineHeight))
    nextTick(() => {
      updateScrollbar()
      ensureCaretVisible(editor)
    })
    return
  }

  // 每次先恢复 auto 再测量真实内容高度。固定高度下的 scrollHeight 会掩盖
  // 删除内容后的收缩，导致输入框只能变高、不能变矮。
  editor.style.maxHeight = `${maxRows * lineHeight}px`
  editor.style.height = 'auto'

  const contentHeight = editor.scrollHeight
  const targetHeight = Math.max(contentHeight, minHeight)
  const rows = Math.min(Math.max(Math.ceil(targetHeight / lineHeight), minRows), maxRows)
  editor.style.height = `${rows * lineHeight}px`
  currentRows.value = rows

  // Preserve internal scroll position; without this, changing height can reset scrollTop and make
  // the caret appear to jump upward when the editor is overflowing (maxRows reached).
  const maxScrollTop = Math.max(0, editor.scrollHeight - editor.clientHeight)
  if (prevWasAtBottom) {
    editor.scrollTop = editor.scrollHeight
  } else {
    editor.scrollTop = Math.min(prevScrollTop, maxScrollTop)
  }

  nextTick(() => {
    updateScrollbar()
    ensureCaretVisible(editor)
  })
}

function applyManualEditorHeight(height: number) {
  const editor = editorRef.value
  if (!editor) return

  const { minHeight, maxHeight } = getEditorHeightBounds(editor)
  manualEditorHeight.value = Math.min(Math.max(height, minHeight), maxHeight)
  adjustHeight()
}

function handleEditorResizeMouseDown(e: MouseEvent) {
  const editor = editorRef.value
  if (!editor) return

  isResizingEditor = true
  resizeStartY = e.clientY
  resizeStartHeight = editor.getBoundingClientRect().height || editor.clientHeight || parseFloat(editor.style.height) || 80
  document.addEventListener('mousemove', handleEditorResizeMouseMove)
  document.addEventListener('mouseup', handleEditorResizeMouseUp)
  e.preventDefault()
}

function handleEditorResizeMouseMove(e: MouseEvent) {
  if (!isResizingEditor) return
  // 输入区固定在底部，向上拖动时增加高度，向下拖动时减小高度。
  applyManualEditorHeight(resizeStartHeight + resizeStartY - e.clientY)
}

function handleEditorResizeMouseUp() {
  isResizingEditor = false
  document.removeEventListener('mousemove', handleEditorResizeMouseMove)
  document.removeEventListener('mouseup', handleEditorResizeMouseUp)
}

function resetEditorHeight() {
  manualEditorHeight.value = null
  if (editorRef.value) {
    editorRef.value.style.maxHeight = ''
  }
  adjustHeight()
}

function handleEditorResizeKeydown(e: KeyboardEvent) {
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    const editor = editorRef.value
    if (!editor) return
    const currentHeight = manualEditorHeight.value ?? editor.getBoundingClientRect().height
    applyManualEditorHeight(currentHeight + (e.key === 'ArrowUp' ? 20 : -20))
    e.preventDefault()
  } else if (e.key === 'Home') {
    resetEditorHeight()
    e.preventDefault()
  }
}

function updateScrollbar() {
  if (!editorRef.value) return

  const editor = editorRef.value
  const scrollHeight = editor.scrollHeight
  const clientHeight = editor.clientHeight
  const scrollTop = editor.scrollTop

  showScrollbar.value = scrollHeight > clientHeight
  if (!showScrollbar.value) return

  const ratio = clientHeight / Math.max(1, scrollHeight)
  thumbHeight.value = Math.max(24, clientHeight * ratio)

  const maxScrollTop = Math.max(1, scrollHeight - clientHeight)
  const maxThumbTop = Math.max(1, clientHeight - thumbHeight.value)
  thumbTop.value = (scrollTop / maxScrollTop) * maxThumbTop
}

function handleScroll() {
  updateScrollbar()
}

function handleThumbMouseDown(e: MouseEvent) {
  if (!editorRef.value) return

  isDragging = true
  startY = e.clientY
  startScrollTop = editorRef.value.scrollTop

  document.addEventListener('mousemove', handleMouseMove)
  document.addEventListener('mouseup', handleMouseUp)

  e.preventDefault()
}

function handleMouseMove(e: MouseEvent) {
  if (!isDragging || !editorRef.value) return

  const editor = editorRef.value
  const deltaY = e.clientY - startY
  const scrollHeight = editor.scrollHeight
  const clientHeight = editor.clientHeight
  const maxScrollTop = scrollHeight - clientHeight
  const maxThumbTop = clientHeight - thumbHeight.value

  const scrollDelta = (deltaY / maxThumbTop) * maxScrollTop
  editor.scrollTop = startScrollTop + scrollDelta
}

function handleMouseUp() {
  isDragging = false
  document.removeEventListener('mousemove', handleMouseMove)
  document.removeEventListener('mouseup', handleMouseUp)
}

const thumbStyle = computed(() => ({
  height: `${thumbHeight.value}px`,
  top: `${thumbTop.value}px`
}))

// ========== nodes <-> DOM ==========

function getContextIcon(ctx: PromptContextItem): { class: string; isFileIcon: boolean } {
  if (ctx.type === 'file' && ctx.filePath) {
    return { class: getFileIcon(ctx.filePath), isFileIcon: true }
  }
  switch (ctx.type) {
    case 'snippet':
      return { class: 'codicon codicon-code', isFileIcon: false }
    case 'text':
    default:
      return { class: 'codicon codicon-note', isFileIcon: false }
  }
}

function handleContextClick(ctx: PromptContextItem) {
  emit('open-context', ctx)
}

function handleContextMouseEnter(ctx: PromptContextItem) {
  if (ctx.isTextContent === false) {
    hoveredContextId.value = null
    previewContext.value = null
    if (hoverTimer) {
      clearTimeout(hoverTimer)
      hoverTimer = null
    }
    return
  }
  hoveredContextId.value = ctx.id
  if (hoverTimer) clearTimeout(hoverTimer)
  hoverTimer = setTimeout(() => {
    previewContext.value = ctx
  }, 300)
}

function handleContextMouseLeave() {
  hoveredContextId.value = null
  if (hoverTimer) {
    clearTimeout(hoverTimer)
    hoverTimer = null
  }
  hidePreviewTimer = setTimeout(() => {
    if (!hoveredContextId.value) {
      previewContext.value = null
    }
  }, 100)
}

function handleRemoveContext(id: string) {
  if (previewContext.value?.id === id) previewContext.value = null
  if (hoveredContextId.value === id) hoveredContextId.value = null
  if (hoverTimer) {
    clearTimeout(hoverTimer)
    hoverTimer = null
  }

  emit('remove-context', id)
}

function editorNodesEqual(left: EditorNode[], right: EditorNode[]): boolean {
  if (left.length !== right.length) return false

  return left.every((node, index) => {
    const other = right[index]
    if (!other || node.type !== other.type) return false
    if (node.type === 'text' && other.type === 'text') return node.text === other.text
    if (node.type === 'context' && other.type === 'context') return node.context.id === other.context.id
    return false
  })
}

function renderNodesToDom() {
  if (!editorRef.value) return

  renderNodesToDOM(editorRef.value, props.nodes, {
    getContextIcon,
    chipHandlers: {
      onRemove: handleRemoveContext,
      onMouseEnter: handleContextMouseEnter,
      onMouseLeave: handleContextMouseLeave,
      onClick: handleContextClick
    }
  })
  // 记录本次渲染的 nodes 轻量指纹，供 watch 跳过无谓的全量 DOM 提取比对
  lastRenderedNodesFingerprint = getNodesFingerprint(props.nodes)
}

// ========== input / key / IME ==========

function pushHistory(nodes: EditorNode[], caretOffset: number) {
  if (historyIndex.value < history.value.length - 1) {
    history.value = history.value.slice(0, historyIndex.value + 1)
  }
  // 容量上限：追加前先淘汰最旧条目，避免 push 后溢出（shift 后 historyIndex 越界）
  if (history.value.length >= MAX_HISTORY) {
    history.value.shift()
  }
  history.value.push({ nodes: JSON.parse(JSON.stringify(nodes)), caretOffset })
  // 新条目总是栈顶，historyIndex 直接指向末尾，避免 shift 后索引漂移
  historyIndex.value = history.value.length - 1
}

function undo() {
  if (historyIndex.value <= 0) return
  historyIndex.value--
  restoreHistoryEntry(history.value[historyIndex.value])
}

function redo() {
  if (historyIndex.value >= history.value.length - 1) return
  historyIndex.value++
  restoreHistoryEntry(history.value[historyIndex.value])
}

function restoreHistoryEntry(entry: HistoryEntry) {
  if (!editorRef.value) return
  isInputting = true
  emit('update:nodes', entry.nodes)
  nextTick(() => {
    if (!editorRef.value) { isInputting = false; return }
    renderNodesToDom()
    const point = getDomPointFromTextOffset(editorRef.value, entry.caretOffset)
    const range = document.createRange()
    range.setStart(point.container, point.offset)
    range.collapse(true)
    const selection = window.getSelection()
    if (selection) {
      selection.removeAllRanges()
      selection.addRange(range)
    }
    adjustHeight()
    isInputting = false
  })
}

function handleInput() {
  const editor = editorRef.value
  if (!editor) return

  isInputting = true

  const newNodes = extractNodesFromEditor(editor, {
    knownNodes: props.nodes,
    transientContexts
  })

  const textContent = getPlainText(newNodes)
  const cursorPos = getCaretTextOffset(editor)

  atTrigger.onTextChanged(textContent, cursorPos)

  emit('update:nodes', newNodes)
  // 输入路径 DOM 已由浏览器直接编辑，newNodes 即 DOM 的真实状态（props 将同步为相同值）：
  // 必须在此同步指纹——watch(props.nodes) 触发时 isInputting 仍为 true 会被短路跳过，
  // 指纹若长期停留在初始值，后续外部清空（发送）时 getNodesFingerprint([]) === '0'
  // 与陈旧指纹碰撞，跳过 DOM 重建导致残留旧文本（placeholder 与文本叠放）。
  lastRenderedNodesFingerprint = getNodesFingerprint(newNodes)
  pushHistory(newNodes, cursorPos)

  nextTick(() => {
    isInputting = false
    adjustHeight()
  })
}

function handleKeydown(e: KeyboardEvent) {
  // IME 合成回车（确认候选词）不应触发发送逻辑
  if (e.isComposing || e.keyCode === 229) {
    return
  }
  const editor = editorRef.value
  if (!editor) return

  if (atTrigger.handleKeydown(e)) return

  // 自定义撤销/重做：接管浏览器原生 undo（VS Code Webview 中原生 undo 不可靠）
  const isMod = e.ctrlKey || e.metaKey
  if (isMod && !e.shiftKey && e.key.toLowerCase() === 'z') {
    e.preventDefault()
    undo()
    return
  }
  if (isMod && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) {
    e.preventDefault()
    redo()
    return
  }

  const onContextRemoved = (removedId: string) => {
    if (previewContext.value?.id === removedId) previewContext.value = null
    if (hoveredContextId.value === removedId) hoveredContextId.value = null
  }

  if ((e.key === 'Backspace' || e.key === 'Delete') && !e.ctrlKey && !e.altKey && !e.metaKey) {
    const handled = e.key === 'Backspace'
      ? (removeContextBackward(editor, onContextRemoved) || removeLineBreakBackward(editor))
      : (removeContextForward(editor, onContextRemoved) || removeLineBreakForward(editor))

    if (handled) {
      e.preventDefault()
      handleInput()
      return
    }
  }

  if (e.key === 'Enter' && e.shiftKey && !e.ctrlKey && !e.altKey) {
    e.preventDefault()
    const br = insertLineBreakAtCaret(editor)
    if (br.ok && !br.inputFired) handleInput()
    return
  }

  if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
    if (props.submitOnEnter) {
      e.preventDefault()
      emit('send')
      return
    }

    e.preventDefault()
    const br = insertLineBreakAtCaret(editor)
    if (br.ok && !br.inputFired) handleInput()
    return
  }
}

function handleCompositionStart() {
  emit('composition-start')
}

function handleCompositionEnd() {
  emit('composition-end')
}

function handlePaste(e: ClipboardEvent) {
  const clipboardData = e.clipboardData
  if (!clipboardData) return

  const files: File[] = []
  for (let i = 0; i < clipboardData.items.length; i++) {
    const item = clipboardData.items[i]
    if (item.kind === 'file') {
      const file = item.getAsFile()
      if (file) files.push(file)
    }
  }

  if (files.length > 0) {
    e.preventDefault()
    emit('paste', files)
    return
  }

  const editor = editorRef.value
  // 纯文本粘贴：拦截默认插入，一次性写入原生 undo 栈（Ctrl+Z 整体撤销本次粘贴）。
  // 不切换 contenteditable 属性：切换编辑宿主会重建 Chromium 的原生 undo 栈，
  // 粘贴记录随恢复动作一并销毁。多行文本必须走 insertHTML + 带 data-lim-break
  // 标记的 <br>：insertText 会把 \n 转成裸 <br>，被 extractNodesFromEditor 吞掉换行。
  const text = clipboardData.getData('text/plain').replace(/\r\n?/g, '\n')
  if (!editor || !text) return

  e.preventDefault()
  const result = insertPlainTextAsSingleUndo(editor, text)
  // execCommand 路径会自动派发 input 事件（handleInput 同步状态）；
  // 手动 DOM 回退路径不派发，需要手动同步。
  if (result.ok && !result.inputFired) handleInput()
}

// ========== drag & drop ==========

function handleDragEnter(e: DragEvent) {
  e.preventDefault()
  e.stopPropagation()
  isDragOver.value = true
}

function handleDragLeave(e: DragEvent) {
  e.preventDefault()
  e.stopPropagation()

  const rect = editorRef.value?.getBoundingClientRect()
  if (rect) {
    const x = e.clientX
    const y = e.clientY
    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
      isDragOver.value = false
    }
  }
}

function handleDragOver(e: DragEvent) {
  e.preventDefault()
  e.stopPropagation()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
  isDragOver.value = true
}

function handleDrop(e: DragEvent) {
  e.preventDefault()
  e.stopPropagation()
  isDragOver.value = false

  const dt = e.dataTransfer
  if (!dt) return

  const insertAsTextPath = e.ctrlKey && e.shiftKey
  const items = extractVscodeDropItems(dt).map(i => i.uriOrPath)
  if (items.length > 0) {
    emit('drop-file-items', items, insertAsTextPath, {
      shiftKey: !!e.shiftKey,
      ctrlKey: !!e.ctrlKey,
      altKey: !!e.altKey,
      metaKey: !!e.metaKey
    })
  }
}

// ========== 焦点跟踪与恢复 ==========
// 为什么：关闭 diff 标签页会把键盘焦点从 webview 收走（VSCode 行为，
// tabGroups.close 的 preserveFocus 也拦不住），正在输入框打字的用户会失焦。
// 怎么做：输入框把 focus/blur 状态上报给扩展端；扩展端关闭 diff 后若输入框
// 此前持有焦点，会归还 webview 焦点并推送 chat.restoreInputFocus 命令，
// 这里收到命令后把光标放回输入框，用户可以无缝继续打字。

function postChatInputFocusState(focused: boolean) {
  sendToExtension(MESSAGE_NAMES['chatInput.focusState'], { focused }).catch(() => {
    // 状态上报失败不影响输入功能
  })
}

function handleEditorFocus() {
  postChatInputFocusState(true)
}

function handleEditorBlur() {
  postChatInputFocusState(false)
}

let disposeRestoreFocusListener: (() => void) | null = null

// ========== public methods ==========

function focus() {
  editorRef.value?.focus()
}

function closeAtPicker() {
  atTrigger.reset()
}

function insertFilePath(_path: string) {
  replaceAtTriggerWithText('')
}

function replaceAtTriggerWithText(replacement: string = '') {
  if (!editorRef.value) return

  const replaced = atTrigger.replaceAtTrigger(editorRef.value, replacement, {
    getCaretTextOffset,
    replaceTextRangeByOffsets
  })

  if (!replaced) return

  handleInput()
}

function getAtTriggerPosition(): number | null {
  return atTrigger.getAtTriggerPosition()
}

function insertPathsAsAtText(files: { path: string; isDirectory: boolean }[]) {
  if (!files || files.length === 0 || !editorRef.value) return

  const ensureTrailingSlash = (p: string) => (p.endsWith('/') ? p : `${p}/`)
  const text = files
    .map(f => {
      const p = f.isDirectory ? ensureTrailingSlash(f.path) : f.path
      return ` @${p} `
    })
    .join('')

  if (text) {
    const result = insertTextAtCaret(editorRef.value, text)
    if (result.ok && !result.inputFired) handleInput()
  }
}

function insertContextAtCaret(context: PromptContextItem): boolean {
  if (!editorRef.value) return false

  transientContexts.set(context.id, context)

  const range = getRangeInEditor(editorRef.value)
  const selection = window.getSelection()
  if (!range || !selection) return false

  range.deleteContents()

  const chip = createContextChipElement(context, getContextIcon(context).class, {
    onRemove: handleRemoveContext,
    onMouseEnter: handleContextMouseEnter,
    onMouseLeave: handleContextMouseLeave,
    onClick: handleContextClick
  })

  range.insertNode(chip)

  const after = document.createTextNode('\u200B')
  chip.after(after)

  const prev = chip.previousSibling
  if (!prev || prev.nodeType === Node.ELEMENT_NODE) {
    chip.before(document.createTextNode('\u200B'))
  }

  const newRange = document.createRange()
  newRange.setStart(after, 1)
  newRange.collapse(true)
  selection.removeAllRanges()
  selection.addRange(newRange)

  handleInput()
  return true
}

// 输入框是否包含有效内容（有 context 节点或非空文本）。
// 用于占位符文本显示；is-empty 样式保持基于 props.nodes.length（含空白文本节点时
// 视为非空——纯空白也应隐藏占位符浮层，避免与真实内容叠加）。
const hasContent = computed(() =>
  props.nodes.length > 0 && (
    props.nodes.some(n => n.type === 'context') ||
    props.nodes.some(n => n.type === 'text' && n.text.trim())
  )
)

// 输入框占位符：有内容时不显示 placeholder
const placeholderText = computed(() => {
  if (hasContent.value) return ''
  return props.placeholder || t('components.input.placeholderHint')
})

// 悬浮预览状态
const hoveredContextId = ref<string | null>(null)
const previewContext = ref<PromptContextItem | null>(null)
let hoverTimer: ReturnType<typeof setTimeout> | null = null
// 离开后延迟隐藏预览的定时器（onBeforeUnmount 统一清理）
let hidePreviewTimer: ReturnType<typeof setTimeout> | null = null

// 上次渲染到 DOM 的 nodes 轻量指纹（覆盖全部节点）：
// props.nodes 每键击都会更新，但 DOM 通常已同步（用户输入直接落 DOM），
// 先用指纹判断「是否可能不同步」，相同则跳过全量 extractNodesFromEditor DOM 遍历。
// 覆盖全部节点（类型 + 内容）而不是「长度 + 首尾」：中间文本/徽章变化而长度与
// 首尾不变时，粗粒度指纹会误判为相同并跳过 DOM 重建，残留陈旧内容。
let lastRenderedNodesFingerprint = ''
function getNodesFingerprint(nodes: EditorNode[]): string {
  const len = nodes.length
  if (len === 0) return '0'
  // 内容直接拼接即可：输入正文量级远小于 DOM 遍历开销，且 getPlainText 已每键击 O(n)
  let fp = `${len}:`
  for (const n of nodes) {
    fp += n.type === 'context' ? `@${n.context.id}` : n.text
    fp += '|'
  }
  return fp
}

function truncatePreview(content: string, maxLines = 10, maxChars = 500): string {
  const lines = content.split('\n').slice(0, maxLines)
  let result = lines.join('\n')
  if (result.length > maxChars) {
    result = result.slice(0, maxChars) + '...'
  } else if (content.split('\n').length > maxLines) {
    result += '\n...'
  }
  return result
}

watch(() => props.nodes, () => {
  if (previewContext.value) {
    const stillExists = props.nodes.some(n => n.type === 'context' && n.context.id === previewContext.value!.id)
    if (!stillExists) previewContext.value = null
  }
  if (hoveredContextId.value) {
    const stillHoveredExists = props.nodes.some(n => n.type === 'context' && n.context.id === hoveredContextId.value)
    if (!stillHoveredExists) hoveredContextId.value = null
  }

  for (const id of Array.from(transientContexts.keys())) {
    if (props.nodes.some(n => n.type === 'context' && n.context.id === id)) {
      transientContexts.delete(id)
    }
  }

  if (!isInputting && editorRef.value) {
    // 轻量指纹相同（全部节点内容）说明 DOM 与 nodes 大概率已同步，
    // 跳过全量 DOM 提取比对，避免每键击都遍历整棵编辑器 DOM。
    // 例外：props.nodes 为空（发送清空）时必须强制提取比对——空数组指纹恒为 '0'，
    // 而 lastRenderedNodesFingerprint 在用户直接编辑路径下由 handleInput 维护，
    // 若历史渲染从未发生（指纹仍为初始 '0'）会碰撞跳过重建，DOM 残留旧内容。
    if (props.nodes.length === 0 || getNodesFingerprint(props.nodes) !== lastRenderedNodesFingerprint) {
      const domNodes = extractNodesFromEditor(editorRef.value, {
        knownNodes: props.nodes,
        transientContexts
      })
      // 受控 contenteditable 只有在外部状态确实不同步时才重建 DOM。
      // 无意义的 innerHTML 重建会清空浏览器原生的复制、粘贴和撤销历史。
      if (!editorNodesEqual(domNodes, props.nodes)) {
        renderNodesToDom()
      } else {
        // DOM 已与 nodes 同步（浏览器直接编辑路径）：同步指纹，
        // 避免下次外部状态变化（如发送清空）时指纹碰撞而跳过必要重建。
        lastRenderedNodesFingerprint = getNodesFingerprint(props.nodes)
      }
    }
  }

  nextTick(() => adjustHeight())
})

onMounted(() => {
  nextTick(() => {
    renderNodesToDom()
    adjustHeight()
    pushHistory(props.nodes, 0)
  })

  // 扩展端关闭 diff 标签归还焦点后，把光标放回输入框。
  // rAF 双保险：等 webview iframe 真正拿到 workbench 焦点后再聚焦 DOM。
  disposeRestoreFocusListener = onExtensionCommand('chat.restoreInputFocus', () => {
    nextTick(() => {
      requestAnimationFrame(() => editorRef.value?.focus())
    })
  })
})

onBeforeUnmount(() => {
  document.removeEventListener('mousemove', handleMouseMove)
  document.removeEventListener('mouseup', handleMouseUp)
  document.removeEventListener('mousemove', handleEditorResizeMouseMove)
  document.removeEventListener('mouseup', handleEditorResizeMouseUp)
  disposeRestoreFocusListener?.()
  disposeRestoreFocusListener = null
  // 清理隐藏预览定时器，避免组件卸载后仍写入状态
  if (hoverTimer) {
    clearTimeout(hoverTimer)
    hoverTimer = null
  }
  if (hidePreviewTimer) {
    clearTimeout(hidePreviewTimer)
    hidePreviewTimer = null
  }
})

defineExpose({
  focus,
  closeAtPicker,
  insertFilePath,
  replaceAtTriggerWithText,
  insertContextAtCaret,
  insertPathsAsAtText,
  getAtTriggerPosition
})
</script>

<template>
  <div class="input-box" :class="{ 'drag-over': isDragOver }">
    <div
      class="input-resize-handle"
      role="separator"
      aria-orientation="horizontal"
      :aria-label="t('components.input.resizeInput')"
      tabindex="0"
      @mousedown="handleEditorResizeMouseDown"
      @dblclick="resetEditorHeight"
      @keydown="handleEditorResizeKeydown"
    />

    <!-- 编辑器区域（contenteditable） -->
    <div
      ref="editorRef"
      class="input-editor"
      :class="{ disabled: !!disabled, 'is-empty': props.nodes.length === 0 }"
      contenteditable="true"
      :data-placeholder="placeholderText"
      @input="handleInput"
      @keydown="handleKeydown"
      @scroll="handleScroll"
      @compositionstart="handleCompositionStart"
      @compositionend="handleCompositionEnd"
      @paste="handlePaste"
      @dragenter="handleDragEnter"
      @dragleave="handleDragLeave"
      @dragover="handleDragOver"
      @drop="handleDrop"
      @focus="handleEditorFocus"
      @blur="handleEditorBlur"
    ></div>

    <!-- 悬浮预览弹窗 -->
    <Transition name="fade">
      <div
        v-if="previewContext"
        class="context-preview"
        @mouseenter="hoveredContextId = previewContext.id"
        @mouseleave="handleContextMouseLeave"
      >
        <div class="preview-header">
          <i :class="getContextIcon(previewContext).class"></i>
          <span class="preview-title">{{ previewContext.title }}</span>
        </div>
        <pre class="preview-content">{{ truncatePreview(previewContext.content) }}</pre>
      </div>
    </Transition>

    <!-- 自定义滚动条 -->
    <div v-show="showScrollbar" class="scroll-track">
      <div
        class="scroll-thumb"
        :style="thumbStyle"
        @mousedown="handleThumbMouseDown"
      />
    </div>

    <!-- 字符计数 -->
    <div v-if="maxLength" class="char-count">
      {{ getPlainText(props.nodes).length }} / {{ maxLength }}
    </div>
  </div>
</template>

<style scoped>
.input-box {
  position: relative;
  flex: 1;
  display: flex;
  flex-direction: column;
}

.input-resize-handle {
  position: absolute;
  top: -5px;
  left: 0;
  right: 0;
  z-index: 12;
  height: 10px;
  cursor: ns-resize;
  outline: none;
}

.input-resize-handle::after {
  content: '';
  position: absolute;
  top: 4px;
  left: 50%;
  width: 38px;
  height: 2px;
  border-radius: 2px;
  background: var(--vscode-scrollbarSlider-background, rgba(100, 100, 100, 0.4));
  opacity: 0;
  transform: translateX(-50%);
  transition: opacity var(--transition-fast, 0.1s), background var(--transition-fast, 0.1s);
}

.input-resize-handle:hover::after,
.input-resize-handle:focus-visible::after {
  opacity: 1;
  background: var(--vscode-focusBorder);
}

/* contenteditable 编辑器 */
.input-editor {
  position: relative;
  box-sizing: border-box;
  width: 100%;
  min-height: 0;
  max-height: 160px;
  padding: var(--spacing-sm, 8px);
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border);
  border-radius: var(--radius-sm, 2px);
  font-family: var(--vscode-font-family);
  font-size: 13px;
  line-height: 1.5;
  transition: border-color var(--transition-fast, 0.1s);
  outline: none;
  overflow-y: auto;
  white-space: pre-wrap;
  word-wrap: break-word;
  cursor: text;

  /* 隐藏原生滚动条 */
  scrollbar-width: none;
  -ms-overflow-style: none;
}

.input-editor::-webkit-scrollbar {
  display: none;
}

.input-editor:focus {
  border-color: var(--vscode-focusBorder);
}

.input-editor.disabled {
  opacity: 0.5;
  cursor: not-allowed;
  pointer-events: none;
}

/* 占位符：绝对定位浮层，不占用内容布局空间。
   ::before 若参与文档流会占据首行位置，清空输入后光标会被推到
   灰色占位符文本之后；改为浮层后光标保持在内容起点（占位符之前）。 */
.input-editor.is-empty::before {
  position: absolute;
  inset: 0;
  box-sizing: border-box;
  padding: inherit;
  content: attr(data-placeholder);
  color: var(--vscode-input-placeholderForeground);
  pointer-events: none;
  overflow: hidden;
}

/* 拖拽悬停状态 */
.input-box.drag-over .input-editor {
  border-color: var(--vscode-focusBorder);
  background: var(--vscode-list-hoverBackground);
}

/* 内联徽章样式：浅蓝色背景（使用 :deep 以应用到动态创建的元素） */
.input-editor :deep(.context-chip) {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 240px;
  vertical-align: middle;

  padding: 2px 8px;
  margin: 0 2px;
  border-radius: 4px;

  background: rgba(0, 122, 204, 0.16);
  border: 1px solid rgba(0, 122, 204, 0.28);
  color: var(--vscode-foreground);

  user-select: none;
  cursor: pointer;
  transition: background 0.15s ease, border-color 0.15s ease;
}

.input-editor :deep(.context-chip:hover) {
  background: rgba(0, 122, 204, 0.24);
  border-color: rgba(0, 122, 204, 0.4);
}

.input-editor :deep(.context-chip .codicon),
.input-editor :deep(.context-chip .icon) {
  font-size: 12px;
  color: var(--vscode-textLink-foreground);
  flex-shrink: 0;
}

.input-editor :deep(.context-chip__text) {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
}

.input-editor :deep(.context-chip__remove) {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  margin-left: 2px;
  padding: 0;

  border: none;
  background: transparent;
  color: var(--vscode-descriptionForeground);
  cursor: pointer;

  opacity: 0;
  pointer-events: none;
  transition: opacity 0.12s ease;
}

.input-editor :deep(.context-chip:hover .context-chip__remove),
.input-editor :deep(.context-chip.hovered .context-chip__remove) {
  opacity: 1;
  pointer-events: auto;
}

.input-editor :deep(.context-chip__remove:hover) {
  color: var(--vscode-errorForeground);
}

/* 自定义滚动条 - 悬浮设计，不占用布局 */
.scroll-track {
  position: absolute;
  top: 1px;
  right: 3px;
  width: 6px;
  height: calc(100% - 2px);
  border-radius: 0;
  cursor: pointer;
  background: transparent;
  z-index: 10;
  opacity: 1;
}

.scroll-thumb {
  position: absolute;
  left: 0;
  width: 100%;
  border-radius: 0;
  cursor: grab;
  transition: background 0.18s ease, top 0.06s linear;
  will-change: top;
  background: var(--vscode-scrollbarSlider-background, rgba(100, 100, 100, 0.4));
}

.scroll-thumb:hover {
  background: var(--vscode-scrollbarSlider-hoverBackground, rgba(100, 100, 100, 0.55));
}

.scroll-thumb:active {
  cursor: grabbing;
  background: var(--vscode-scrollbarSlider-activeBackground, rgba(100, 100, 100, 0.7));
}

.char-count {
  position: absolute;
  right: var(--spacing-sm, 8px);
  bottom: var(--spacing-xs, 4px);
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  pointer-events: none;
}

@media (prefers-reduced-motion: reduce) {
  .scroll-track,
  .scroll-thumb {
    transition: none !important;
  }
}

/* 悬浮预览弹窗 */
.context-preview {
  position: absolute;
  bottom: 100%;
  left: 0;
  right: 0;
  margin-bottom: 8px;
  background: var(--vscode-editorWidget-background);
  border: 1px solid var(--vscode-editorWidget-border);
  border-radius: 6px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
  z-index: 100;
  max-height: 240px;
  overflow: hidden;
}

.preview-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--vscode-panel-border);
  background: var(--vscode-editor-background);
}

.preview-header .codicon {
  font-size: 14px;
  color: var(--vscode-textLink-foreground);
}

.preview-title {
  flex: 1;
  font-weight: 500;
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.preview-content {
  margin: 0;
  padding: 10px 12px;
  font-size: 11px;
  font-family: var(--vscode-editor-font-family);
  line-height: 1.5;
  overflow-y: auto;
  max-height: 180px;
  white-space: pre-wrap;
  word-break: break-all;
  color: var(--vscode-foreground);
  background: var(--vscode-textBlockQuote-background);
}

/* 淡入淡出动画 */
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.15s ease, transform 0.15s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
  transform: translateY(4px);
}
</style>
