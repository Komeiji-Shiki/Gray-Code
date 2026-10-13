import type { UiRequestHandlers } from '@graycode/contracts';
import type { PlatformApplication } from '../application';
import type { ClientSession } from '../transport/router';

type SubagentRequestHandlers = Pick<UiRequestHandlers, Extract<keyof UiRequestHandlers, `subagents.${string}`>>;

/** 子代理请求处理保留运行器的所属任务校验，UI 边界只检查原有审批开关。 */
export function subagentRequestHandlers(app: PlatformApplication, client: ClientSession): SubagentRequestHandlers {
  return {
    'subagents.monitor.requests': data => app.subagents.requests(client.actorId, data.runId),
    'subagents.pendingRequests': data => app.subagents.conversationRequests(client.actorId, data.conversationId),
    'subagents.resolveApproval': data => {
      if (typeof data.accepted !== 'boolean') throw new Error('请明确接受或拒绝操作。');
      return app.subagents.answer(client.actorId, data.runId, data.id, data.accepted, data.choiceId);
    },
    'subagents.answerQuestion': data => app.subagents.answer(client.actorId, data.runId, data.id, data.answers),
    'subagents.pauseRun': data => app.subagents.control(client.actorId, data.runId, 'pause'),
    'subagents.resumeRun': data => app.subagents.control(client.actorId, data.runId, 'resume'),
    'subagents.exitRun': data => app.subagents.control(client.actorId, data.runId, 'exit')
  };
}
