import type { RunEvent, RunRecord } from '@graycode/contracts';

export const eventLabels: Record<string, string> = {
  'run.created': '任务已排队', 'run.started': '任务开始', 'run.completed': '任务完成',
  'run.failed': '任务失败', 'run.cancelled': '任务已取消', 'run.interrupted': '任务已中断',
  'model.preparing': '准备上下文', 'model.started': '等待模型响应', 'model.request': '请求正文已记录',
  'model.streaming': '正在生成回复', 'message.saved': '回复已保存',
  'tool.started': '工具开始执行', 'tool.completed': '工具执行结束',
  'approval.requested': '等待操作确认', 'approval.resolved': '操作确认已处理',
  'question.asked': '提出问题', 'question.answered': '收到回答', 'question.expired': '问题等待已结束',
  'run.waiting_input': '等待回答', 'context.summary.started': '正在总结上下文',
  'context.summary.completed': '上下文总结完成', 'context.summary.failed': '上下文总结失败', 'context.fallback': '已调整上下文',
};
const statusLabels: Record<RunRecord['status'], string> = {
  queued: '等待执行', running: '正在执行', awaiting_approval: '等待操作确认', awaiting_input: '等待回答',
  completed: '已完成', failed: '失败', cancelled: '已取消', interrupted: '已中断',
};
export function runActivity(run: RunRecord | undefined, events: RunEvent[]) {
  if (!run) return '可以开始对话';
  if (run.status !== 'running') return statusLabels[run.status];
  const last = [...events].reverse().find(event => event.type !== 'model.request');
  return last ? eventLabels[last.type] ?? statusLabels[run.status] : statusLabels[run.status];
}
export function eventLane(type: string) {
  if (type.startsWith('tool.')) return '工具';
  if (/^(approval|question)\./.test(type) || type === 'run.waiting_input') return '交互';
  if (type.startsWith('context.')) return '上下文';
  if (type.startsWith('model.') || type === 'message.saved') return '模型';
  return '任务';
}
export interface RequestSnapshot { turnContext?: { characterTurn?: { resources: unknown; activation: unknown; config: unknown } }; runId: string; iteration: number; capturedAt: number; protocol: string; model: string; body: unknown }
export function requestGroups(body: unknown): { title: string; value: unknown }[] {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return [{ title: '请求正文', value: body }];
  const groups: { title: string; value: unknown }[] = [];
  const options: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (['messages', 'contents', 'input'].includes(key) && Array.isArray(value)) {
      value.forEach((message, index) => groups.push({ title: `${key} · ${index + 1} · ${message?.role ?? message?.type ?? '内容'}`, value: message }));
    } else if (['system', 'systemInstruction', 'instructions', 'tools', 'toolConfig'].includes(key)) {
      groups.push({ title: key, value });
    } else options[key] = value;
  }
  if (Object.keys(options).length) groups.push({ title: '模型参数与其他字段', value: options });
  return groups;
}
