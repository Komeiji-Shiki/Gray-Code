import { shellText as t } from './i18n';
import type { RunEvent, RunRecord } from '@graycode/contracts';
export { requestGroups } from '../../../shared/promptPreview';

export const eventLabels: Record<string, string> = {
  get ['run.created']() {
    return t('uirunInspectorTaskQueued');
  },
  get ['run.started']() {
    return t('uirunInspectorTaskStarted');
  },
  get ['run.completed']() {
    return t('uirunInspectorTaskCompleted');
  },
  get ['run.failed']() {
    return t('petAnimationFailed');
  },
  get ['run.cancelled']() {
    return t('uirunInspectorTaskCanceled');
  },
  get ['run.interrupted']() {
    return t('uirunInspectorTaskInterrupted');
  },
  get ['model.preparing']() {
    return t('uirunInspectorPreparingContext');
  },
  get ['model.started']() {
    return t('uirunInspectorWaitingForModelResponse');
  },
  get ['model.request']() {
    return t('uirunInspectorRequestBodyRecorded');
  },
  get ['model.streaming']() {
    return t('uirunInspectorGeneratingReply');
  },
  get ['message.saved']() {
    return t('uirunInspectorReplySaved');
  },
  get ['tool.started']() {
    return t('uirunInspectorToolExecutionStarted');
  },
  get ['tool.completed']() {
    return t('uirunInspectorToolExecutionEnded');
  },
  get ['approval.requested']() {
    return t('uirunInspectorAwaitingActionConfirmation');
  },
  get ['approval.resolved']() {
    return t('uirunInspectorActionConfirmationHandled');
  },
  get ['question.asked']() {
    return t('uirunInspectorQuestionAsked');
  },
  get ['question.answered']() {
    return t('uirunInspectorAnswerReceived');
  },
  get ['question.expired']() {
    return t('uirunInspectorAnswerWaitEnded');
  },
  get ['run.waiting_input']() {
    return t('awaitingInput');
  },
  get ['context.summary.started']() {
    return t('uirunInspectorSummarizingContext');
  },
  get ['context.summary.completed']() {
    return t('uirunInspectorContextSummaryCompleted');
  },
  get ['context.summary.failed']() {
    return t('uirunInspectorContextSummarizationFailed');
  },
  get ['context.fallback']() {
    return t('uirunInspectorContextAdjusted');
  },
};
const statusLabels: Record<RunRecord['status'], string> = {
  get queued() {
    return t('uiNodeTasksWaitingToRun');
  },
  get running() {
    return t('uiNodeTasksRunning');
  },
  get awaiting_approval() {
    return t('uirunInspectorAwaitingActionConfirmation');
  },
  get awaiting_input() {
    return t('awaitingInput');
  },
  get completed() {
    return t('uiComputerPaneCompleted');
  },
  get failed() {
    return t('uiComputerPaneFailure');
  },
  get cancelled() {
    return t('reviewCancelledStatus');
  },
  get interrupted() {
    return t('uiMemoryLibraryInterrupted');
  },
};
export function runActivity(run: RunRecord | undefined, events: RunEvent[]) {
  if (!run) return t('uirunInspectorReadyToChat');
  if (run.status !== 'running') return statusLabels[run.status];
  for (let index = events.length - 1; index >= 0; index--)
    if (events[index].type !== 'model.request') return eventLabels[events[index].type] ?? statusLabels[run.status];
  return statusLabels[run.status];
}
/** 实时事件通常按序追加，只有历史补读或重复推送才需要重新合并完整列表。 */
export function mergeRunEvents(current: RunEvent[], incoming: RunEvent[]): RunEvent[] {
  if (!incoming.length) return current;
  if (
    (!current.length || incoming[0].sequence > current[current.length - 1].sequence) &&
    incoming.every((event, index) => index === 0 || event.sequence > incoming[index - 1].sequence)
  ) {
    current.push(...incoming);
    return current;
  }
  return [...new Map([...current, ...incoming].map((event) => [event.sequence, event])).values()].sort((a, b) => a.sequence - b.sequence);
}
export type EventLane = 'task' | 'model' | 'tool' | 'interaction' | 'context';
export function eventLane(type: string): EventLane {
  if (type.startsWith('tool.')) return 'tool';
  if (/^(approval|question)\./.test(type) || type === 'run.waiting_input') return 'interaction';
  if (type.startsWith('context.')) return 'context';
  if (type.startsWith('model.') || type === 'message.saved') return 'model';
  return 'task';
}
export function eventLaneLabel(lane: EventLane | 'all'): string {
  const labels = {
    all: t('uiProblemsPanelAll'),
    task: t('uiRunInspectorTask'),
    model: t('uiRunInspectorModel'),
    tool: t('uiNodeTasksTool'),
    interaction: t('uiRunInspectorInteraction'),
    context: t('uiRunInspectorContext'),
  };
  return labels[lane];
}
export type { ModelRequestSnapshot as RequestSnapshot } from '@graycode/contracts';
