import { computed, ref, watch } from 'vue';
import { state } from './state';

/** 只选择后续操作的目录，已打开的文件和终端各自保留原来的位置。 */
export function useWorkspaceRoots() {
  const workspace = computed(() => state.snapshot?.settings.workspaces.find(item => item.id === state.workspaceId));
  const roots = computed(() => workspace.value?.roots ?? (workspace.value ? [{ name: workspace.value.name, directory: workspace.value.directory }] : []));
  const directory = ref('');
  watch([() => state.workspaceId, roots], ([id], previous) => {
    if (id !== previous[0] || !roots.value.some(root => root.directory === directory.value)) directory.value = roots.value[0]?.directory ?? '';
  }, { immediate: true });
  return { workspace, roots, directory };
}
