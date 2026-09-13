import { reactive } from 'vue';
import type { ComputerStatus } from '@graycode/contracts';
import { call, subscribe } from './api';

export const computerState = reactive({ status: null as ComputerStatus | null, openRequest: 0 });
let refresh: Promise<void> | undefined;
let refreshAgain = false;
export function refreshComputerStatus() {
  if (refresh) { refreshAgain = true; return refresh; }
  refresh = (async () => {
    do {
      refreshAgain = false;
      try { computerState.status = await call<ComputerStatus>('computer.status'); } catch { computerState.status = null; }
    } while (refreshAgain);
  })().finally(() => { refresh = undefined; });
  return refresh;
}
export function connectComputer() {
  void refreshComputerStatus();
  return subscribe(event => { if (['computer.changed', 'settings.changed'].includes(event.type)) void refreshComputerStatus(); });
}
export function openComputer() { computerState.openRequest++; }
