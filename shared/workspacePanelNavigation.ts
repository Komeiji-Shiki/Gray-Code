/** 仅用于当前工作台内部的界面跳转，不经过任务执行或设置写入。 */
export const WORKSPACE_PANEL_MESSAGE = 'graycode:workspace-panel';
export type WorkspacePanel = 'memory' | 'pets' | 'screenSense';
export function readWorkspacePanelMessage(event: { source: unknown; origin: string; data: unknown }, trustedSource: unknown, origin: string): WorkspacePanel | undefined {
  if (!trustedSource || event.source !== trustedSource || event.origin !== origin) return;
  const message = event.data as { type?: unknown; panel?: unknown } | null;
  if (!message || message.type !== WORKSPACE_PANEL_MESSAGE) return;
  if (message.panel === 'memory' || message.panel === 'pets' || message.panel === 'screenSense') return message.panel;
}
