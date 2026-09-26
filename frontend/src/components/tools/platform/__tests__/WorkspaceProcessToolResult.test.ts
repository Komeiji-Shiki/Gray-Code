import { mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { setLanguage } from '../../../../i18n'
import WorkspaceToolResult from '../WorkspaceToolResult.vue'
import ProcessToolResult from '../ProcessToolResult.vue'
import PlatformText from '../PlatformText.vue'

const wrappers: VueWrapper[] = []
function open(component: any, props: Record<string, unknown>) { const wrapper = mount(component, { props }); wrappers.push(wrapper); return wrapper }
const result = (data: unknown) => ({ success: true, data })
beforeEach(() => setLanguage('en'))
afterEach(() => { wrappers.splice(0).forEach(wrapper => wrapper.unmount()); setLanguage('auto') })

test('workspace read shows numbered original content and next line, with hashes lazy', async () => {
  const wrapper = open(WorkspaceToolResult, { toolName: 'workspace_files', args: { action: 'read', path: 'src/a.ts' }, result: result({ content: '<script>literal</script>\nsecond', startLine: 11, endLine: 12, totalLines: 40, hash: 'secret-hash' }) })
  expect(wrapper.findAll('.line-number').map(line => line.text())).toEqual(['11', '12'])
  expect(wrapper.get('.platform-code').text()).toContain('<script>literal</script>')
  expect(wrapper.find('script').exists()).toBe(false)
  expect(wrapper.get('.continuation').text()).toContain('line 13')
  expect(wrapper.get('.result-section').text()).not.toContain('secret-hash')
  const details = wrapper.get<HTMLDetailsElement>('.tool-receipt-details'); details.element.open = true; await details.trigger('toggle')
  expect(wrapper.get('.tool-receipt-details').text()).toContain('secret-hash')
})

test('workspace list has file and folder rows instead of a generic object table', () => {
  const wrapper = open(WorkspaceToolResult, { toolName: 'workspace_files', args: { action: 'list' }, result: result([{ kind: 'directory', path: 'src', name: 'src' }, { kind: 'file', path: 'README.md' }, null]) })
  expect(wrapper.findAll('.file-entries>li')).toHaveLength(2)
  expect(wrapper.find('.codicon-folder').exists()).toBe(true)
  expect(wrapper.get('.file-entries').text()).toContain('README.md')
  expect(wrapper.find('.result-section .result-fields').exists()).toBe(false)
})

test('literal search groups hits by path and exposes exact server continuation, including zero', () => {
  const wrapper = open(WorkspaceToolResult, { toolName: 'search_files', args: { query: 'port', directory: 'src' }, result: result({ matches: [{ path: 'a.ts', line: 2, text: 'port = 43' }, { path: 'b.ts', line: 5, text: 'port = 44' }, { path: 'a.ts', line: 9, text: 'port = 45' }], scanned: 0, nextOffset: 0, truncated: true, truncationReasons: ['limit'] }) })
  expect(wrapper.findAll('.file-hits')).toHaveLength(2)
  expect(wrapper.get('.file-hits').text()).toContain('port = 45')
  expect(wrapper.get('.platform-statbar').text()).toContain('0 files scanned')
  expect(wrapper.get('.continuation').text()).toContain('offset 0')
  expect(wrapper.get('.platform-notice.warning').text()).toContain('same query')
})

test('scan limit is not confused with pageable search results', () => {
  const wrapper = open(WorkspaceToolResult, { toolName: 'search_files', args: { query: 'absent' }, result: result({ matches: [], scanned: 20000, truncated: true, truncationReasons: ['scanLimit'] }) })
  expect(wrapper.get('.platform-notice.warning').text()).toContain('Offset cannot reach unscanned files')
  expect(wrapper.get('.platform-empty').text()).toBe('No matching lines')
  expect(wrapper.find('.continuation').exists()).toBe(false)
})

test('unknown truncation reason never promises a continuation that was not returned', () => {
  const wrapper = open(WorkspaceToolResult, { toolName: 'search_files', args: { query: 'q' }, result: result({ matches: [], truncated: true }) })
  expect(wrapper.get('.platform-notice.warning').text()).toBe('Partial result')
  expect(wrapper.find('.continuation').exists()).toBe(false)
})

test.each(['list', 'read'])('missing %s payload remains neutral', action => {
  const wrapper = open(WorkspaceToolResult, { toolName: 'workspace_files', args: { action }, result: result(null) })
  expect(wrapper.get('.platform-empty').text()).toBe('No result details returned.')
})

test('write shows submitted content; edit supports an intentionally empty replacement', () => {
  const write = open(WorkspaceToolResult, { toolName: 'workspace_files', args: { action: 'write', content: 'full file' }, result: result({ operationId: 'op', hashes: { 'a.ts': 'h' } }) })
  expect(write.get('.mutation-receipt').text()).toBe('File written')
  expect(write.get('.platform-section-title').text()).toBe('Requested file content')
  expect(write.get('.platform-text').text()).toBe('full file')
  const edit = open(WorkspaceToolResult, { toolName: 'workspace_files', args: { action: 'edit', oldText: 'remove me', newText: '' }, result: result({ operationId: 'op' }) })
  expect(edit.findAll('.file-replacement pre').map(pre => pre.text())).toEqual(['remove me', ''])
})

test('delete never reports success while waiting or failed', async () => {
  const wrapper = open(WorkspaceToolResult, { toolName: 'workspace_files', args: { action: 'delete', path: 'a.ts' }, status: 'awaiting_approval' })
  expect(wrapper.find('.result-waiting').exists()).toBe(true)
  expect(wrapper.find('.mutation-receipt').exists()).toBe(false)
  await wrapper.setProps({ status: 'error', result: { success: false, error: 'FILE_CONFLICT' } })
  expect(wrapper.get('[role="alert"]').text()).toContain('FILE_CONFLICT')
  expect(wrapper.find('.mutation-receipt').exists()).toBe(false)
  await wrapper.setProps({ status: 'success', result: { success: true } })
  expect(wrapper.get('.mutation-receipt').text()).toBe('File deleted')
})

test('contradictory failure receipts suppress file success and process input acknowledgements', () => {
  const file = open(WorkspaceToolResult, { toolName: 'workspace_files', args: { action: 'delete' }, result: { success: true, error: 'not applied' } })
  expect(file.find('.mutation-receipt').exists()).toBe(false)
  const process = open(ProcessToolResult, { toolName: 'process_session', args: { action: 'input', text: 'input' }, error: 'input rejected', result: result({ output: 'earlier output', running: true }) })
  expect(process.get('.result-section').text()).not.toContain('Sent input')
})

test('bounded file results reveal locally without executing a new tool', async () => {
  const wrapper = open(WorkspaceToolResult, { toolName: 'search_files', args: { query: 'q' }, result: result({ matches: Array.from({ length: 100 }, (_, index) => ({ path: 'file', line: index + 1, text: `q-${index}` })) }) })
  expect(wrapper.findAll('.file-hits .platform-text')).toHaveLength(40)
  await wrapper.get('button.platform-more').trigger('click')
  expect(wrapper.findAll('.file-hits .platform-text')).toHaveLength(80)
})

test('long text preserves the tail after local expansion and resets for a new payload', async () => {
  const wrapper = open(PlatformText, { text: 'x'.repeat(15000) + '\nEND', code: true })
  expect(wrapper.get('pre').text()).toHaveLength(12000)
  await wrapper.get('button').trigger('click')
  expect(wrapper.get('pre').text()).toContain('END')
  await wrapper.setProps({ text: 'y'.repeat(16000) })
  expect(wrapper.get('pre').text()).toHaveLength(12000)
})

test('run_command shows the executable and separate arguments, not a fictitious shell command', () => {
  const wrapper = open(ProcessToolResult, { toolName: 'run_command', args: { command: 'node', args: ['script.js', 'a b', '|'] }, result: result({ id: 'process-hidden', running: true, exitCode: null, output: 'server ready', truncated: false }) })
  expect(wrapper.findAll('.process-argument').map(item => item.text())).toEqual(['"script.js"', '"a b"', '"|"'])
  expect(wrapper.get('.process-state').text()).toBe('Process is still running')
  expect(wrapper.get('.platform-text').text()).toBe('server ready')
  expect(wrapper.find('.process-exit-code').exists()).toBe(false)
  expect(wrapper.get('.result-section').text()).not.toContain('process-hidden')
})

test.each([0, 2, null])('process exit code %s is not inferred from the tool success flag', code => {
  const wrapper = open(ProcessToolResult, { toolName: 'process_session', args: { action: 'read', id: 'p' }, result: result({ running: false, exitCode: code, output: 'last output', truncated: true }) })
  expect(wrapper.get('.process-state').text()).toBe('Process exited')
  expect(wrapper.get('.process-state').classes().includes('failed')).toBe(code === 2)
  expect(wrapper.find('.process-exit-code').exists()).toBe(code !== null)
  expect(wrapper.get('.platform-notice.warning').text()).toContain('earlier output was truncated')
})

test('process input and stop obey returned state; missing data does not fabricate an exit', () => {
  const input = open(ProcessToolResult, { toolName: 'process_session', args: { action: 'input', text: 'yes\n' }, result: result({ running: true, output: '' }) })
  expect(input.get('.process-state').text()).toContain('still running')
  expect(input.text()).toContain('Sent input')
  const stop = open(ProcessToolResult, { toolName: 'process_session', args: { action: 'stop' }, result: result({ output: 'stopping' }) })
  expect(stop.get('.process-state').text()).toBe('Process state not returned')
})

test('process failure keeps available output and never acknowledges rejected input', () => {
  const wrapper = open(ProcessToolResult, { toolName: 'process_session', args: { action: 'input', text: 'do not send' }, result: { success: false, error: 'not accessible', data: { output: '<img src=x onerror=alert(1)>', running: false } } })
  expect(wrapper.get('[role="alert"]').text()).toContain('not accessible')
  expect(wrapper.get('.platform-text').text()).toContain('<img')
  expect(wrapper.find('img').exists()).toBe(false)
  expect(wrapper.get('.result-section').text()).not.toContain('Sent input')
})
