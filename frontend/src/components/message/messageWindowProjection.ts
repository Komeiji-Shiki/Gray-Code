import type { Message, CheckpointRecord } from '../../types'
import { getMessageInputGroupPositions, type MessageInputGroupPosition } from './messageListUtils'

export interface EnhancedMessage {
  message: Message
  backendIndex: number
  beforeCheckpoints: CheckpointRecord[]
  afterCheckpoints: CheckpointRecord[]
  floor?: number
}

export type MessageRenderRow =
  | { kind: 'build' | 'todo' | 'summarize-divider'; key: string }
  | { kind: 'message'; key: string; item: EnhancedMessage; inputGroup?: MessageInputGroupPosition }

const EMPTY_CHECKPOINTS: CheckpointRecord[] = []

/** 只替换内容或展示元数据发生变化的行；检查点引用参与判断，不能仅比较数量。 */
export function projectMessageWindow(
  messages: readonly Message[],
  start: number,
  end: number,
  checkpoints: Map<number, { before: CheckpointRecord[]; after: CheckpointRecord[] }>,
  floors: Map<string, number>,
  previous: EnhancedMessage[] = []
): EnhancedMessage[] {
  const items: EnhancedMessage[] = []
  for (let index = start; index < end; index++) {
    const message = messages[index]
    const backendIndex = typeof message.backendIndex === 'number' ? message.backendIndex : -1
    const group = backendIndex !== -1 ? checkpoints.get(backendIndex) : undefined
    const beforeCheckpoints = group?.before ?? EMPTY_CHECKPOINTS
    const afterCheckpoints = group?.after ?? EMPTY_CHECKPOINTS
    const floor = floors.get(message.id)
    const cached = previous[index - start]
    items.push(cached?.message === message && cached.backendIndex === backendIndex && cached.floor === floor
      && cached.beforeCheckpoints === beforeCheckpoints && cached.afterCheckpoints === afterCheckpoints
      ? cached : { message, backendIndex, beforeCheckpoints, afterCheckpoints, floor })
  }
  return items.length === previous.length && items.every((item, index) => item === previous[index]) ? previous : items
}

interface StickyPanels {
  build: boolean
  buildAnchor: number | null
  todo: boolean
  todoAnchor: number | null
}

/** 粘性面板、总结分隔和输入分组共用一份行投影；流式正文变化不重建其余行对象。 */
export function projectMessageRows(
  visible: EnhancedMessage[],
  panels: StickyPanels,
  previous: MessageRenderRow[] = []
): MessageRenderRow[] {
  const rows: MessageRenderRow[] = []
  const addMarker = (kind: 'build' | 'todo' | 'summarize-divider', key: string) => {
    const cached = previous[rows.length]
    rows.push(cached?.kind === kind && cached.key === key ? cached : { kind, key })
  }
  const shouldInsert = (anchor: number | null, index: number) => anchor === null || index >= 0 && index >= anchor
  let buildInserted = !panels.build
  let todoInserted = !panels.todo
  let lastSummaryIndex: number | null = null
  for (const item of visible) if (item.message.isSummary) lastSummaryIndex = item.backendIndex

  for (const item of visible) {
    if (!buildInserted && shouldInsert(panels.buildAnchor, item.backendIndex)) {
      addMarker('build', 'build-bar')
      buildInserted = true
    }
    if (!todoInserted && shouldInsert(panels.todoAnchor, item.backendIndex)) {
      addMarker('todo', 'todo-bar')
      todoInserted = true
    }
    const cached = previous[rows.length]
    rows.push(cached?.kind === 'message' && cached.item === item
      ? cached : { kind: 'message', key: item.message.id, item })
    if (lastSummaryIndex !== null && item.backendIndex === lastSummaryIndex) {
      addMarker('summarize-divider', `summarize-divider:${item.backendIndex}`)
    }
  }
  if (!buildInserted) addMarker('build', 'build-bar')
  if (!todoInserted) addMarker('todo', 'todo-bar')

  const inputGroups = getMessageInputGroupPositions(rows)
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]
    if (row.kind === 'message' && row.inputGroup !== inputGroups[index]) {
      rows[index] = { ...row, inputGroup: inputGroups[index] }
    }
  }
  return rows.length === previous.length && rows.every((row, index) => row === previous[index]) ? previous : rows
}
