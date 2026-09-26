import type { PlatformApplication } from '../../../apps/server/src/application';
import type { ToolContext } from '../src/runtime/tools';
import { PlatformNotifications } from '../../../apps/server/src/notifications';
import { desktopNotifications } from '../../../apps/desktop/src/notifications';
import { activateDesktopWindow } from '../../../apps/desktop/src/windowActivation';

const mockNotifications: any[] = [];
jest.mock('electron', () => {
  const { EventEmitter } = jest.requireActual('node:events');
  return { app: new EventEmitter(), Notification: class extends EventEmitter {
    static isSupported() { return true; }
    constructor(readonly options: unknown) { super(); mockNotifications.push(this); }
    show() { this.emit('show'); }
  } };
});
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
beforeEach(() => { mockNotifications.length = 0; Object.defineProperty(process, 'platform', { value: 'win32' }); });
afterEach(() => { Object.defineProperty(process, 'platform', platform); });
const settle = () => new Promise<void>(resolve => setImmediate(resolve));

function fixture(minimized = false) {
  const calls: string[] = [];
  const settings = { ui: { sound: { quietHours: { mode: 'off' }, windowsAgentStopNotification: { enabled: true, onlyWhenWindowNotFocused: false } } } };
  const window = { isMinimized: () => minimized, restore: jest.fn(() => { calls.push('restore'); minimized = false; }),
    show: jest.fn(() => calls.push('show')), moveTop: jest.fn(() => calls.push('moveTop')), focus: jest.fn(() => calls.push('focus')),
    isFocused: () => false, getTitle: () => 'GrayCode', setAlwaysOnTop: jest.fn() };
  const notifications = new PlatformNotifications();
  const app = { notifications, product: { runtimeSettings: () => ({ getSettings: () => settings }) } } as unknown as PlatformApplication;
  const open = jest.fn(async (conversationId?: string) => {
    // Same ordering as createWindow + desktop notification navigation: activate before the first await.
    activateDesktopWindow(window);
    await Promise.resolve();
    if (conversationId) calls.push(`conversation:${conversationId}`);
  });
  const service = desktopNotifications(app, () => window as any, open);
  return { service, notifications, window, open, calls, settings };
}

test.each([true, false])('通知激活恢复/显示/普通置前/聚焦，绝不设置常驻置顶（minimized=%s）', minimized => {
  const f = fixture(minimized);
  try {
    activateDesktopWindow(f.window);
    expect(f.calls).toEqual([...(minimized ? ['restore'] : []), 'show', 'moveTop', 'focus']);
    expect(f.window.setAlwaysOnTop).not.toHaveBeenCalled();
  } finally { f.service.dispose(); }
});

test.each(['error', 'awaiting_user_action', 'continue_required'] as const)('任务 %s 通知点击先激活窗口再定位通知所属会话', async reason => {
  const f = fixture(true);
  try {
    expect(await f.service.notify({ reason, dedupeKey: reason, createdAt: Date.now(), conversationId: 'task-a' })).toMatchObject({ shown: true });
    expect(f.open).not.toHaveBeenCalled();
    mockNotifications[0].emit('click');
    expect(f.calls).toEqual(['restore', 'show', 'moveTop', 'focus']);
    await settle();
    expect(f.calls).toEqual(['restore', 'show', 'moveTop', 'focus', 'conversation:task-a']);
    mockNotifications[0].emit('click'); await settle();
    expect(f.open).toHaveBeenCalledTimes(1); expect(f.open).toHaveBeenCalledWith('task-a');
    expect(f.window.setAlwaysOnTop).not.toHaveBeenCalled();
  } finally { f.service.dispose(); }
});

test('正常完成工具通知从 ToolContext 捕获会话，而不是通知参数或点击时的当前会话', async () => {
  const f = fixture();
  try {
    const context = { signal: new AbortController().signal, actorId: 'owner', conversationId: 'finished-task' } as ToolContext;
    expect(await f.notifications.tool().execute({ title: '任务完成', message: '文件已经完成', conversationId: 'spoofed' }, context)).toMatchObject({ success: true });
    context.conversationId = 'another-task';
    mockNotifications[0].emit('click'); await settle();
    expect(f.open).toHaveBeenCalledWith('finished-task');
    expect(f.calls).toEqual(['show', 'moveTop', 'focus', 'conversation:finished-task']);
  } finally { f.service.dispose(); }
});

test.each([false, true])('应用通知遵循 openChatOnClick=%s，无会话时只激活应用', async openChatOnClick => {
  const f = fixture();
  try {
    await f.notifications.tool().execute({ title: 'GrayCode', message: '应用通知', openChatOnClick }, { signal: new AbortController().signal } as ToolContext);
    mockNotifications[0].emit('click'); await settle();
    expect(f.open).toHaveBeenCalledTimes(openChatOnClick ? 1 : 0);
    expect(f.calls).toEqual(openChatOnClick ? ['show', 'moveTop', 'focus'] : []);
  } finally { f.service.dispose(); }
});

test('点击通知的会话导航失败被记录，不产生未处理 Promise 拒绝', async () => {
  const f = fixture();
  const error = new Error('Conversation is not available');
  const logged = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await f.notifications.tool().execute({ title: '任务完成', message: '完成' }, { signal: new AbortController().signal } as ToolContext);
    f.open.mockRejectedValueOnce(error);
    mockNotifications[0].emit('click'); await settle();
    expect(logged).toHaveBeenCalledWith('[desktop-notification] Failed to open notification:', error);
  } finally { f.service.dispose(); logged.mockRestore(); }
});

test('免打扰不变，预览通知仍可以激活应用但不切换会话', async () => {
  const f = fixture();
  try {
    f.settings.ui.sound.quietHours.mode = 'always';
    expect(await f.service.notify({ reason: 'error', dedupeKey: 'quiet', createdAt: Date.now() })).toMatchObject({ shown: false, reason: 'do_not_disturb' });
    expect(mockNotifications).toHaveLength(0);
    f.settings.ui.sound.quietHours.mode = 'off';
    expect(await f.service.preview({ reason: 'error' })).toMatchObject({ shown: true });
    mockNotifications[0].emit('click'); await settle();
    expect(f.open).toHaveBeenCalledWith(undefined); expect(f.calls).toEqual(['show', 'moveTop', 'focus']);
  } finally { f.service.dispose(); }
});
