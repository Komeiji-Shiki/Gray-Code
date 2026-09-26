import { mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { hasMessage, setLanguage } from '../../../../i18n'
import LongMemoryToolResult from '../LongMemoryToolResult.vue'
import { DefaultToolResult, getToolConfig } from '../../../../utils/toolRegistry'
import '../../../../utils/tools/memory/memory_note'
import '../../../../utils/tools/platform'

const wrappers: VueWrapper[] = []
function open(props: Record<string, unknown>) { const wrapper = mount(LongMemoryToolResult, { props }); wrappers.push(wrapper); return wrapper }
const result = (data: unknown) => ({ success: true, data })
const record = { id: 'hidden-memory', scopeId: 'hidden-scope', version: 3, kind: 'fact', origin: 'user', confidence: 'confirmed', subject: 'Deployment port', topic: ['Project', 'Deployment'], text: 'The service uses port 4300.', dependencies: [{ kind: 'source', id: 'source-id', version: 1 }], recordedAt: 1 }
beforeEach(() => setLanguage('en'))
afterEach(() => { wrappers.splice(0).forEach(wrapper => wrapper.unmount()); setLanguage('auto') })

test('topics show scope kinds, paths and summary content before technical IDs', async () => {
  const wrapper = open({ toolName: 'memory_topics', args: {}, result: result({ scopes: [{ id: 'private-scope', kind: 'personal', realm: 'real' }], topics: [{ scopeId: 'private-scope', path: ['Preferences', 'Writing'], records: 2, summaries: [{ id: 'summary-id', version: 2, text: 'Prefers concise responses.' }] }], truncated: true, nextCursor: 'cursor-hidden' }) })
  expect(wrapper.get('.memory-scopes').text()).toContain('Personal')
  expect(wrapper.get('.memory-topic').text()).toContain('Preferences › Writing')
  expect(wrapper.get('.memory-topic').text()).toContain('Prefers concise responses.')
  expect(wrapper.get('.memory-topic').text()).toContain('Version 2')
  expect(wrapper.get('.continuation').text()).toContain('Another page')
  expect(wrapper.get('.result-section').text()).not.toContain('cursor-hidden')
  const details = wrapper.findAll<HTMLDetailsElement>('.tool-receipt-details').at(-1)!
  details.element.open = true; await details.trigger('toggle')
  expect(details.text()).toContain('cursor-hidden')
})

test('memory search displays actual record body and confidence, not hit JSON', () => {
  const wrapper = open({ toolName: 'memory_search', args: { text: 'port' }, result: result({ hits: [{ record, score: 0.8, reasons: ['keyword'], conflicts: ['other-record'] }], method: 'keyword', truncated: false }) })
  expect(wrapper.get('.memory-card').text()).toContain('Deployment port')
  expect(wrapper.get('.memory-card .platform-text').text()).toBe(record.text)
  expect(wrapper.get('.memory-card').text()).toContain('Confirmed')
  expect(wrapper.get('.memory-conflicts').text()).toBe('1 conflicting records')
  expect(wrapper.get('.result-section').text()).not.toContain('hidden-memory')
  expect(wrapper.get('.result-section').text()).not.toContain('other-record')
  expect(wrapper.find('.result-section .result-fields').exists()).toBe(false)
})

test('read renders source excerpts and distinguishes omitted records from unavailable ones', () => {
  const wrapper = open({ toolName: 'memory_read', args: { ids: ['hidden-memory'] }, result: result({ records: [record], sources: [{ id: 'source-id', version: 1, origin: 'user', text: 'Please remember port 4300.', reference: { label: 'User correction', messageId: 'private-message' } }], omitted: [{ id: 'budget-item', reason: 'token_budget' }], unavailable: [{ id: 'gone-item' }], requiredTokenBudget: 8000 }) })
  expect(wrapper.get('.memory-sources').text()).toContain('Please remember port 4300.')
  expect(wrapper.get('.memory-sources').text()).toContain('User correction')
  expect(wrapper.get('.memory-omitted').text()).toBe('1 items omitted due to budget or count limits')
  expect(wrapper.get('.memory-unavailable').text()).toBe('1 items unavailable')
  expect(wrapper.get('.result-section').text()).toContain('Required token budget: 8000')
  expect(wrapper.get('.result-section').text()).not.toContain('private-message')
})

test.each([false, true])('paged %s source body keeps continuation offset and record version visible', isSource => {
  const wrapper = open({ toolName: 'memory_read', args: {}, result: result({ records: [], sources: [], page: { record, ...(isSource ? { source: { id: 'source-id', version: 1, origin: 'user' } } : {}), text: 'long body section', offset: 0, end: 17, totalCharacters: 50, nextOffset: 17 } }) })
  expect(wrapper.get('.memory-page .platform-text').text()).toBe('long body section')
  expect(wrapper.get('.memory-page').text()).toContain('Characters 0–17 / 50')
  expect(wrapper.get('.continuation').text()).toContain('offset 17')
  expect(wrapper.get('.continuation').text()).toContain('Version 3')
  expect(wrapper.find('.memory-page .memory-source').exists()).toBe(isSource)
})

test.each(['memory_remember', 'memory_summarize'])('%s compact receipt separates submitted text from returned records', toolName => {
  const wrapper = open({ toolName, args: { text: 'Submitted fact', topic: ['Project'] }, result: result({ records: [{ id: 'new-id', version: 1, kind: toolName === 'memory_summarize' ? 'summary' : 'fact', topic: ['Project'] }] }) })
  expect(wrapper.get('.memory-save-receipt').text()).toBe('1 saved records returned')
  expect(wrapper.get('.memory-submitted').text()).toContain('Submitted memory content')
  expect(wrapper.get('.memory-submitted .platform-text').text()).toBe('Submitted fact')
  expect(wrapper.get('.memory-card').text()).not.toContain('Submitted fact')
})

test.each([
  { oldText: 'Old assertion', newText: '' },
  { append: '\nNew appended evidence' },
  { text: 'Replacement document' },
])('revise preserves replacement, append and full-text input with explicit request labeling: %j', patch => {
  const wrapper = open({ toolName: 'memory_revise', args: { id: 'id', expectedVersion: 2, ...patch }, result: result({ records: [{ id: 'id', version: 3, kind: 'fact' }] }) })
  expect(wrapper.get('.memory-card').text()).toContain('Version 3')
  if ('oldText' in patch) expect(wrapper.findAll('.memory-replacement pre').map(pre => pre.text())).toEqual(['Old assertion', ''])
  if ('append' in patch) expect(wrapper.get('.memory-submitted').text()).toContain('Requested appended content')
  if ('text' in patch) expect(wrapper.get('.memory-submitted pre').text()).toBe('Replacement document')
})

test('removal preview is visibly not deletion and does not invent missing source excerpts', () => {
  const wrapper = open({ toolName: 'memory_remove', args: { operation: 'preview', action: 'delete' }, result: result({ affected: [{ kind: 'source', id: 'source-id' }, { kind: 'record', id: 'record-id' }], total: 32, recordCount: 10, truncated: true }) })
  expect(wrapper.get('.removal-preview').text()).toContain('Nothing deleted')
  expect(wrapper.get('.removal-preview').text()).toContain('32 affected items, including 10 memories')
  expect(wrapper.get('.removal-preview').text()).toContain('Partial result')
  expect(wrapper.get('.result-section').text()).not.toContain('source-id')
  expect(wrapper.find('.removal-receipt').exists()).toBe(false)
  expect(wrapper.find('.memory-card').exists()).toBe(false)
  expect(wrapper.find('button').exists()).toBe(false)
})

test.each(['delete', 'retract'])('apply %s acknowledges only a real removed count, including zero', action => {
  const wrapper = open({ toolName: 'memory_remove', args: { operation: 'apply', action }, result: result({ removed: 0, revision: 12 }) })
  expect(wrapper.get('.removal-receipt').text()).toContain('0 items removed')
  expect(wrapper.get('.removal-receipt').text()).toContain(action === 'retract' ? 'Retraction receipt' : 'Removal receipt')
})

test('failed, missing or pending removal never says it removed memory', async () => {
  const wrapper = open({ toolName: 'memory_remove', args: { operation: 'apply', action: 'delete' }, status: 'executing' })
  expect(wrapper.find('.result-waiting').exists()).toBe(true)
  expect(wrapper.find('.removal-receipt').exists()).toBe(false)
  await wrapper.setProps({ result: { success: false, error: 'version changed', data: { removed: 2 } } })
  expect(wrapper.get('[role="alert"]').text()).toContain('version changed')
  expect(wrapper.find('.removal-receipt').exists()).toBe(false)
  await wrapper.setProps({ result: result({ revision: 2 }) })
  expect(wrapper.find('.removal-receipt').exists()).toBe(false)
  expect(wrapper.get('.platform-empty').text()).toBe('No result details returned.')
})

test('malformed memory arrays and absent data do not crash or fabricate saved content', () => {
  const empty = open({ toolName: 'memory_search', args: {}, result: result({ hits: [null, {}, { record: null }], truncated: false }) })
  expect(empty.find('.memory-card').exists()).toBe(false)
  expect(empty.get('.platform-empty').text()).toBe('No memories returned')
  const missing = open({ toolName: 'memory_remember', args: { text: 'not confirmed' }, result: { success: true } })
  expect(missing.find('.memory-save-receipt').exists()).toBe(false)
  expect(missing.get('.memory-submitted').text()).toContain('Submitted memory content')
})

test('large memory result lists reveal locally while retaining their record bodies', async () => {
  const wrapper = open({ toolName: 'memory_read', args: {}, result: result({ records: Array.from({ length: 45 }, (_, index) => ({ ...record, id: `record-${index}`, text: `Body ${index}` })), sources: [] }) })
  expect(wrapper.findAll('.memory-card')).toHaveLength(30)
  expect(wrapper.get('.memory-card .platform-text').text()).toBe('Body 0')
  await wrapper.get('button.platform-more').trigger('click')
  expect(wrapper.findAll('.memory-card')).toHaveLength(45)
  expect(wrapper.get('.result-section').text()).toContain('Body 44')
})

test('contradictory success with an error cannot acknowledge removal or saving', () => {
  const removal = open({ toolName: 'memory_remove', args: { operation: 'apply' }, result: { success: true, error: 'transaction not committed', data: { removed: 3 } } })
  expect(removal.find('.removal-receipt').exists()).toBe(false)
  const save = open({ toolName: 'memory_remember', status: 'cancelled', args: {}, result: result({ records: [record] }) })
  expect(save.find('.memory-save-receipt').exists()).toBe(false)
})

test('new platform registry covers all 13 names and preserves the old memory_note renderer', () => {
  const names = ['workspace_files', 'search_files', 'run_command', 'process_session', 'team_tasks', 'team_wait', 'memory_topics', 'memory_search', 'memory_read', 'memory_remember', 'memory_revise', 'memory_remove', 'memory_summarize']
  for (const name of names) expect(getToolConfig(name)?.contentComponent).not.toBe(DefaultToolResult)
  expect(getToolConfig('memory_note')?.contentComponent).not.toBe(getToolConfig('memory_remember')?.contentComponent)
  expect(getToolConfig('unregistered_platform_fixture')?.contentComponent).toBe(DefaultToolResult)
})

test('platform panel translations are available in zh/en/ja and react to language changes', async () => {
  const wrapper = open({ toolName: 'memory_remove', args: { operation: 'preview' }, result: result({ affected: [], total: 0, recordCount: 0 }) })
  for (const [language, expected] of [['zh-CN', '尚未删除'], ['en', 'Nothing deleted'], ['ja', '未削除']] as const) {
    setLanguage(language); await wrapper.vm.$nextTick()
    expect(wrapper.get('.removal-preview').text()).toContain(expected)
    expect(hasMessage('components.tools.platform.team.events.task_dependencies_changed')).toBe(true)
    expect(hasMessage('components.tools.platform.process.unknown')).toBe(true)
  }
})
