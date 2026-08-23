import { describe, expect, test } from 'vitest'
import { useEditorHistory } from '../../components/input/inputBox/useEditorHistory'
import type { EditorNode } from '../../types/editorNode'

const text = (value: string): EditorNode[] => [{ type: 'text', text: value }]

describe('useEditorHistory', () => {
  test('coalesces a typing burst but keeps paste as an atomic boundary', () => {
    let clock = 0
    const history = useEditorHistory({ now: () => clock, coalesceMs: 750 })
    history.record([], 0, 'baseline')
    history.record(text('a'), 1, 'typing')
    clock = 100
    history.record(text('ab'), 2, 'typing')
    clock = 200
    history.record(text('ab pasted'), 9, 'paste')

    expect(history.undo()?.nodes).toEqual(text('ab'))
    expect(history.undo()?.nodes).toEqual([])
    expect(history.redo()?.nodes).toEqual(text('ab'))
    expect(history.redo()?.nodes).toEqual(text('ab pasted'))
  })

  test('starts a new branch after undo and drops the stale redo tail', () => {
    const history = useEditorHistory()
    history.record([], 0, 'baseline')
    history.record(text('a'), 1, 'boundary')
    history.record(text('ab'), 2, 'boundary')
    expect(history.undo()?.nodes).toEqual(text('a'))

    history.record(text('ax'), 2, 'boundary')
    expect(history.canRedo.value).toBe(false)
    expect(history.undo()?.nodes).toEqual(text('a'))
  })

  test('deduplicates terminal input events and snapshots context nodes without sharing objects', () => {
    const history = useEditorHistory()
    const context: EditorNode[] = [{
      type: 'context',
      context: {
        id: 'ctx',
        type: 'file',
        title: 'large.txt',
        content: 'x'.repeat(1000),
        enabled: true,
        addedAt: 1
      }
    }]
    history.record([], 0, 'baseline')
    history.record(context, 0, 'composition')
    history.record(context, 0, 'composition')

    const restored = history.undo()
    expect(restored?.nodes).toEqual([])
    const redone = history.redo()!
    expect(redone.nodes).toEqual(context)
    expect(redone.nodes).not.toBe(context)
    expect((redone.nodes[0] as Extract<EditorNode, { type: 'context' }>).context).not.toBe(
      (context[0] as Extract<EditorNode, { type: 'context' }>).context
    )
  })

  test('pending operation kind overrides browser inputType once', () => {
    const history = useEditorHistory()
    history.markNext('paste')
    expect(history.resolveKind('insertText')).toBe('paste')
    expect(history.resolveKind('insertText')).toBe('typing')
  })
})
