/**
 * SubAgent 运行时事件总线（导出类 + 全局单例）。
 *
 * 拆分说明：从 runEventBus.ts 迁出（纯移动，逻辑一字未改）。类实现 = 事件核心
 * （SubAgentRunEventBusCore）+ 持久化（SubAgentRunEventBusPersistence）的组合；
 * runEventBus.ts 仅保留 re-export 壳，事件协议与单例语义不变。
 */

import { SubAgentRunEventBusPersistence } from './persist';

export class SubAgentRunEventBus extends SubAgentRunEventBusPersistence {}

export const subAgentRunEventBus = new SubAgentRunEventBus();
