/** 交互式终端由核心持有，客户端只选择视图；关闭页面不停止进程。 */
export interface InteractiveTerminalInfo {
  id: string;
  workspaceId: string;
  title: string;
  pid: number;
  createdAt: number;
  cols: number;
  rows: number;
  status: 'running' | 'exited';
  exitCode?: number;
}
export interface InteractiveTerminalSnapshot extends InteractiveTerminalInfo {
  output: string;
  /** 累计输出的 UTF-16 长度，用于衔接快照和实时事件，避免重复显示。 */
  offset: number;
}
