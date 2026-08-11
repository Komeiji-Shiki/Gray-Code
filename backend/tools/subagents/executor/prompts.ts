/**
 * 子代理 systemPrompt 追加说明（嵌套提示 / 工具纪律）。
 *
 * 拆分说明：从 executor.ts 迁出（纯移动，逻辑一字未改）。
 */

/**
 * F2：追加到子 agent system prompt 的中文说明。
 *
 * 修改原因：子 agent 现在可以使用 subagents 工具派生子子 agent，但大多数任务不需要；
 * 直接写进 executor 组装 prompt 的位置，所有子 agent（含 General Worker 与自定义提示词）统一生效。
 * 修改目的：引导模型只在真正需要独立复查或主模型明确指示时才嵌套派发，避免滥用。
 * 仅在本次 run 的工具集实际包含 subagents 时追加，白名单不含 subagents 的 agent 不收到该说明。
 */
export const SUBAGENT_NESTING_PROMPT_NOTICE = [
    '',
    '你可以使用 subagents 工具派生子 agent 协助工作，但一般不需要——仅当你的代码或输出需要另一个 agent 独立复查，或主模型明确下达指令时才使用。子 agent 的最终结果会汇总到你的输出，并最终返回给主模型。'
].join('\n');

/**
 * 工具调用纪律（一句话提示，无条件追加到所有子代理 systemPrompt）。
 *
 * 修改原因：模型可能在工具结果返回前输出基于猜测的内容断言（幻觉预生成），
 * 代码层已忽略"工具调用之后的尾巴文本"兜底；提示词从源头约束降低触发概率。
 * 修改目的：一句话轻量引导，不越俎代庖——详细的工具纪律交给用户自定义 systemPrompt。
 */
export const SUBAGENT_TOOL_DISCIPLINE_NOTICE = [
    '',
    'Before tool results return, do not state content facts you have not verified — plan first, call tools, then describe what the results actually show.'
].join('\n');
