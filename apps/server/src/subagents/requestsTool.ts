import type { ToolOutcome } from '@graycode/contracts';
import type { RuntimeTool, ToolContext } from '@graycode/core';
import type { PlatformApplication } from '../application';

const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';

/**
 * 主代理处理自己派发的子代理在等待的审批和问题。
 * 只能看到并处理调用方对话之下的后代子代理请求，不能处理自己或其他对话的请求。
 */
export function subagentRequestsTool(app: PlatformApplication, isZh: boolean): RuntimeTool {
  return {
    declaration: {
      name: 'subagent_requests',
      description: isZh
        ? '查看或处理本对话派发的子代理正在等待的操作审批和问题。子代理调用需要确认的工具（例如删除文件）时会暂停，直到有人处理。list 列出待处理的请求；approve 或 reject 按 requestId 允许或拒绝一项审批，请求带 choices 时用 choiceId 指定选项；answer 按 requestId 回答问题，answers 与问题一一对应。前台子代理运行期间主模型在等待它的结果，这时只能由用户在界面上处理；后台子代理的请求可以由主模型处理。只批准与当前任务一致、你确认安全的操作。'
        : 'List or handle operation approvals and questions that sub-agents dispatched from this conversation are waiting on. A sub-agent pauses when it calls a tool that needs confirmation (for example deleting files) until someone handles it. list returns pending requests; approve or reject allows or rejects one approval by requestId, using choiceId when the request has choices; answer replies to a question by requestId with one answer per question. While a foreground sub-agent runs, the main model is waiting for its result, so only the user can handle its requests in the interface; requests from background sub-agents can be handled by the main model. Only approve operations that match the current task and that you have confirmed are safe.',
      parameters: { type: 'object', additionalProperties: false, required: ['action'], properties: {
        action: { type: 'string', enum: ['list', 'approve', 'reject', 'answer'] },
        requestId: { type: 'string', description: isZh ? 'list 返回的审批或问题 ID。' : 'Approval or question ID returned by list.' },
        choiceId: { type: 'string', description: isZh ? '审批带 choices 时选择的选项 ID。' : 'Option ID when the approval has choices.' },
        answers: { type: 'array', items: { type: 'string' }, description: isZh ? '每个问题对应一条回答。' : 'One answer per question.' },
      } },
    },
    effects: () => [],
    execute: (args, context) => execute(app, args, context),
  };
}

async function execute(app: PlatformApplication, args: Record<string, unknown>, context: ToolContext): Promise<ToolOutcome> {
  if (!context.conversationId) throw new Error('子代理请求需要当前对话。');
  const requests = await app.subagents.conversationRequests(context.actorId, context.conversationId);
  const action = text(args.action);
  if (action === 'list') {
    return { success: true, data: {
      approvals: requests.approvals.map(item => ({ requestId: item.id, agentName: item.agentName, subagentRunId: item.subagentRunId,
        toolName: item.toolName, args: item.args, effects: item.effects, ...(item.reason ? { reason: item.reason } : {}),
        ...(item.choices?.length ? { choices: item.choices.map(choice => ({ id: choice.id, label: choice.label, kind: choice.kind })) } : {}) })),
      questions: requests.questions.map(item => ({ requestId: item.id, agentName: item.agentName, subagentRunId: item.subagentRunId,
        questions: item.questions, expiresAt: item.expiresAt })),
    } };
  }
  const requestId = text(args.requestId);
  if (!requestId) return { success: false, code: 'INVALID_ARGUMENTS', error: '请提供 requestId。' };
  if (action === 'approve' || action === 'reject') {
    const approval = requests.approvals.find(item => item.id === requestId);
    if (!approval) return { success: false, code: 'NOT_FOUND', error: '这个审批不属于本对话的子代理，或已经处理。' };
    let choiceId = text(args.choiceId) || undefined;
    if (approval.choices?.length) {
      // 带选项的审批按动作取默认的单次选项，避免主代理顺手授予“始终允许”。
      choiceId ??= approval.choices.find(choice => choice.kind === (action === 'approve' ? 'allow_once' : 'reject_once'))?.id;
      const choice = approval.choices.find(item => item.id === choiceId);
      if (!choice) return { success: false, code: 'INVALID_ARGUMENTS', error: '请用 choiceId 选择这个审批提供的选项。' };
      if (choice.kind.startsWith('allow') !== (action === 'approve')) return { success: false, code: 'INVALID_ARGUMENTS', error: '所选选项与 approve/reject 不一致。' };
    } else choiceId = undefined;
    await app.runtime.resolveApproval(requestId, context.actorId, action === 'approve', choiceId);
    return { success: true, data: { requestId, agentName: approval.agentName, toolName: approval.toolName, accepted: action === 'approve' } };
  }
  if (action === 'answer') {
    const question = requests.questions.find(item => item.id === requestId);
    if (!question) return { success: false, code: 'NOT_FOUND', error: '这个问题不属于本对话的子代理，或已经结束。' };
    const answers = Array.isArray(args.answers) ? args.answers.map(text) : [];
    await app.runtime.answerQuestion(requestId, context.actorId, answers);
    return { success: true, data: { requestId, agentName: question.agentName } };
  }
  return { success: false, code: 'INVALID_ARGUMENTS', error: '未知的 action。' };
}
