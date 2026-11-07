/** MCP 客户端启动控制桥的命令：GrayCode.exe 以 ELECTRON_RUN_AS_NODE 运行桥脚本，命令行版直接用 node。 */
export interface ControlMcpLaunch {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/** 外部应用控制 GrayCode 的 HTTP 网络端口；本机程序走常开的本机管道，不需要这里的令牌。令牌独立于网页远程访问。 */
export interface ControlApiSettings {
  enabled: boolean;
  /** 0 由系统选择可用端口。 */
  port: number;
  credentialRef?: string;
  /** 允许局域网内的外部应用通过 HTTP 访问；默认只监听回环地址。 */
  allowLan?: boolean;
}

export interface ControlApiStatus {
  state: 'disabled' | 'stopped' | 'starting' | 'listening' | 'stopping' | 'error';
  enabled: boolean;
  configuredPort: number;
  port?: number;
  localAddress?: string;
  lanAddress?: string;
  credentialRef?: string;
  error?: string;
  /** 本机管道随应用常开，与网络端口的启停无关。 */
  local: { pipe?: string; mcp?: ControlMcpLaunch; error?: string };
}
