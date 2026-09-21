import { nextTick, onBeforeUnmount, reactive } from 'vue';
import { sendToExtension } from '../utils/vscode';

export const desktopSettingsDraft = reactive({ editing: false, dirty: false, busy: false, error: '', generation: 0 });
const participants = new Set<{ flush: () => Promise<unknown>; ready: () => boolean; cancel?: () => void; dirty: boolean }>();
const pending = new Set<Promise<unknown>>();
const writeErrors = new Map<string, string>();
const failedWrites = new Map<string, () => Promise<unknown>>();
let discarding = false;
let localChangeVersion = 0;

function mutationKey(type: string, data: any): string | null {
  if (!/^(update|set|save|renamePrompt|deletePrompt|createMcp|deleteMcp|mcp\.replaceJson|config\.(create|update|delete)|models\.(add|remove|set)|tools\.(set|update)|conversation\.updateBranchRetentionConfig|settings\.set|checkpoint\.update|subagents\.(create|update|delete)|platform\.(settings|reviewers|modes|development)\.update|platform\.modes\.createCharacterPreset)/.test(type)) return null;
  return JSON.stringify([type, data?.id, data?.configId, data?.toolName, data?.modeId, data?.mode, data?.updates ? Object.keys(data.updates).sort() : null]);
}
export function trackPreferenceRequest<T>(type: string, data: unknown, request: Promise<T>, retry?: () => Promise<T>): Promise<T> {
  if (type === 'ui.settings.begin') {
    const before = localChangeVersion; desktopSettingsDraft.editing = true;
    return request.then(result => {
      // 初始化回复不得覆盖请求期间已经输入的表单内容。
      if (before === localChangeVersion && !pending.size && !writeErrors.size && ![...participants].some(participant => participant.dirty))
        desktopSettingsDraft.dirty = (result as { dirty?: boolean } | undefined)?.dirty === true;
      return result;
    });
  }
  if (type === 'ui.settings.end') return request.then(result => {
    desktopSettingsDraft.editing = false; desktopSettingsDraft.dirty = false; return result;
  });
  const key = mutationKey(type, data);
  if (!key || !desktopSettingsDraft.editing) return request;
  localChangeVersion++;
  if (!discarding) desktopSettingsDraft.dirty = true;
  pending.add(request);
  void request.then(() => { writeErrors.delete(key); failedWrites.delete(key); }, error => {
    writeErrors.set(key, error.message); if (retry) failedWrites.set(key, retry);
    desktopSettingsDraft.error = error.message;
  }).finally(() => pending.delete(request));
  return request;
}
/** Legacy sections keep their own validated form code; this joins it to one desktop draft. */
export function useDesktopSettingsDraft(flush: () => Promise<unknown>, ready: () => boolean = () => true, cancel?: () => void): void {
  if (!window.__GRAYCODE_HOST) return;
  const participant = { flush, ready, cancel, dirty: false };
  participants.add(participant);
  onBeforeUnmount(() => {
    participants.delete(participant);
    if (!discarding && participant.dirty && participant.ready()) {
      const operation = participant.flush();
      pending.add(operation);
      void operation.catch(error => { desktopSettingsDraft.error = error.message; }).finally(() => pending.delete(operation));
    }
  });
}
export function markDesktopSettingsDirty(event?: Event): void {
  if (!window.__GRAYCODE_HOST || !desktopSettingsDraft.editing || discarding) return;
  if (event?.target instanceof Element && event.target.closest('[data-preference-transient]')) return;
  if (![...participants].some(participant => participant.ready())) return;
  localChangeVersion++;
  desktopSettingsDraft.dirty = true;
  for (const participant of participants) if (participant.ready()) participant.dirty = true;
  void sendToExtension('desktop.dirtySettings', { dirty: true });
}
export async function flushDesktopSettings(): Promise<void> {
  for (const participant of participants) if (participant.dirty && participant.ready()) {
    await participant.flush(); participant.dirty = false;
  }
  while (pending.size) await Promise.allSettled([...pending]);
  if (writeErrors.size) throw new Error([...writeErrors.values()][0]);
}
export async function saveDesktopSettings(): Promise<void> {
  if (desktopSettingsDraft.busy) return;
  desktopSettingsDraft.busy = true; desktopSettingsDraft.error = '';
  try {
    // 曾失败的草稿请求可以重新提交；随后刷新表单，让最新输入覆盖旧请求内容。
    for (const [key, retry] of [...failedWrites]) {
      await retry(); failedWrites.delete(key); writeErrors.delete(key);
    }
    await flushDesktopSettings();
    const saved = await sendToExtension<{ activationWarnings?: string[] }>('ui.settings.save', {});
    desktopSettingsDraft.dirty = false;
    if (saved?.activationWarnings?.length) desktopSettingsDraft.error = `设置已保存，仍有事项需要处理：${saved.activationWarnings.join('；')}`;
    await sendToExtension('desktop.dirtySettings', { dirty: false });
  } catch (error) { desktopSettingsDraft.error = (error as Error).message; throw error; }
  finally { desktopSettingsDraft.busy = false; }
}
export async function discardDesktopSettings(): Promise<void> {
  desktopSettingsDraft.busy = true; discarding = true;
  try {
    for (const participant of participants) participant.cancel?.();
    while (pending.size) await Promise.allSettled([...pending]);
    await sendToExtension('ui.settings.discard', {});
    writeErrors.clear(); failedWrites.clear(); desktopSettingsDraft.error = ''; desktopSettingsDraft.dirty = false;
    desktopSettingsDraft.generation++;
    await nextTick();
    await sendToExtension('desktop.dirtySettings', { dirty: false });
  } finally { discarding = false; desktopSettingsDraft.busy = false; }
}
