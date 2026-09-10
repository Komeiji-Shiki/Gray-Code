import type { ToolDeclaration } from '../types';
/** 工具声明由旧宿主与独立平台共用。 */
export function createSubagentsDeclaration(options: { agentNames: string[]; isZh: boolean; description: string; agentNameDescription: string }): ToolDeclaration {
  const { agentNames, isZh } = options;
    return {
        name: 'subagents',
        category: 'agents',
        description: options.description,
        parameters: {
            type: 'object',
            properties: {
                agentName: {
                    type: 'string',
                    description: options.agentNameDescription,
                    ...(agentNames.length > 0 ? { enum: agentNames } : {})
                },
                prompt: {
                    type: 'string',
                    description: isZh
                        ? '给子代理的任务提示词/指令。要具体、详细地说明你希望子代理完成什么。'
                        : 'The task prompt/instruction for the sub-agent. Be specific and detailed about what you want the sub-agent to accomplish.'
                },
                context: {
                    type: 'string',
                    description: isZh
                        ? '给子代理的可选附加上下文或背景信息。包含相关文件路径、代码片段或需求。'
                        : 'Optional additional context or background information for the sub-agent. Include relevant file paths, code snippets, or requirements.'
                },
                continueFromRunId: {
                    type: 'string',
                    description: isZh
                        ? '可选的已完成子代理运行 ID，用于继续该运行。新运行继承该运行的完整记录。正在运行或未知的运行 ID 会被拒绝。'
                        : 'Optional completed Sub-Agent run ID to continue from. The new run inherits that run\'s complete transcript. Running or unknown run IDs are rejected.'
                },
                background: {
                    type: 'boolean',
                    description: isZh
                        ? '设为 true 以在后台启动子代理（非阻塞）。仅用于长时间运行的任务（例如批量审查/研究）。工具立即返回 taskId；最终结果稍后以 "[Background task completed]" 用户消息到达——不要等待或轮询它。后台任务不会因当前流停止而取消；请通过后台任务栏显式取消。'
                        : 'Set to true to start the sub-agent in the background (non-blocking). Use ONLY for long-running tasks (e.g. batch review/research). The tool returns immediately with a taskId; the final result will arrive later as a "[Background task completed]" user message — do NOT wait for it or poll. Background tasks are NOT cancelled when the current stream stops; cancel them explicitly via the background task bar.'
                }
            },
            required: ['agentName', 'prompt']
        }
    };
}
