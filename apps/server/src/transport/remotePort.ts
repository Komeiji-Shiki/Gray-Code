import type { RemoteAccessStatus } from '@graycode/contracts';

export interface RemoteStartupOptions { port?: number; token: string; publicOrigin?: string }
export interface RemoteAccessHost {
  readonly keepsAlive: boolean;
  initialize(override?: RemoteStartupOptions): Promise<void>;
  status(): RemoteAccessStatus;
  accessToken(): Promise<string>;
  start(): Promise<RemoteAccessStatus>;
  stop(): void;
  revoke(id: string): Promise<void>;
  close(): Promise<void>;
}
