import { onScopeDispose } from 'vue';

export interface NavigationIntent { generation: number; workspaceId?: string; tabId?: string; current(): boolean }
let generation = 0;
/** 所有外壳入口共享意图编号；已开始的写操作仍完成，只取消过期的视图提交。 */
export function useNavigationIntent() {
  let disposed = false;
  onScopeDispose(() => { disposed = true; });
  return (target: { workspaceId?: string; tabId?: string } = {}): NavigationIntent => {
    const current = ++generation;
    return { ...target, generation: current, current: () => !disposed && current === generation };
  };
}
