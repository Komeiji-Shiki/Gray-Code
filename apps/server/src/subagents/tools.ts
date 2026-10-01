import type { RuntimeTool } from '@graycode/core';
import { createSubagentsDeclaration } from '../../../../backend/tools/subagents/createDeclaration';
import { createAgentMessageDeclaration } from '../../../../backend/tools/subagents/createAgentMessageDeclaration';
import { AGENT_INBOX_MAX_MESSAGES, AGENT_MESSAGE_MAX_LENGTH } from '../../../../backend/core/services/agentMessages';
import { DEFAULT_SUBAGENTS_CONFIG, type SubAgentsConfig } from '../../../../backend/modules/settings/types/subAgentsTypes';
import type { PlatformApplication } from '../application';

export function subagentTools(app: PlatformApplication, config: SubAgentsConfig = DEFAULT_SUBAGENTS_CONFIG): RuntimeTool[] {
  const names = config.agents.filter(agent => agent.enabled).map(agent => agent.name);
  if (config.generalWorkerEnabled !== false) names.unshift('General Worker');
  // 与系统提示词的 User Language 同源：界面语言为 auto 或尚未加载设置时按系统区域判断。
  // 首次注册早于设置初始化，refreshMutationTools 会在设置加载和每次保存后按新语言重建。
  const language = app.product?.runtimeSettings()?.getUISettings().language;
  const isZh = (language && language !== 'auto' ? language : Intl.DateTimeFormat().resolvedOptions().locale).startsWith('zh');
  const declaration = createSubagentsDeclaration({ agentNames: names, isZh, generalWorkerMaxRuntimeSeconds: config.generalWorkerMaxRuntimeSeconds,
    agentNameDescription: isZh ? '要派发的子代理名称。' : 'Name of the sub-agent to dispatch.',
    description: isZh
      ? '把具体任务派发给子代理。General Worker 沿用当前模型和工具范围，已配置的代理按各自设置执行，两者都受当前账号权限约束。用 context 提供必要的背景信息。前台子代理会随当前任务一起取消。background=true 时工具立即返回，子代理的最终结果稍后会作为后台任务消息加入主对话，期间不要轮询；后台子代理不会随当前任务取消。'
      : 'Dispatch a concrete task to a sub-agent. General Worker uses the current model and tool scope; configured agents follow their own settings. Both stay within the current account permissions. Use context for necessary background. A foreground sub-agent is cancelled together with the current task. With background=true the tool returns immediately and the final result is later added to the main conversation as a background task message, so do not poll; background sub-agents are not cancelled with the current task.' });
  const messages = createAgentMessageDeclaration(isZh, isZh
    ? `向同一主任务中正在运行的子代理或主模型发送消息。用 targetRunId 指定子代理运行，或用 targetAgentName 指定名称（重名时发给最近启动的那个，main 表示主模型），二者只能选一个。发送成功即表示消息已保存。收件方会在当前这批工具执行完、下一次调用模型前或任务结束前读取。前台子代理给 main 发消息后，主模型不再等它返回，它会转到后台继续运行；主模型空闲时会自动处理收到的消息。每条消息最多 ${AGENT_MESSAGE_MAX_LENGTH} 字符，每个收件方最多积压 ${AGENT_INBOX_MAX_MESSAGES} 条。不要轮询，也不要重复发送。消息不会唤醒已失败、已停止或因重启中断的子代理。`
    : `Send a message to a running sub-agent or to the main model within the same main task. Address a sub-agent run with targetRunId, or a name with targetAgentName (the most recently started one wins on duplicate names; main means the main model); use only one of them. A successful send means the message has been saved. The recipient reads it after the current batch of tools finishes, before its next model call, or before it finishes. When a foreground sub-agent messages main, the main model stops waiting for it and it continues in the background; an idle main model handles incoming messages automatically. Each message is limited to ${AGENT_MESSAGE_MAX_LENGTH} characters, and each recipient holds at most ${AGENT_INBOX_MAX_MESSAGES} unread messages. Do not poll or resend. Messages do not wake sub-agents that failed, were stopped or were interrupted by a restart.`);
  return [{ declaration: { name: declaration.name, description: declaration.description, parameters: declaration.parameters }, effects: () => [],
    execute: (args, context) => app.subagents.dispatch(args, context) },
    { declaration: { name: messages.name, description: messages.description, parameters: messages.parameters }, effects: () => [],
      execute: (args, context) => app.subagents.messages.send(args, context) }];
}
