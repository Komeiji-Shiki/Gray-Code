import { computed, ref } from 'vue'
import type { EditorNode } from '../../../types/editorNode'

export type EditorHistoryKind =
  | 'baseline'
  | 'typing'
  | 'deleting'
  | 'composition'
  | 'paste'
  | 'cut'
  | 'structure'
  | 'boundary'

export interface EditorHistoryEntry {
  nodes: EditorNode[]
  caretOffset: number
  kind: EditorHistoryKind
  timestamp: number
}

export interface EditorHistoryOptions {
  maxEntries?: number
  coalesceMs?: number
  now?: () => number
}

function snapshotNodes(nodes: EditorNode[]): EditorNode[] {
  return nodes.map(node => node.type === 'text'
    ? { type: 'text', text: node.text }
    : { type: 'context', context: { ...node.context } })
}

function nodesEqual(left: EditorNode[], right: EditorNode[]): boolean {
  if (left.length !== right.length) return false
  return left.every((node, index) => {
    const other = right[index]
    if (!other || node.type !== other.type) return false
    if (node.type === 'text' && other.type === 'text') return node.text === other.text
    if (node.type === 'context' && other.type === 'context') {
      const a = node.context
      const b = other.context
      return a.id === b.id &&
        a.type === b.type &&
        a.title === b.title &&
        a.content === b.content &&
        a.filePath === b.filePath &&
        a.language === b.language &&
        a.isTextContent === b.isTextContent &&
        a.enabled === b.enabled &&
        a.addedAt === b.addedAt
    }
    return false
  })
}

function cloneEntry(entry: EditorHistoryEntry): EditorHistoryEntry {
  return {
    ...entry,
    nodes: snapshotNodes(entry.nodes)
  }
}

function isCoalescible(kind: EditorHistoryKind): boolean {
  return kind === 'typing' || kind === 'deleting'
}

export function useEditorHistory(options: EditorHistoryOptions = {}) {
  const maxEntries = options.maxEntries ?? 100
  const coalesceMs = options.coalesceMs ?? 750
  const now = options.now ?? Date.now
  const entries = ref<EditorHistoryEntry[]>([])
  const index = ref(-1)
  let pendingKind: EditorHistoryKind | null = null

  const canUndo = computed(() => index.value > 0)
  const canRedo = computed(() => index.value >= 0 && index.value < entries.value.length - 1)

  function markNext(kind: EditorHistoryKind) {
    pendingKind = kind
  }

  function clearPending() {
    pendingKind = null
  }

  function resolveKind(inputType?: string, forcedKind?: EditorHistoryKind): EditorHistoryKind {
    const pending = pendingKind
    pendingKind = null
    if (forcedKind) return forcedKind
    if (pending) return pending

    switch (inputType) {
      case 'insertText':
        return 'typing'
      case 'insertCompositionText':
        return 'composition'
      case 'deleteContentBackward':
      case 'deleteContentForward':
      case 'deleteWordBackward':
      case 'deleteWordForward':
      case 'deleteSoftLineBackward':
      case 'deleteSoftLineForward':
        return 'deleting'
      case 'insertFromPaste':
        return 'paste'
      case 'deleteByCut':
        return 'cut'
      case 'insertLineBreak':
      case 'insertParagraph':
        return 'structure'
      default:
        return 'boundary'
    }
  }

  function record(
    nodes: EditorNode[],
    caretOffset: number,
    kind: EditorHistoryKind = 'boundary'
  ) {
    const timestamp = now()
    const current = entries.value[index.value]

    if (current && nodesEqual(current.nodes, nodes)) {
      entries.value[index.value] = { ...current, caretOffset, timestamp }
      return
    }

    const branchedFromUndo = index.value < entries.value.length - 1
    if (branchedFromUndo) {
      entries.value = entries.value.slice(0, index.value + 1)
    }

    const top = entries.value[entries.value.length - 1]
    const entry: EditorHistoryEntry = {
      nodes: snapshotNodes(nodes),
      caretOffset,
      kind,
      timestamp
    }

    if (
      !branchedFromUndo &&
      top &&
      top.kind === kind &&
      isCoalescible(kind) &&
      timestamp - top.timestamp <= coalesceMs
    ) {
      entries.value[entries.value.length - 1] = entry
      index.value = entries.value.length - 1
      return
    }

    if (entries.value.length >= maxEntries) entries.value.shift()
    entries.value.push(entry)
    index.value = entries.value.length - 1
  }

  function undo(): EditorHistoryEntry | null {
    pendingKind = null
    if (!canUndo.value) return null
    index.value--
    return cloneEntry(entries.value[index.value])
  }

  function redo(): EditorHistoryEntry | null {
    pendingKind = null
    if (!canRedo.value) return null
    index.value++
    return cloneEntry(entries.value[index.value])
  }

  return {
    canUndo,
    canRedo,
    clearPending,
    markNext,
    record,
    redo,
    resolveKind,
    undo
  }
}
