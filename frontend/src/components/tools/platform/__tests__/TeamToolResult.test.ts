import { mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { setLanguage } from '../../../../i18n'
import TeamToolResult from '../TeamToolResult.vue'

const wrappers: VueWrapper[] = []
function open(props: Record<string, unknown>) { const wrapper = mount(TeamToolResult, { props }); wrappers.push(wrapper); return wrapper }
const task = { id: 'hidden-task', title: 'Verify platform', description: 'Check the recorded payload, not the request.', status: 'in_progress', owner: 'hidden-owner', creator: 'main', revision: 2, dependencies: ['dependency-id'], createdSequence: 4, updatedSequence: 5 }
beforeEach(() => setLanguage('en'))
afterEach(() => { wrappers.splice(0).forEach(wrapper => wrapper.unmount()); setLanguage('auto') })

test('team list exposes status, resolved dependency titles, blocked count and pagination', async () => {
  const wrapper = open({ toolName: 'team_tasks', args: { action: 'list' }, result: { success: true, tasks: [{ ...task, blockedBy: ['dependency-id'] }, { id: 'dependency-id', title: 'Prepare fixture', status: 'pending', dependencies: [] }], readyTaskIds: ['dependency-id'], hasMore: true, nextAfterCreatedSequence: 8, sequence: 10 } })
  expect(wrapper.findAll('.team-task')).toHaveLength(2)
  expect(wrapper.get('.team-task .platform-status').text()).toBe('In progress')
  expect(wrapper.get('.task-dependency-titles').text()).toBe('Prepare fixture')
  expect(wrapper.get('.task-blocked').text()).toBe('1 unfinished dependencies')
  expect(wrapper.get('.ready-tasks').text()).toContain('1 tasks ready to claim')
  expect(wrapper.get('.continuation').text()).toContain('sequence 8')
  expect(wrapper.get('.result-section').text()).not.toContain('hidden-owner')
  const details = wrapper.get<HTMLDetailsElement>('.team-task .tool-receipt-details'); details.element.open = true; await details.trigger('toggle')
  expect(details.text()).toContain('hidden-owner')
})

test.each(['get', 'create', 'claim', 'claim_ready', 'complete', 'release', 'set_dependencies'])('%s uses the returned task state rather than the action name', action => {
  const wrapper = open({ toolName: 'team_tasks', args: { action }, result: { success: true, task: { ...task, status: 'pending', owner: undefined }, sequence: 6 } })
  expect(wrapper.get('.team-task .platform-status').text()).toBe('Pending')
  expect(wrapper.get('.team-task').text()).toContain('Unclaimed')
  expect(wrapper.get('.team-task').text()).toContain(task.description)
  expect(wrapper.find('.task-blocked').exists()).toBe(false)
})

test('completed task keeps full structured-looking output as literal content', () => {
  const wrapper = open({ toolName: 'team_tasks', args: { action: 'complete' }, result: { success: true, task: { ...task, status: 'completed', result: '{"checks":["one","two"],"safe":"<script>"}' }, sequence: 7 } })
  expect(wrapper.get('.team-task .platform-status').text()).toBe('Completed')
  expect(wrapper.get('.team-task').text()).toContain('"checks":["one","two"]')
  expect(wrapper.find('script').exists()).toBe(false)
})

test('claim_ready null differs from an empty list and a missing task', () => {
  const emptyClaim = open({ toolName: 'team_tasks', args: { action: 'claim_ready' }, result: { success: true, task: null, readyTaskIds: [] } })
  expect(emptyClaim.get('.platform-empty').text()).toBe('No task is ready to claim')
  const emptyList = open({ toolName: 'team_tasks', args: { action: 'list' }, result: { success: true, tasks: [] } })
  expect(emptyList.get('.platform-empty').text()).toBe('No tasks returned')
  const missing = open({ toolName: 'team_tasks', args: { action: 'complete' }, result: { success: true } })
  expect(missing.get('.platform-empty').text()).toBe('No result details returned.')
})

test('wait displays chronological event meanings and returned continuation sequence', () => {
  const wrapper = open({ toolName: 'team_wait', args: { afterSequence: 2 }, result: { success: true, reason: 'events', sequence: 4, latestSequence: 6, hasMore: true, readyTaskIds: [], noProgress: false, events: [{ type: 'task.completed', taskId: 'internal-task', sequence: 3, memberId: 'worker' }, { type: 'member.changed', status: 'failed', sequence: 4, memberId: 'worker' }] } })
  expect(wrapper.findAll('.team-event').map(event => event.find('.platform-card-title').text())).toEqual(['Task completed', 'Member state changedFailed'])
  expect(wrapper.get('.continuation').text()).toContain('sequence 4')
  expect(wrapper.get('.result-section').text()).not.toContain('internal-task')
})

test.each([
  ['timeout', false, 'Wait timed out with no new events'],
  ['no_progress', true, 'No progress is currently possible'],
  ['ready_work', false, 'Work is ready to claim'],
])('wait %s is informational, not a failed or completed task', (reason, noProgress, title) => {
  const wrapper = open({ toolName: 'team_wait', args: { afterSequence: 0 }, result: { success: true, reason, noProgress, events: [], readyTaskIds: reason === 'ready_work' ? ['ready'] : [], sequence: 0 } })
  expect(wrapper.get('.wait-reason').text()).toBe(title)
  expect(wrapper.find('.no-progress').exists()).toBe(noProgress)
  expect(wrapper.find('.team-task').exists()).toBe(false)
  expect(wrapper.find('[role="alert"]').exists()).toBe(false)
})

test('pending and failed team operations do not fabricate task transitions', () => {
  const pending = open({ toolName: 'team_tasks', args: { action: 'complete' }, status: 'executing' })
  expect(pending.find('.result-waiting').exists()).toBe(true)
  expect(pending.find('.team-task').exists()).toBe(false)
  const failed = open({ toolName: 'team_tasks', args: { action: 'complete' }, result: { success: false, error: 'revision conflict' } })
  expect(failed.get('[role="alert"]').text()).toContain('revision conflict')
  expect(failed.find('.team-task').exists()).toBe(false)
})

test('large task and event lists mount incrementally and ignore malformed entries', async () => {
  const wrapper = open({ toolName: 'team_wait', args: {}, result: { success: true, events: [null, ...Array.from({ length: 50 }, (_, index) => ({ type: 'message.queued', sequence: index }))] } })
  expect(wrapper.findAll('.team-event')).toHaveLength(30)
  await wrapper.get('button.platform-more').trigger('click')
  expect(wrapper.findAll('.team-event')).toHaveLength(50)
  await wrapper.setProps({ result: { success: true, events: [null, 'not-an-event'] } })
  expect(wrapper.findAll('.team-event')).toHaveLength(0)
})
