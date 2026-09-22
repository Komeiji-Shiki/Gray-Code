import type { WorkspacePanel } from '@shared/workspacePanelNavigation';
/** The same UI runs in the extension and the independent desktop host. */
export interface HostTransport {
  /** 独立宿主的客户端类型；旧扩展无需提供。 */
  kind?: 'desktop' | 'web';
  /** 在当前工作台打开专用配置面板，保留设置页草稿。 */
  openWorkspacePanel?(panel: WorkspacePanel): void;
  /** 桌面宿主通过原生剪贴板复制，避免浏览器权限限制。 */
  writeClipboardText?(text: string): Promise<void>;
  getDefaultPromptModeId?(): string;
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
  subscribe?(listener: (message: unknown) => void): () => void;
}
declare global {
  interface Window { __GRAYCODE_HOST?: HostTransport }
}
let transport: HostTransport | undefined;
export function getHostTransport(): HostTransport {
  return transport ??= window.__GRAYCODE_HOST ?? acquireVsCodeApi();
}
