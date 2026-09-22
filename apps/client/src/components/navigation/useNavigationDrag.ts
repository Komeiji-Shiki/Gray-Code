import { reactive } from 'vue';
import type { NavigationOrderKind } from '@graycode/contracts';
import { moveSidebarItem } from '../../../../../shared/sidebarOrder';

interface Target { kind: NavigationOrderKind; group: string; id: string }

/** 拖动只在相同列表内排序，目标上、下半部分分别表示插入前方和后方。 */
export function useNavigationDrag(save: (kind: NavigationOrderKind, ids: string[]) => Promise<void>, failed: (error: unknown) => void) {
  const state = reactive<{ source?: Target; over?: Target & { after: boolean }; saving: boolean }>({ saving: false });
  const compatible = (target: Target) => !!state.source && state.source.kind === target.kind && state.source.group === target.group;
  const same = (left: Target | undefined, right: Target) => left?.kind === right.kind && left.group === right.group && left.id === right.id;
  function clear() { state.source = undefined; state.over = undefined; }
  function start(event: DragEvent, target: Target) {
    if (state.saving || !event.dataTransfer) { event.preventDefault(); return; }
    state.source = target; state.over = undefined;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('application/x-graycode-navigation', target.id);
  }
  function over(event: DragEvent, target: Target) {
    if (!compatible(target) || same(state.source, target)) { state.over = undefined; return; }
    event.preventDefault(); event.stopPropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect();
    state.over = { ...target, after: event.clientY >= bounds.top + bounds.height / 2 };
  }
  async function drop(event: DragEvent, target: Target, ids: string[]) {
    if (!compatible(target) || !state.source || state.saving) return;
    event.preventDefault(); event.stopPropagation();
    const next = moveSidebarItem(ids, state.source.id, target.id, same(state.over, target) && !!state.over?.after);
    clear();
    if (next.every((id, index) => ids[index] === id)) return;
    state.saving = true;
    try { await save(target.kind, next); } catch (error) { failed(error); }
    finally { state.saving = false; }
  }
  function classes(target: Target) {
    return { 'navigation-dragging': same(state.source, target),
      'navigation-drop-before': same(state.over, target) && !state.over?.after,
      'navigation-drop-after': same(state.over, target) && !!state.over?.after };
  }
  const target = (kind: NavigationOrderKind, id: string, group: string = kind): Target => ({ kind, id, group });
  return { state, start, over, drop, clear, classes, target };
}
