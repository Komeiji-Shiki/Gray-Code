import type { ToolDeclaration } from '../types';
/** 工具声明由旧宿主与独立平台共用。 */
export function createSubagentsDeclaration(options: { agentNames: string[]; isZh: boolean; description: string; agentNameDescription: string; generalWorkerMaxRuntimeSeconds?: number }): ToolDeclaration {
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
                        ? '交给子代理的任务指令，具体说明需要完成什么。'
                        : 'The task instructions for the sub-agent. State specifically what it should accomplish.'
                },
                context: {
                    type: 'string',
                    description: isZh
                        ? '可选的背景信息，例如相关文件路径、代码片段或需求。'
                        : 'Optional background, such as relevant file paths, code snippets or requirements.'
                },
                continueFromRunId: {
                    type: 'string',
                    description: isZh
                        ? '可选，要继续的已完成子代理运行 ID。新运行会继承该运行的完整记录；仍在运行或不存在的 ID 会被拒绝。'
                        : 'Optional ID of a completed sub-agent run to continue. The new run inherits its full transcript; running or unknown IDs are rejected.'
                },
                maxRuntime: {
                    type: 'integer', minimum: -1,
                    description: isZh
                        ? `可选，仅本次 General Worker 的最长运行时间，单位秒。填正整数或 -1（不限时），不能为 0；省略时使用用户默认值 ${options.generalWorkerMaxRuntimeSeconds ?? 2400} 秒。`
                        : `Optional maximum runtime for this General Worker call, in seconds: a positive integer or -1 for no limit, never 0. Defaults to the user setting (${options.generalWorkerMaxRuntimeSeconds ?? 2400}s).`
                },
                background: {
                    type: 'boolean',
                    description: isZh
                        ? '设为 true 时在后台启动子代理，工具立即返回 taskId。只用于长时间任务，例如批量审查或调研。'
                        : 'Set to true to start the sub-agent in the background; the tool returns a taskId immediately. Use only for long-running work such as batch reviews or research.'
                }
            },
            required: ['agentName', 'prompt']
        }
    };
}

