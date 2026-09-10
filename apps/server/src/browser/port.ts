import type { ToolOutcome } from '@graycode/contracts';
import type { ToolContext } from '@graycode/core';

/** 浏览器实现由设备宿主注入，核心服务不依赖 Electron 或开放的 CDP 端口。 */
export interface BrowserHost {
  tool(name: string, args: Record<string, unknown>, context: ToolContext): Promise<ToolOutcome>;
  call(actorId: string, method: string, params: Record<string, unknown>): Promise<unknown>;
  finishRun(runId: string): void;
  close(): void;
}
