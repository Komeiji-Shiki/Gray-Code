import { describe, it, expect } from 'vitest'
import { computeTaskCardStatus } from '../backgroundStatus'
import type { BackgroundTaskRecord } from '../../../../stores/backgroundTasks/reportBuilder'

function makeTask(overrides: Partial<BackgroundTaskRecord> = {}): BackgroundTaskRecord {
  return {
    taskId: 'task-1',
    kind: 'subagent',
    label: 'Test Agent',
    status: 'running',
    startedAt: Date.now(),
    reported: false,
    ...overrides
  }
}

describe('computeTaskCardStatus', () => {
  it('returns completed for non-background result with success=true', () => {
    const result = { success: true, data: { background: false } }
    expect(computeTaskCardStatus(undefined, {}, result)).toBe('completed')
  })

  it('returns failed for non-background result with success=false', () => {
    const result = { success: false, data: { background: false } }
    expect(computeTaskCardStatus(undefined, {}, result)).toBe('failed')
  })

  it('returns completed for non-background result without data field', () => {
    const result = { success: true }
    expect(computeTaskCardStatus(undefined, {}, result)).toBe('completed')
  })

  // --- Background dispatch ---

  it('returns running when background task is running', () => {
    const result = { success: true, data: { background: true, taskId: 'task-1' } }
    const tasks = { 'task-1': makeTask({ status: 'running' }) }
    expect(computeTaskCardStatus('task-1', tasks, result)).toBe('running')
  })

  it('returns completed when background task is completed', () => {
    const result = { success: true, data: { background: true, taskId: 'task-1' } }
    const tasks = { 'task-1': makeTask({ status: 'completed' }) }
    expect(computeTaskCardStatus('task-1', tasks, result)).toBe('completed')
  })

  it('returns failed when background task errored', () => {
    const result = { success: true, data: { background: true, taskId: 'task-1' } }
    const tasks = { 'task-1': makeTask({ status: 'error' }) }
    expect(computeTaskCardStatus('task-1', tasks, result)).toBe('failed')
  })

  it('returns cancelled when background task was cancelled', () => {
    const result = { success: true, data: { background: true, taskId: 'task-1' } }
    const tasks = { 'task-1': makeTask({ status: 'cancelled' }) }
    expect(computeTaskCardStatus('task-1', tasks, result)).toBe('cancelled')
  })

  // --- No task record ---

  it('returns neutral completed (not running) when task record is missing with success stub', () => {
    const result = { success: true, data: { background: true, taskId: 'task-1' } }
    // No task in the store — e.g. after tab switch / store reset
    expect(computeTaskCardStatus('task-1', {}, result)).toBe('completed')
  })

  it('returns neutral failed when task record is missing and stub has success=false', () => {
    const result = { success: false, data: { background: true, taskId: 'task-1' } }
    expect(computeTaskCardStatus('task-1', {}, result)).toBe('failed')
  })

  // --- No taskId ---

  it('returns completed when background=true but no taskId and stub has success=true', () => {
    const result = { success: true, data: { background: true } }
    expect(computeTaskCardStatus(undefined, {}, result)).toBe('completed')
  })

  it('returns failed when background=true but no taskId and stub has success=false', () => {
    const result = { success: false, data: { background: true } }
    expect(computeTaskCardStatus(undefined, {}, result)).toBe('failed')
  })

  // --- Undefined result ---

  it('returns failed when subagentResult is undefined', () => {
    // undefined => (subagentResult as any)?.data is undefined => isBackground=false
    // => success=false => 'failed'
    expect(computeTaskCardStatus(undefined, {}, undefined)).toBe('failed')
  })
})
