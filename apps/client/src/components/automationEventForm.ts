import type { AutomationEventConfiguration } from '@graycode/contracts';

export interface AutomationEventForm {
  type: '' | AutomationEventConfiguration['trigger']['type'];
  conversationId: string; workspaceId: string; path: string; peerId: string; debounceMs: string;
  busyPolicy: '' | AutomationEventConfiguration['busyPolicy'];
  restartPolicy: '' | AutomationEventConfiguration['restartPolicy'];
}
export function eventForm(event?: AutomationEventConfiguration): AutomationEventForm {
  const trigger = event?.trigger;
  return { type: trigger?.type ?? '', conversationId: trigger?.type === 'run_completed' ? trigger.conversationId : '',
    workspaceId: trigger?.type === 'file_changed' ? trigger.workspaceId : '', path: trigger?.type === 'file_changed' ? trigger.path : '',
    debounceMs: trigger?.type === 'file_changed' ? String(trigger.debounceMs) : '', peerId: trigger?.type === 'node_online' ? trigger.peerId : '',
    busyPolicy: event?.busyPolicy ?? '', restartPolicy: event?.restartPolicy ?? '' };
}
export function eventConfiguration(form: AutomationEventForm): AutomationEventConfiguration {
  if (!form.type || !form.busyPolicy || !form.restartPolicy) throw new Error('请完整选择事件来源、忙碌处理方式和重启方式。');
  return { busyPolicy: form.busyPolicy, restartPolicy: form.restartPolicy, trigger: form.type === 'file_changed'
    ? { type: form.type, workspaceId: form.workspaceId, path: form.path, debounceMs: Number(form.debounceMs) }
    : form.type === 'node_online' ? { type: form.type, peerId: form.peerId } : { type: form.type, conversationId: form.conversationId } };
}
