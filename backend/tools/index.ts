/**
 * GrayCode - 工具系统主导出
 *
 * VSCode 扩展工具管理
 */

import type { ToolRegistration } from './types';
import { getReadSkillToolRegistration } from './skills';
import { getActivityToolRegistrations } from './activity';
import { getDesignToolRegistrations } from './design';
import { getFileToolRegistrations } from './file';
import { getHistoryToolRegistrations } from './history';
import { getLspToolRegistrations } from './lsp';
import { getMediaToolRegistrations } from './media';
import { getMemoryToolRegistrations } from './memory';
import { getNotificationToolRegistrations } from './notification';
import { getPlanToolRegistrations } from './plan';
import { getProgressToolRegistrations } from './progress';
import { getReviewToolRegistrations } from './review';
import { getSearchToolRegistrations } from './search';
import { getSubAgentsToolRegistrations } from './subagents';
import { getTerminalToolRegistrations } from './terminal';
import { getTodoToolRegistrations } from './todo';

// 导出设置上下文（从 core 模块重新导出）
export { setGlobalSettingsManager, getGlobalSettingsManager } from '../core/settingsContext';

// 导出类型
export type {
    Tool,
    ToolDeclaration,
    ToolArgs,
    ToolResult,
    ToolHandler,
    ToolRegistration,
    MultimodalData
} from './types';

// 导出注册器
export { ToolRegistry, toolRegistry, type DependencyChecker } from './ToolRegistry';

// 导出工具模块
export * from './file';
export * from './search';
export * from './terminal';
export * from './media';
export * from './lsp';
export * from './subagents';
export * from './todo';
export * from './design';
export * from './plan';
export * from './progress';
export * from './review';
export * from './history';
export * from './notification';
export * from './memory';
export * from './activity';
export * from './sandbox';

// 导出工具辅助函数
export * from './utils';

// 补充导出（这些符号未随对应目录 index 导出）
export { getPlanSourceStatusFromContent } from './plan/sourceArtifactSection';
export type { PlanSourceStatusResult } from './plan/sourceArtifactSection';
// 注：SubAgentRunConversationStore 已随 export * from './subagents' 导出，此处不再重复导出
export { resolveMainChatDiffViewColumn } from './file/diffViewColumn';

// 导出格式化器
export * from './xmlFormatter';
export * from './jsonFormatter';

// 导出任务管理器
export {
    TaskManager,
    type TaskType,
    type TaskStatus,
    type TaskInfo,
    type TaskEventType,
    type TaskEvent,
    type CancelResult
} from './taskManager';

/**
 * 收集所有内置工具的注册函数（真实工厂函数，不含 read_skill 与 subagents 工具）。
 */
function collectAllToolRegistrations(): ToolRegistration[] {
    const { getFileToolRegistrations } = require('./file');
    const { getSearchToolRegistrations } = require('./search');
    const { getTerminalToolRegistrations } = require('./terminal');
    const { getMediaToolRegistrations } = require('./media');
    const { getLspToolRegistrations } = require('./lsp');
    const { getTodoToolRegistrations } = require('./todo');
    const { getDesignToolRegistrations } = require('./design');
    const { getPlanToolRegistrations } = require('./plan');
    const { getProgressToolRegistrations } = require('./progress');
    const { getReviewToolRegistrations } = require('./review');
    const { getHistoryToolRegistrations } = require('./history');
    const { getNotificationToolRegistrations } = require('./notification');
    const { getMemoryToolRegistrations } = require('./memory');
    const { getActivityToolRegistrations } = require('./activity');
    const { getSandboxToolRegistrations } = require('./sandbox');


    return [
        ...getFileToolRegistrations(),
        ...getSearchToolRegistrations(),
        ...getTerminalToolRegistrations(),
        ...getMediaToolRegistrations(),
        ...getLspToolRegistrations(),
        ...getTodoToolRegistrations(),
        ...getDesignToolRegistrations(),
        ...getPlanToolRegistrations(),
        ...getProgressToolRegistrations(),
        ...getReviewToolRegistrations(),
        ...getHistoryToolRegistrations(),
        ...getNotificationToolRegistrations(),
        ...getMemoryToolRegistrations(),
        ...getActivityToolRegistrations(),
        ...getSandboxToolRegistrations()
    ];
}

/**
 * 收集 subagents 工具的注册函数（经静态 import 访问，与 collectAllToolRegistrations 一致）。
 */
function getSubAgentsRegistrations(): ToolRegistration[] {
    return getSubAgentsToolRegistrations();
}

/**
 * 注册所有工具到注册器
 *
 * @param registry 工具注册器实例
 */
export function registerAllTools(
    registry: typeof import('./ToolRegistry').toolRegistry
): void {
    // 修改原因：旧实现先 getAllTools() 预构建 Tool 实例，再以 () => tool 闭包注册，
    // registry.refreshTool() 重新调用"工厂"拿到的仍是同一实例——除 read_skill 外
    // 所有工具的"刷新声明"都是静默空操作。
    // 修改方式：直接收集各 getXxxToolRegistrations() 返回的真实工厂函数并逐个注册，
    // refreshTool() 会重新调用工厂生成新实例。
    const registrations = [
        ...collectAllToolRegistrations(),
        ...getSubAgentsRegistrations()
    ];

    // 注册所有工具。collectAllToolRegistrations 按约定不包含 read_skill
    // （read_skill 在下方以真实工厂单独注册）；这里不再预执行工厂做探测，
    // 避免「只为跳过 read_skill 而提前构建全部工具实例」的重复执行。
    for (const registration of registrations) {
        registry.register(registration);
    }

    // 用真正的工厂函数注册 read_skill，使 refreshTool('read_skill') 能重新生成声明
    registry.register(getReadSkillToolRegistration());
}