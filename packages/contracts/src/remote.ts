export interface RemoteAccessSettings {
  enabled: boolean;
  /** 0 由系统选择可用端口；固定代理应指定端口。 */
  port: number;
  publicOrigin?: string;
  credentialRef?: string;
  /** 允许同一局域网内的浏览器通过 HTTP 直接访问；默认只监听回环地址。 */
  allowLan?: boolean;
}
export interface WebConnectionInfo {
  id: string;
  name: string;
  kind: 'browser' | 'api';
  createdAt: number;
  lastSeenAt: number;
  expiresAt?: number;
  connected: boolean;
}
export interface RemoteAccessStatus {
  available: boolean;
  source: 'settings' | 'command_line';
  state: 'disabled' | 'stopped' | 'starting' | 'listening' | 'stopping' | 'error';
  enabled: boolean;
  deviceName: string;
  configuredPort: number;
  credentialRef?: string;
  port?: number;
  localAddress?: string;
  address?: string;
  /** 启用局域网直连时的浏览器访问地址。 */
  lanAddress?: string;
  error?: string;
  connections: WebConnectionInfo[];
  eventStream?: EventStreamStatistics;
}
export interface EventStreamStatistics {
  connections: number; replayEvents: number; replayBytes: number; backlogResets: number; queuedBytes: number;
}
export interface RuntimeDiagnostics {
  activeRuns: number; registeredTools: number; compiledToolSchemas: number; managedProcesses: number;
  eventStream?: EventStreamStatistics;
}
