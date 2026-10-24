/** 外部应用控制 GrayCode 的 HTTP 接口；令牌独立于网页远程访问。 */
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
}
