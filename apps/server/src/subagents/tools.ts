import type { RuntimeTool } from '@graycode/core';
import { createSubagentsDeclaration } from '../../../../backend/tools/subagents/createDeclaration';
import { createAgentMessageDeclaration } from '../../../../backend/tools/subagents/createAgentMessageDeclaration';
import { DEFAULT_SUBAGENTS_CONFIG, type SubAgentsConfig } from '../../../../backend/modules/settings/types/subAgentsTypes';
import type { PlatformApplication } from '../application';

export function subagentTools(app: PlatformApplication, config: SubAgentsConfig = DEFAULT_SUBAGENTS_CONFIG): RuntimeTool[] {
  const names = config.agents.filter(agent => agent.enabled).map(agent => agent.name);
  if (config.generalWorkerEnabled !== false) names.unshift('General Worker');
  const declaration = createSubagentsDeclaration({ agentNames: names, isZh: true, agentNameDescription: '要派发的子代理名称。', generalWorkerMaxRuntimeSeconds: config.generalWorkerMaxRuntimeSeconds,
    description: '派发具体任务给子代理。General Worker 继承当前模型与工具范围；配置的代理按其设置执行，始终遵守当前账号权限。用 context 提供必要背景。background=true 时立即返回，最终结果会作为后台任务消息加入主对话；不要轮询。前台子任务随父任务取消，后台子任务需显式停止。可通过运行监视器查看记录、暂停、继续和停止。' });
  const messages = createAgentMessageDeclaration(true, '向同一主任务中的活动子代理或主模型发送消息。用 targetRunId 指定子任务，或用 targetAgentName 指定名称（同名时选择最近启动者，main 表示主模型）。回执表示已经保存，收件方会在当前批次工具结算后、下次模型调用前或正常完成前接收。前台子代理向 main 发信会解除对应的前台等待，继续在后台运行；主模型空闲时自动继续。回复时沿用 threadId，同一线程最多 5 跳。每条消息最多 16000 字符，每位收件方最多积压 50 条；不要轮询或重复发送。失败、停止或重启中断的子代理不会因消息而自动重试。');
  return [{ declaration: { name: declaration.name, description: declaration.description, parameters: declaration.parameters }, effects: () => [],
    execute: (args, context) => app.subagents.dispatch(args, context) },
    { declaration: { name: messages.name, description: messages.description, parameters: messages.parameters }, effects: () => [],
      execute: (args, context) => app.subagents.messages.send(args, context) }];
}
