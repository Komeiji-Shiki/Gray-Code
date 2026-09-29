import { expect, test } from 'vitest'
import type { Content } from '@/types'
import { renderMonitorMessages, type MonitorRenderCacheEntry } from '../monitorMessages'

test('监视窗口关联本任务的图片，附件更新后刷新并复用稳定投影', () => {
  const call: Content = { role: 'model', index: 1, parts: [{ functionCall: { id: 'tool', name: 'generate_image', args: {} } }] }
  const result: Content = { role: 'user', index: 2, isFunctionResponse: true,
    parts: [{ functionResponse: { id: 'tool', name: 'generate_image', response: { success: true } } }] }
  const cache = new Map<number, MonitorRenderCacheEntry>()
  const run = { runId: 'child', status: 'completed' as const, contents: [call, result] }
  const first = renderMonitorMessages(run, undefined, undefined, false, cache)
  expect(first[0].tools?.[0].result).not.toHaveProperty('multimodal')
  result.parts = [...result.parts, { inlineData: { mimeType: 'image/png', data: 'AAAA', name: 'child.png' } }]
  const second = renderMonitorMessages(run, undefined, undefined, false, cache)
  expect(second[0].tools?.[0].result).toMatchObject({ multimodal: [{ data: 'AAAA', name: 'child.png' }] })
  expect(result.parts[0].functionResponse?.response).toEqual({ success: true })
  expect(renderMonitorMessages(run, undefined, undefined, false, cache)[0]).toBe(second[0])
})
