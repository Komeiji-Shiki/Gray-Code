/**
 * LimCode - 工具执行服务（壳）
 *
 * ToolExecutionService.ts 职责拆分（第二批）后的壳文件：保留类名、全部 public 方法
 * 签名与文件级导出（ToolExecutionService / ToolExecutionProgressEvent / ToolExecutionFullResult），
 * 现有 `import ... from './ToolExecutionService'` 全部不断（services/index.ts、
 * ChatFlowService / ToolIterationLoopService / streamingToolProgress / backend/tools/subagents/types.ts
 * 与各测试均不受影响）。
 *
 * 实现已按职责迁移到 tool-execution/ 子目录（子类继承链，方法体逐字移动，逻辑零改动）：
 * - tool-execution/execution.ts  ← ExecutionCore：执行编排核心（executeFunctionCalls 系列 + 主循环控制）
 * - tool-execution/result.ts    ← ResultCore：单工具执行 / 结果加工 / 多模态 / 活动统计
 * - tool-execution/preflight.ts ← PreflightCore：plan 模式写路径策略 / checkpoint 绑定 / 策略过滤
 * - tool-execution/mailbox.ts   ← MailboxCore：mailbox 收件箱排水（drain epoch / inbox 注入）
 *
 * 本文件仅保留：构造与 setter。
 */
import type { ToolRegistry } from '../../../../tools/ToolRegistry';
import type { ConversationStore } from '../../../../tools/types';
import type { McpManager } from '../../../mcp/McpManager';
import type { SettingsManager } from '../../../settings/SettingsManager';
import type { ConversationManager } from '../../../conversation/ConversationManager';
import type { CheckpointService } from './CheckpointService';
import { ExecutionCore } from './tool-execution/execution';

export type { ToolExecutionProgressEvent, ToolExecutionFullResult } from './tool-execution/execution';

/**
 * 工具执行服务
 *
 * 职责：
 * 1. 执行内置工具和 MCP 工具
 * 2. 处理工具确认逻辑
 * 3. 创建工具执行前后的检查点
 * 4. 处理多模态工具返回数据
 */
export class ToolExecutionService extends ExecutionCore {
    constructor(
        toolRegistry?: ToolRegistry,
        mcpManager?: McpManager,
        settingsManager?: SettingsManager,
        checkpointService?: CheckpointService,
        conversationManager?: ConversationManager
    ) {
        super();
        this.toolRegistry = toolRegistry;
        this.mcpManager = mcpManager;
        this.settingsManager = settingsManager;
        this.checkpointService = checkpointService;
        this.conversationManager = conversationManager;
    }

    /**
     * 设置设置管理器
     */
    setSettingsManager(settingsManager: SettingsManager): void {
        this.settingsManager = settingsManager;
    }

    /**
     * 设置 MCP 管理器
     */
    setMcpManager(mcpManager: McpManager): void {
        this.mcpManager = mcpManager;
    }

    /**
     * 设置工具注册表
     */
    setToolRegistry(toolRegistry: ToolRegistry): void {
        this.toolRegistry = toolRegistry;
    }

    /**
     * 注入对话存储（用于工具持久化对话元数据）
     */
    setConversationStore(store: ConversationStore): void {
        this.conversationStore = store;
    }
}
