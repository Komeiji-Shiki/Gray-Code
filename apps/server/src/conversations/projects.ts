import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import type { RecordMutation } from '@graycode/contracts';
import type { PlatformApplication } from '../application';
import { conversationWorkspace, workspaceDirectoryKey } from '../workspace/identity';
import { deleteConversation } from './delete';

export interface ProjectNavigationTarget { workspaceId?: string; workspaceUri?: string }
export interface ProjectNavigationPreference { name?: string; removed?: boolean }
const projectNamespace = 'project-navigation';

export function projectNavigationKey(target: ProjectNavigationTarget): string {
  const identity = target.workspaceId ? `workspace:${target.workspaceId}` : `uri:${workspaceDirectoryKey(target.workspaceUri) ?? target.workspaceUri}`;
  return createHash('sha256').update(identity).digest('hex');
}

/** 项目列表的显示状态独立保存，不删除工作区绑定、历史或磁盘目录。 */
export class ProjectNavigation {
  constructor(private readonly app: PlatformApplication) {}
  async preferences(): Promise<Map<string, ProjectNavigationPreference>> {
    const values = new Map<string, ProjectNavigationPreference>();
    for (const id of await this.app.storage.listRecords(projectNamespace)) {
      const value = await this.app.storage.getRecord(projectNamespace, id) as ProjectNavigationPreference | null;
      if (value) values.set(id, value);
    }
    return values;
  }
  private target(actorId: string, target: ProjectNavigationTarget): ProjectNavigationTarget {
    this.app.requireOwner(actorId);
    if (target.workspaceId) {
      const workspace = this.app.settings.snapshot().settings.workspaces.find(item => item.id === target.workspaceId);
      if (!workspace || workspace.managedConversationId) throw new Error('这个项目不存在。');
      return { workspaceId: workspace.id, workspaceUri: pathToFileURL(workspace.directory).toString() };
    }
    if (typeof target.workspaceUri !== 'string' || !target.workspaceUri || target.workspaceUri.length > 8192) throw new Error('缺少项目路径。');
    if (!workspaceDirectoryKey(target.workspaceUri)) {
      try { new URL(target.workspaceUri); } catch { throw new Error('项目路径无效。'); }
    }
    return { workspaceUri: target.workspaceUri };
  }
  async update(actorId: string, target: ProjectNavigationTarget, change: { name: string } | { removed: boolean }) {
    const resolved = this.target(actorId, target);
    if ('name' in change && (typeof change.name !== 'string' || !change.name.trim() || change.name.trim().length > 300)) throw new Error('项目名称需要 1 至 300 个字符。');
    const id = projectNavigationKey(resolved);
    const current = await this.app.storage.getVersionedRecord(projectNamespace, id);
    const value = { ...(current.value as ProjectNavigationPreference | null), ...('name' in change ? { name: change.name.trim() } : change) };
    await this.app.storage.commitRecords([{ namespace: projectNamespace, id, expectedRevision: current.revision, value }]);
    this.app.publish({ type: 'project.navigation.changed' });
    return { success: true };
  }
  private async removalPlan(actorId: string, target: ProjectNavigationTarget) {
    const resolved = this.target(actorId, target);
    const workspaces = this.app.settings.snapshot().settings.workspaces;
    const hidden = this.app.subagents.childConversationIds();
    const conversations: Array<{ id: string; createdAt: number }> = [];
    let cursor: { updatedAt: number; id: string } | undefined;
    do {
      const page = await this.app.storage.listConversations({ limit: 200, cursor });
      for (const item of page.items) {
        if (item.botPlatform || hidden.has(item.id)) continue;
        const workspace = conversationWorkspace(item, workspaces);
        const matches = resolved.workspaceId ? workspace?.id === resolved.workspaceId
          : !workspace && projectNavigationKey({ workspaceUri: item.workspaceUri }) === projectNavigationKey(resolved);
        if (matches) conversations.push({ id: item.id, createdAt: item.createdAt });
      }
      cursor = page.nextCursor;
    } while (cursor);
    conversations.sort((left, right) => left.id.localeCompare(right.id));
    const token = createHash('sha256').update(JSON.stringify(conversations)).digest('hex');
    const ids = new Set(conversations.map(item => item.id));
    const activeCount = (await this.app.storage.listRuns({ activeOnly: true, limit: 1000 })).filter(run => ids.has(run.conversationId)).length;
    return { resolved, conversations, count: conversations.length, activeCount, token };
  }
  async previewRemoval(actorId: string, target: ProjectNavigationTarget) {
    const { count, activeCount, token } = await this.removalPlan(actorId, target);
    return { count, activeCount, token };
  }
  async remove(actorId: string, target: ProjectNavigationTarget, options: { deleteConversations?: boolean; token?: string } = {}) {
    const deletedIds: string[] = [];
    if (options.deleteConversations === true) {
      const plan = await this.removalPlan(actorId, target);
      if (options.token !== plan.token) throw new Error('关联对话列表已经变化，请重新打开移除窗口后确认。');
      try {
        for (const item of plan.conversations) { await deleteConversation(this.app, actorId, item.id); deletedIds.push(item.id); }
      } catch (error) { throw new Error(`已删除 ${deletedIds.length} 个对话，清理尚未完成：${(error as Error).message}`); }
    }
    await this.update(actorId, target, { removed: true });
    return { success: true, deletedIds };
  }
  async restore(actorId: string, target: ProjectNavigationTarget) {
    const resolved = this.target(actorId, target);
    const ids = [...new Set([projectNavigationKey(resolved), projectNavigationKey({ workspaceUri: resolved.workspaceUri })])];
    const records: RecordMutation[] = [];
    for (const id of ids) {
      const current = await this.app.storage.getVersionedRecord(projectNamespace, id);
      const value = current.value as ProjectNavigationPreference | null;
      if (value?.removed) records.push({ namespace: projectNamespace, id, expectedRevision: current.revision, value: { ...value, removed: false } });
    }
    if (records.length) {
      await this.app.storage.commitRecords(records);
      this.app.publish({ type: 'project.navigation.changed' });
    }
  }
}
