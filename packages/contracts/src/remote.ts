export interface RemoteAccessSettings {
  enabled: boolean;
  /** 0 由系统选择可用端口；固定代理应指定端口。 */
  port: number;
  publicOrigin?: string;
  credentialRef?: string;
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
  error?: string;
  connections: WebConnectionInfo[];
}
