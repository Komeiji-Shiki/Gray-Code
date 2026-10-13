import { ref } from 'vue';
import type { ConversationNavigationItem } from '@graycode/contracts';
import { call, uiRequest } from './api';
import { useNavigationIntent, type NavigationIntent } from './navigationIntent';
import { state } from './state';

export const collapsedConversationGroups = ref(new Set<string>());

interface WorkspaceNavigationGroup {
  key: string;
  uri: string;
  items: ConversationNavigationItem[];
}

export function useConversationNavigation(onNavigate: (panel?: 'workbench') => void) {
  const navigate = useNavigationIntent();

  async function command(command: string, data?: Record<string, unknown>, intent?: NavigationIntent) {
    const navigationCommand = [
      'newChat',
      'platform.openModeConversation',
      'platform.switchConversationView',
      'showHistory',
      'showUsage',
      'showSettings',
    ].includes(command);
    if (navigationCommand) intent ??= navigate({ tabId: String(data?.conversationId ?? data?.tabId ?? command) });
    let result: unknown;
    try {
      result = await call('ui.command', { command, data });
    } catch (error) {
      if (intent && !intent.current()) return;
      throw error;
    }
    if (navigationCommand && intent?.current()) onNavigate();
    return result;
  }

  async function newConversation(workspaceId?: string, intent = navigate({ workspaceId })) {
    if (workspaceId) {
      const result = await uiRequest('ui.mode.new', { mode: 'code', workspaceId });
      if (intent.current()) await command('platform.openModeConversation', { conversationId: result.conversationId }, intent);
    } else await command('newChat', undefined, intent);
  }

  async function selectWorkspace(workspaceId: string, group?: WorkspaceNavigationGroup, pinned: ConversationNavigationItem[] = []) {
    const intent = navigate({ workspaceId });
    // 空分组可能还有分页外的旧对话，先按项目补查，再决定是否创建；工作区只由实际聚焦的对话更新。
    const groupItems = group?.items.length ? group.items : undefined;
    const source = groupItems ? { items: groupItems, pinned }
      : await uiRequest('conversation.navigation', { scope: 'personal', workspaceId: workspaceId || undefined });
    if (!intent.current()) return;
    const matchesWorkspace = (item: ConversationNavigationItem) => workspaceId
      ? item.workspaceId === workspaceId && !item.automaticWorkspace
      : !item.workspaceUri || item.automaticWorkspace;
    const candidates = [
      ...(groupItems ?? source.items.filter(matchesWorkspace)),
      ...source.pinned.filter((item) => (!group || !!workspaceId) && matchesWorkspace(item)),
    ].sort((left, right) => right.updatedAt - left.updatedAt);
    const selected = candidates.find((item) => item.id === state.conversationId) ?? candidates[0];
    if (selected) await command('platform.openModeConversation', { conversationId: selected.id }, intent);
    else await newConversation(workspaceId || undefined, intent);
    if (!intent.current()) return;
    const next = new Set(collapsedConversationGroups.value);
    next.delete(group?.key ?? workspaceId);
    collapsedConversationGroups.value = next;
    state.chatFocused = !workspaceId && !group?.uri;
    onNavigate(state.chatFocused ? undefined : 'workbench');
  }

  return { navigate, command, newConversation, selectWorkspace };
}
