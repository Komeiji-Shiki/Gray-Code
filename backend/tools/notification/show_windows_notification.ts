import * as vscode from 'vscode';
import { WinRtLingerToastAdapter } from '../../modules/notifications/WinRtLingerToastAdapter';
import { focusVSCodeWindow } from '../../modules/notifications/focusWindow';
import { createShowWindowsNotificationTool as createRuntime } from './showWindowsNotificationRuntime';
export * from './showWindowsNotificationRuntime';
export const createShowWindowsNotificationTool = (adapter: Parameters<typeof createRuntime>[0] = new WinRtLingerToastAdapter(), platform = process.platform,
  executeCommand: Parameters<typeof createRuntime>[2] = command => vscode.commands.executeCommand(command), focusWindow: Parameters<typeof createRuntime>[3] = focusVSCodeWindow) => createRuntime(adapter, platform, executeCommand, focusWindow);
export const registerShowWindowsNotification = () => createShowWindowsNotificationTool();
