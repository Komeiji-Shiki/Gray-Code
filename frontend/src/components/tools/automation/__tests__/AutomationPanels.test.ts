import { mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { setLanguage } from '../../../../i18n'
import { DefaultToolResult, getToolConfig } from '../../../../utils/toolRegistry'
import '../../../../utils/tools/automation'
import BrowserToolPanel from '../BrowserToolPanel.vue'
import ComputerToolPanel from '../ComputerToolPanel.vue'
import PetControlPanel from '../PetControlPanel.vue'
import BotAttachmentPanel from '../BotAttachmentPanel.vue'
import { fileSize, safeAutomationResult } from '../automationResult'

const wrappers: VueWrapper[] = []
const track = <T extends VueWrapper>(wrapper: T): T => { wrappers.push(wrapper); return wrapper }
beforeEach(() => setLanguage('zh-CN'))
afterEach(() => { wrappers.splice(0).forEach(wrapper => wrapper.unmount()); setLanguage('auto') })
const screenshot = { mimeType: 'image/png', data: 'aGVsbG8=', name: 'fixture.png' }
const windowInfo = { id: '105', title: 'Editor fixture', processId: 42, executable: 'editor.exe', foreground: true, minimized: false, dpi: 144, bounds: { x: 0, y: 0, width: 1200, height: 800 } }
async function openRaw(wrapper: VueWrapper) {
  const details = wrapper.find<HTMLDetailsElement>('.result-raw'); details.element.open = true; await details.trigger('toggle')
}

test('十种工具注册到四个语义面板，保留按需加载，不提供重放动作按钮', () => {
  const names = ['browser_tabs', 'browser_read', 'browser_action', 'browser_files', 'computer_windows', 'computer_observe', 'computer_control', 'computer_action', 'pet_control', 'bot_read_attachment']
  for (const name of names) {
    const config = getToolConfig(name)!
    expect(config.contentComponent).not.toBe(DefaultToolResult)
    expect(config.actions).toBeUndefined()
  }
  expect(getToolConfig('browser_read')!.contentComponent).toBe(getToolConfig('browser_action')!.contentComponent)
  expect(getToolConfig('browser_read')!.descriptionFormatter({ action: 'screenshot', tabId: 'tab-1' })).toBe('截图 · tab-1')
  expect(getToolConfig('future_automation_tool')!.contentComponent).toBe(DefaultToolResult)
})

test('标签列表直接呈现名称、网址、控制状态和登录配置，长列表有界', async () => {
  const wrapper = track(mount(BrowserToolPanel, { props: { toolName: 'browser_tabs', args: { action: 'list' }, result: { success: true, data: {
    activeTabId: 'tab-0', profiles: [{ id: 'profile-1', name: 'Work profile' }],
    tabs: Array.from({ length: 45 }, (_, index) => ({ id: `tab-${index}`, title: `Page ${index}`, url: `https://example.com/${index}`, profileId: 'profile-1', loading: false, userControlled: index === 0, controlledBy: index === 1 ? { runId: 'run-1' } : undefined })),
  } } } }))
  expect(wrapper.findAll('.browser-tabs>li')).toHaveLength(40)
  expect(wrapper.find('.browser-tabs>li.is-active').text()).toContain('用户已接管')
  expect(wrapper.find('.automation-link').attributes('href')).toBe('https://example.com/0')
  expect(wrapper.text()).toContain('Work profile'); expect(wrapper.text()).toContain('run-1')
  await wrapper.find('.automation-more').trigger('click'); expect(wrapper.findAll('.browser-tabs>li')).toHaveLength(45)
  expect(wrapper.findAll('button').some(button => /关闭|取得控制|重新加载/.test(button.text()))).toBe(false)
})

test('创建/显示/关闭标签和独立截图按真实动作结果展示', async () => {
  const wrapper = track(mount(BrowserToolPanel, { props: { toolName: 'browser_tabs', args: { action: 'create' }, result: { success: true, data: { id: 'new-tab', title: 'New page', url: 'https://example.com/new', profileId: 'work', userControlled: false } } } }))
  expect(wrapper.find('.current-page').text()).toContain('New page')
  expect(wrapper.find('.current-page').text()).toContain('new-tab')
  await wrapper.setProps({ args: { action: 'show', tabId: 'new-tab' }, result: { success: true, data: { id: 'new-tab', title: 'New page', url: 'https://example.com/new', windowVisible: false } } })
  expect(wrapper.find('.current-page').text()).toContain('工作台窗口可见 · 否')
  await wrapper.setProps({ args: { action: 'close', tabId: 'new-tab' }, result: { success: true } })
  expect(wrapper.text()).toContain('操作已完成，没有额外输出')
  await wrapper.setProps({ toolName: 'browser_read', args: { action: 'screenshot', tabId: 'new-tab' }, result: { success: true, data: { id: 'obs-browser', tabId: 'new-tab', url: 'https://example.com', coordinateSpace: 'image', capturedAt: 1000, screenshot: { mimeType: 'image/png', width: 1280, height: 720 }, viewport: { width: 1100, height: 800, scrollX: 0, scrollY: 0, zoomFactor: 1 } }, attachments: [screenshot] } })
  expect(wrapper.text()).toContain('obs-browser'); expect(wrapper.text()).toContain('1280 × 720')
  expect(wrapper.find('img').exists()).toBe(true)
  expect(wrapper.text()).not.toContain(screenshot.data)
})

test('页面compact和full快照分别展示正文、引用和节点状态，网页HTML不执行', async () => {
  const wrapper = track(mount(BrowserToolPanel, { props: { toolName: 'browser_read', args: { action: 'snapshot' }, result: { success: true, data: { title: 'Docs', url: 'https://example.com', format: 'compact', nodes: ['[a1] heading "<img src=x onerror=alert(1)>"'], frames: [], truncated: true } } } }))
  expect(wrapper.find('.page-snapshot').text()).toContain('[a1] heading')
  expect(wrapper.find('img').exists()).toBe(false)
  expect(wrapper.text()).toContain('结果已截断')
  await wrapper.setProps({ result: { success: true, data: { title: 'Docs', nodes: [{ ref: 'a2', depth: 1, role: 'textbox', name: 'Search', value: '0', disabled: false }], format: 'full', truncated: false } } })
  expect(wrapper.find('.snapshot-node').text()).toContain('[a2]')
  expect(wrapper.find('.snapshot-node').text()).toContain('Search')
  expect(wrapper.find('.snapshot-node .automation-pre').text()).toBe('0')
  expect(wrapper.find('.snapshot-node').text()).toContain('否')
})

test('日志有明确类型、正文和续读游标，零游标与空日志不丢失', async () => {
  const wrapper = track(mount(BrowserToolPanel, { props: { toolName: 'browser_read', args: { action: 'logs' }, result: { success: true, data: { entries: [{ cursor: 1, time: 0, kind: 'error', text: 'Network unavailable' }], nextCursor: 1, capacity: 200, truncated: false } } } }))
  expect(wrapper.find('.page-logs').text()).toContain('Network unavailable')
  expect(wrapper.find('.page-logs .is-error').text()).toBe('error')
  await wrapper.setProps({ result: { success: true, data: { entries: [], nextCursor: 0, truncated: false } } })
  expect(wrapper.text()).toContain('没有新日志'); expect(wrapper.text()).toContain('续读游标 0')
})

test('浏览器筛选展示匹配总数、续查位置、链接与等待的实际结果', async () => {
  const wrapper = track(mount(BrowserToolPanel, { props: { toolName: 'browser_read', args: { action: 'snapshot' }, result: { success: true, data: {
    nodes: [{ ref: 'paper', role: 'link', name: 'Research paper', description: 'Full text', url: 'https://example.com/paper' }],
    returned: 1, total: 31, nextOffset: 11, partial: true,
  } } } }))
  expect(wrapper.text()).toContain('本次返回 1 项，共匹配 31 项')
  expect(wrapper.text()).toContain('续查位置：11'); expect(wrapper.text()).toContain('结果不完整')
  expect(wrapper.find('.snapshot-node a').attributes('href')).toBe('https://example.com/paper')
  expect(wrapper.find('.snapshot-node').text()).toContain('Full text')
  await wrapper.setProps({ args: { action: 'wait' }, result: { success: false, data: { conditionMet: false, timedOut: true, nodes: [] } } })
  expect(wrapper.text()).toContain('等待结束，页面尚未满足条件')
  expect(wrapper.text()).not.toContain('页面已满足等待条件')
  await wrapper.setProps({ result: { success: true, data: { conditionMet: true, timedOut: false, nodes: [] } } })
  expect(wrapper.text()).toContain('页面已满足等待条件')
})

test('动作已完成与后续截图失败独立展示，原始详情也不泄漏图像编码', async () => {
  const wrapper = track(mount(BrowserToolPanel, { props: { toolName: 'browser_action', args: { action: 'click', tabId: 'tab-1' }, result: { success: true, data: { status: 'completed', repeated: true, operationId: 'op-1', title: 'Done', url: 'https://example.com', observationError: { code: 'CAPTURE_FAILED', message: 'Capture not available' } }, attachments: [screenshot] } } }))
  expect(wrapper.find('.action-status').text()).toBe('已完成')
  expect(wrapper.find('.observation-error').text()).toContain('不改变动作结果')
  expect(wrapper.text()).toContain('未重复执行')
  expect(wrapper.find('img').attributes('src')).toBe('data:image/png;base64,aGVsbG8=')
  await openRaw(wrapper)
  expect(wrapper.text()).not.toContain(screenshot.data)
  expect(wrapper.find('.result-raw').text()).toContain('op-1')
})

test('动作后嵌套快照显示新引用与分页，快照失败不覆盖已完成状态', async () => {
  const wrapper = track(mount(BrowserToolPanel, { props: { toolName: 'browser_action', args: { action: 'click', after: 'both' }, result: { success: true, data: {
    status: 'completed', title: 'Next page', url: 'https://example.com/next',
    snapshot: { nodes: ['[fresh-ref] button Next'], total: 3, nextOffset: 1, partial: true, truncated: true, frames: [{ frameId: 'main', url: 'https://example.com/next' }] },
    observationError: { message: 'Screenshot failed; read again' },
  } } } }))
  expect(wrapper.find('.page-snapshot').text()).toContain('[fresh-ref]')
  expect(wrapper.text()).toContain('本次返回 1 项，共匹配 3 项'); expect(wrapper.text()).toContain('续查位置：1')
  expect(wrapper.find('.current-page').text()).toContain('Next page')
  await wrapper.setProps({ result: { success: true, data: { status: 'completed', observationError: { message: 'Screenshot failed' }, snapshotError: { message: 'Snapshot failed' } } } })
  expect(wrapper.findAll('.observation-error')).toHaveLength(2)
  expect(wrapper.find('.action-status').text()).toBe('已完成'); expect(wrapper.text()).toContain('Snapshot failed')
})

test('未知/失败动作不被展示为已完成', () => {
  const wrapper = track(mount(BrowserToolPanel, { props: { toolName: 'browser_action', args: { action: 'click' }, result: { success: false, code: 'BROWSER_ACTION_UNKNOWN', error: 'Disconnected', data: { status: 'unknown', repeated: true } } } }))
  expect(wrapper.find('[role="alert"]').text()).toContain('Disconnected')
  expect(wrapper.find('.action-status').text()).toBe('结果未确认')
  expect(wrapper.find('.action-status.is-good').exists()).toBe(false)
})

test('上传/下载呈现实际文件清单、目的路径和字节大小', async () => {
  const wrapper = track(mount(BrowserToolPanel, { props: { toolName: 'browser_files', args: { action: 'upload' }, result: { success: true, data: { files: ['alpha.txt', 'beta.md'], count: 2 } } } }))
  expect(wrapper.find('.browser-transfer').text()).toContain('已放入文件选择控件')
  expect(wrapper.find('.browser-transfer').text()).toContain('beta.md')
  await wrapper.setProps({ args: { action: 'download' }, result: { success: true, data: { path: 'output/empty.txt', filename: 'empty.txt', bytes: 0, url: 'https://example.com/download' } } })
  expect(wrapper.find('.browser-transfer').text()).toContain('output/empty.txt')
  expect(wrapper.find('.browser-transfer').text()).toContain('0 B')
  expect(wrapper.find('.current-page').exists()).toBe(false)
})

test('窗口列表优先标题/进程/状态，显示器返回实际尺寸', () => {
  const wrapper = track(mount(ComputerToolPanel, { props: { toolName: 'computer_windows', args: {}, result: { success: true, data: { windows: [windowInfo], displays: [{ id: 'display-1', primary: true, bounds: { width: 1920, height: 1080 }, scaleFactor: 1.25 }], coordinateSystem: 'physical-screen-pixels' } } } }))
  expect(wrapper.find('.computer-windows').text()).toContain('Editor fixture')
  expect(wrapper.find('.computer-windows').text()).toContain('前台窗口')
  expect(wrapper.find('.computer-windows').text()).toContain('editor.exe')
  expect(wrapper.find('.computer-displays').text()).toContain('1920 × 1080')
})

test('电脑控制成功查询但未控制，不误报取得控制；错误与人工接管可见', async () => {
  const wrapper = track(mount(ComputerToolPanel, { props: { toolName: 'computer_control', args: { action: 'status' }, result: { success: true, data: { active: false, available: false, reason: 'user_input', pausedRunId: 'paused-1', error: 'Host unavailable', stopShortcut: 'Ctrl+Alt+Esc', stopShortcutRegistered: false } } } }))
  expect(wrapper.find('.control-state').text()).toBe('未控制')
  expect(wrapper.find('.control-state.is-good').exists()).toBe(false)
  expect(wrapper.find('[role="alert"]').text()).toContain('Host unavailable')
  expect(wrapper.text()).toContain('paused-1')
  expect(wrapper.find('.computer-control kbd + .automation-badge').text()).toBe('不可用')
  await wrapper.setProps({ result: { success: true, data: { active: true, available: true, reason: 'acquired', controller: { actorId: 'owner', runId: 'run-2', windowIds: ['105'] } } } })
  expect(wrapper.find('.control-state').text()).toBe('控制中'); expect(wrapper.text()).toContain('run-2')
})

test('窗口观察呈现焦点/控件及图片，兼容旧历史内嵌截图', async () => {
  const wrapper = track(mount(ComputerToolPanel, { props: { toolName: 'computer_observe', args: { windowId: '105' }, result: { success: true, data: { id: 'obs-1', capturedAt: 0, window: windowInfo, screenshot: { ...screenshot, width: 800, height: 600 }, coordinateSpace: 'image', focusedElementId: 'e1', elements: [{ id: 'e1', type: 'Edit', name: 'Query input', value: 'hello', focused: true }], truncated: false } } } }))
  expect(wrapper.text()).toContain('obs-1'); expect(wrapper.text()).toContain('800 × 600')
  expect(wrapper.find('.computer-elements').text()).toContain('hello')
  expect(wrapper.find('.computer-elements .is-active').text()).toContain('已聚焦')
  expect(wrapper.find('img').exists()).toBe(true)
  await openRaw(wrapper); expect(wrapper.text()).not.toContain(screenshot.data)
})

test('电脑动作截图失败不更改动作回执；错误观察仍保留窗口输出', () => {
  const action = track(mount(ComputerToolPanel, { props: { toolName: 'computer_action', args: { action: 'key' }, result: { success: true, data: { status: 'completed', windowId: '105', observationError: { code: 'CAPTURE_FAILED', message: 'No frame' } } } } }))
  expect(action.find('.action-status').text()).toBe('已完成'); expect(action.text()).toContain('No frame'); expect(action.text()).toContain('105')
  const observe = track(mount(ComputerToolPanel, { props: { toolName: 'computer_observe', args: {}, result: { success: true, data: { window: windowInfo, elements: [], accessibilityError: 'Access denied' } } } }))
  expect(observe.text()).toContain('Editor fixture'); expect(observe.text()).toContain('Access denied')
})

test('桌宠查询显示真实动作/表情和含零值的实际参数范围，不用固定动作名单', () => {
  const wrapper = track(mount(PetControlPanel, { props: { toolName: 'pet_control', args: { action: 'query' }, result: { success: true, data: { configuration: { visible: true, stopped: false }, resource: { id: 'pet-1', name: 'Fixture pet', kind: 'live2d', actions: [{ id: 'wave-custom', name: 'Custom wave', durationMs: 750 }], expressions: [{ id: 'smile-2', name: 'Soft smile' }] }, state: { phase: 'ready', parameters: [{ id: 'ParamEyeX', min: -1, max: 1, default: 0 }] } } } } }))
  expect(wrapper.find('.pet-actions').text()).toContain('wave-custom')
  expect(wrapper.find('.pet-expressions').text()).toContain('Soft smile')
  expect(wrapper.find('.pet-parameters').text()).toContain('ParamEyeX')
  expect(wrapper.find('.pet-parameters tbody tr').text()).toContain('-1 … 1')
  expect(wrapper.find('.pet-parameters tbody tr td:last-child').text()).toBe('0')
})

test('桌宠接受与实际应用分开表达，失败不伪装应用；实际命令参数直接显示', async () => {
  const wrapper = track(mount(PetControlPanel, { props: { toolName: 'pet_control', args: { action: 'look', angle: 0 }, result: { success: false, accepted: true, applied: false, error: 'Player confirmation timeout' } } }))
  expect(wrapper.find('.pet-accepted').text()).toBe('请求已接受')
  expect(wrapper.find('.pet-applied').text()).toBe('播放器未确认应用')
  expect(wrapper.find('.pet-applied.is-good').exists()).toBe(false)
  expect(wrapper.find('[role="alert"]').text()).toContain('timeout')
  await wrapper.setProps({ result: { success: true, accepted: true, applied: true, command: { requestId: 'req-1', action: 'look', at: 123 }, state: { current: { requestId: 'req-1', action: 'look', angle: 0, parameters: { ParamX: 0 }, createdAt: 1000, expiresAt: 7000 } } } })
  expect(wrapper.find('.pet-applied').text()).toBe('播放器已确认应用')
  expect(wrapper.find('.pet-command').text()).toContain('0°')
  expect(wrapper.find('.pet-command').text()).toContain('6000 ms')
  expect(wrapper.find('.pet-command').text()).toContain('ParamX')
})

test('附件list/stat/read使用真实平铺结构，正文安全、范围和续读偏移准确', async () => {
  const doc = { id: 'doc-1', name: 'notes.md', path: '/fixture/notes.md', sizeBytes: 2048, encoding: 'utf-8' }
  const wrapper = track(mount(BotAttachmentPanel, { props: { toolName: 'bot_read_attachment', args: { action: 'list' }, result: { success: true, documents: [doc] } } }))
  expect(wrapper.find('.attachment-directory').text()).toContain('notes.md')
  expect(wrapper.find('.attachment-directory').text()).toContain('2.0 KiB')
  await wrapper.setProps({ args: { action: 'stat', id: 'doc-1' }, result: { success: true, ...doc } })
  expect(wrapper.find('.attachment-document').text()).toContain('utf-8')
  expect(wrapper.find('.attachment-body').exists()).toBe(false)
  const body = '<script>alert(1)</script>\n# Document'
  await wrapper.setProps({ args: { action: 'read', id: 'doc-1' }, result: { success: true, ...doc, offset: 0, text: body, truncated: true, nextOffset: body.length } })
  expect(wrapper.find('.attachment-body').text()).toContain(body)
  expect(wrapper.find('.attachment-body script').exists()).toBe(false)
  expect(wrapper.find('.attachment-next').text()).toContain(String(body.length))
  expect(wrapper.find('.attachment-body').text()).toContain(`字符范围 0–${body.length}`)
  await wrapper.setProps({ result: { success: true, ...doc, offset: 100, text: '', truncated: false } })
  expect(wrapper.text()).toContain('此范围没有正文'); expect(wrapper.text()).toContain('已到文档末尾')
})

test('等待/空/失败状态跨组保留，语言切换不需要重新挂载', async () => {
  for (const component of [BrowserToolPanel, ComputerToolPanel, PetControlPanel, BotAttachmentPanel]) {
    const waiting = track(mount(component, { props: { args: { action: 'list' }, status: 'executing' } }))
    expect(waiting.find('[role="status"]').text()).toContain('等待工具返回结果')
    expect(waiting.find('.result-parameters').attributes()).toHaveProperty('open')
    await waiting.setProps({ status: 'error', result: { success: false, error: 'Unavailable' } })
    expect(waiting.find('[role="alert"]').text()).toContain('Unavailable')
  }
  const empty = track(mount(BrowserToolPanel, { props: { toolName: 'browser_tabs', args: { action: 'list' }, result: { success: true, data: { tabs: [], profiles: [] } } } }))
  expect(empty.text()).toContain('没有打开的标签页')
  setLanguage('en'); await empty.vm.$nextTick(); expect(empty.text()).toContain('No open tabs')
  setLanguage('ja'); await empty.vm.$nextTick(); expect(empty.text()).toContain('開いているタブはありません')
})

test('未知/损坏图片编码只保留大小说明，不经通用详情泄漏或远程请求', async () => {
  const encoded = 'UNSUPPORTED_PAYLOAD_'.repeat(1000)
  const wrapper = track(mount(ComputerToolPanel, { props: { toolName: 'computer_observe', args: {}, result: { success: true, data: { id: 'obs-1', screenshot: { mimeType: 'image/svg+xml', data: encoded, width: 100, height: 100 } } } } }))
  await openRaw(wrapper)
  expect(wrapper.find('img').exists()).toBe(false)
  expect(wrapper.text()).not.toContain('UNSUPPORTED_PAYLOAD_')
  expect(safeAutomationResult({ screenshot: { data: encoded } })).toEqual({ screenshot: { data: `[image: ${encoded.length} chars]` } })
  expect(fileSize(0)).toBe('0 B')
})
