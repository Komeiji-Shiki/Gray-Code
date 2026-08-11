/**
 * GrayCode - Windows 通知模块
 *
 * 提供 Windows Agent 停止通知（toast）相关能力：
 * - WindowsToastAdapter：toast 适配器接口（types.ts）与 Windows 系统 toast 实现（NodeNotifierWindowsToastAdapter）
 * - WindowsAgentStopNotificationService：Agent 停止通知服务（去重、模板渲染、窗口焦点判断）
 * - templateRenderer / windowTitle：模板渲染与窗口标题推导工具
 */

// 类型定义
export type {
    AgentStopNotificationReason,
    PendingAgentActionType,
    WindowsAgentStopNotificationContentOverride,
    AgentStopNotificationPayload,
    WindowsNotificationPreviewPayload,
    WindowsToastRequest,
    WindowsToastShowResult,
    WindowsToastAdapter,
    AgentStopNotificationDispatchResult
} from './types';

// Toast 适配器（Windows 系统 toast 实现）
export { NodeNotifierWindowsToastAdapter } from './WindowsToastAdapter';

// Agent 停止通知服务
export { WindowsAgentStopNotificationService } from './WindowsAgentStopNotificationService';
export type { WindowsAgentStopNotificationServiceOptions } from './WindowsAgentStopNotificationService';

// 模板渲染
export { renderWindowsAgentStopTemplate } from './templateRenderer';
export type { WindowsAgentStopNotificationTemplateContext } from './templateRenderer';

// 窗口标题推导
export { deriveWindowsAgentStopWindowTitle } from './windowTitle';
export type { DeriveWindowsAgentStopWindowTitleOptions } from './windowTitle';

