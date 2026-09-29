import { computed, nextTick, ref, type Ref } from 'vue'

/** 输入区尺寸、光标可见性和拖动由同一实例持有，键盘及 IME 历史留在输入组件。 */
export function useEditorGeometry(editorRef: Ref<HTMLDivElement | undefined>, props: { minRows: number; maxRows: number }) {
  const currentRows = ref(props.minRows)
  const manualEditorHeight = ref<number | null>(null)
  const thumbHeight = ref(0)
  const thumbTop = ref(0)
  const showScrollbar = ref(false)
  let isDragging = false
  let startY = 0
  let startScrollTop = 0
  let isResizingEditor = false
  let resizeStartY = 0
  let resizeStartHeight = 0
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
    const style = getComputedStyle(editor)
    const lineHeight = parseFloat(style.lineHeight) || 20
    const paddingHeight = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0)
    const borderHeight = (parseFloat(style.borderTopWidth) || 0) + (parseFloat(style.borderBottomWidth) || 0)
    // 编辑器使用 border-box；两行正文之外还需要保留内边距和边框，避免第二行被裁掉。
    const minHeight = props.minRows * lineHeight + paddingHeight + borderHeight
    const maxHeight = Math.max(minHeight, Math.floor(window.innerHeight * 0.72))
    return { minHeight, maxHeight, lineHeight, paddingHeight, borderHeight }
  }

  function adjustHeight() {
    if (!editorRef.value) return

    const editor = editorRef.value
    const minRows = props.minRows
    const maxRows = props.maxRows

    const { minHeight, maxHeight, lineHeight, paddingHeight, borderHeight } = getEditorHeightBounds(editor)
    const prevScrollTop = editor.scrollTop
    const prevWasAtBottom = editor.scrollTop + editor.clientHeight >= editor.scrollHeight - 2

    if (manualEditorHeight.value !== null) {
      const height = Math.min(Math.max(manualEditorHeight.value, minHeight), maxHeight)
      manualEditorHeight.value = height
      editor.style.maxHeight = `${maxHeight}px`
      editor.style.height = `${height}px`
      currentRows.value = Math.max(minRows, Math.round((height - paddingHeight - borderHeight) / lineHeight))
      nextTick(() => {
        updateScrollbar()
        ensureCaretVisible(editor)
      })
      return
    }

    // 每次先恢复 auto 再测量真实内容高度。固定高度下的 scrollHeight 会掩盖
    // 删除内容后的收缩，导致输入框只能变高、不能变矮。
    editor.style.maxHeight = `${maxRows * lineHeight + paddingHeight + borderHeight}px`
    editor.style.height = 'auto'

    const contentHeight = editor.scrollHeight - paddingHeight
    const rows = Math.min(Math.max(Math.ceil(contentHeight / lineHeight), minRows), maxRows)
    editor.style.height = `${rows * lineHeight + paddingHeight + borderHeight}px`
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
  return { currentRows, manualEditorHeight, thumbHeight, thumbTop, showScrollbar, ensureCaretVisible, adjustHeight, handleEditorResizeMouseDown, handleEditorResizeMouseMove, handleEditorResizeMouseUp, resetEditorHeight, handleEditorResizeKeydown, updateScrollbar, handleScroll, handleThumbMouseDown, handleMouseMove, handleMouseUp, thumbStyle }
}
