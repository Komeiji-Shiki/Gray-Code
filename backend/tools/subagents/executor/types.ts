/**
 * 子代理执行器内部类型定义。
 *
 * 拆分说明：从 executor.ts 迁出（纯移动，逻辑一字未改）。
 */

import type { ContentPart } from '../../../modules/conversation/types';
import type { ToolExecutionResult, FunctionCallInfo } from '../../../modules/api/chat/utils';

/**
 * 子代理内部工具执行结果。
 *
 * 修改原因：SubAgent 历史需要写入主 ToolExecutionService 生成的 functionResponse parts，不能只保存简化的 success/result/error。
 * 修改方式：在原有 result/success/error 外，携带 responseParts、toolResults 和 prompt 模式多模态附件。
 * 修改目的：让 read_file 图片、MCP 多模态和后续工具结果格式升级能被 SubAgent 自动继承。
 */
export interface SubAgentExecutedToolCall {
    result: unknown;
    success: boolean;
    error?: string;
    responseParts?: ContentPart[];
    toolResults?: ToolExecutionResult[];
    multimodalAttachments?: ContentPart[];
}

/** 并行工具执行结果：earlyExit 表示该 call 在预检阶段因超时/取消早退（不执行工具、不产生结果） */
export type ToolExecutionOutcome =
    | { earlyExit: true; timeoutCheck: { exceeded: boolean; elapsed: number } }
    | { earlyExit: false; call: FunctionCallInfo; result: SubAgentExecutedToolCall; duration: number };
