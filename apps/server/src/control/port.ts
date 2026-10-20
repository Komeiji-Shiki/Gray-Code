import type { ControlApiStatus } from '@graycode/contracts';

export interface ControlApiHost {
  /** 外部应用仍连接时，关闭主窗口后继续由后台持有服务。 */
  readonly keepsAlive: boolean;
  initialize(): Promise<void>;
  status(): ControlApiStatus;
  accessToken(): Promise<string>;
  start(): Promise<ControlApiStatus>;
  stop(): void;
  close(): Promise<void>;
}
