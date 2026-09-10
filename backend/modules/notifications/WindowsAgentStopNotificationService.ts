import * as vscode from 'vscode';
import { WindowsAgentStopNotificationService as Runtime, type WindowsAgentStopNotificationServiceOptions as RuntimeOptions } from './AgentStopNotificationRuntime';
import { NodeNotifierWindowsToastAdapter } from './WindowsToastAdapter';
import { deriveWindowsAgentStopWindowTitle } from './windowTitle';
import { focusVSCodeWindow } from './focusWindow';
export type WindowsAgentStopNotificationServiceOptions = Pick<RuntimeOptions, 'settingsManager'> & Partial<Omit<RuntimeOptions, 'settingsManager'>>;
/** 扩展入口提供窗口与通知宿主，共享层保留原过滤、模板与去重逻辑。 */
export class WindowsAgentStopNotificationService extends Runtime {
  constructor(options: WindowsAgentStopNotificationServiceOptions) {
    super({ ...options, adapter: options.adapter ?? new NodeNotifierWindowsToastAdapter(),
      getWindowState: options.getWindowState ?? (() => vscode.window.state),
      onDidChangeWindowState: options.onDidChangeWindowState ?? vscode.window.onDidChangeWindowState,
      executeCommand: options.executeCommand ?? (command => vscode.commands.executeCommand(command)),
      focusWindow: options.focusWindow ?? focusVSCodeWindow, getWindowTitle: options.getWindowTitle ?? deriveWindowsAgentStopWindowTitle });
  }
}
