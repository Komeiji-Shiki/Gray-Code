/**
 * 子代理 systemPrompt 的内置正文与追加说明。
 *
 * 旧宿主执行器（runLoop）与平台子代理（apps/server/src/subagents/profile.ts）共用这些文本，
 * 两条路径的子代理收到相同的约束。
 */

/** 零配置 General Worker 的系统提示词。 */
export const GENERAL_WORKER_SYSTEM_PROMPT = 'You are a general-purpose worker sub-agent. Complete the task described in the prompt with the tools available to you, working on your own without further guidance. Your final response is the deliverable, so make it complete and self-contained.';

/**
 * 仅在本次运行的工具集实际包含 subagents 时追加。
 * 大多数任务不需要嵌套派发；只在需要独立复查或主模型明确要求时才使用。
 */
export const SUBAGENT_NESTING_PROMPT_NOTICE = '\n\nYou can use the subagents tool to delegate work to further sub-agents, but most tasks do not need it. Use it only when your code or output needs an independent review by another agent, or when the main model explicitly asks for it. Their final results are included in your output and returned to the main model.';

/** 结束方式：最终一轮只交付纯文本报告，让运行器能把任务标记为完成。 */
export const SUBAGENT_COMPLETION_NOTICE = '\n\nWhen you finish: complete the requested work, verification and cleanup, then end with one plain-text report and no tool calls in that final turn. Use agent_send_message only for interim coordination, never as a substitute for the final report. Once the work is done, stop calling tools, polling or waiting, and return the report so the task can be marked complete.';

/** 模型可能在工具结果返回前凭猜测断言内容；代码层已忽略工具调用之后的尾巴文本，这里从源头约束。 */
export const SUBAGENT_TOOL_DISCIPLINE_NOTICE = '\n\nDo not state facts about files, output or other content before the tool results that show them have returned. Plan, call the tools, then describe what the results actually show.';
