import { workspaceSnapshotRoots } from './paths';
import type { PlatformApplication } from '../application';
import type { ClientSession } from '../transport/router';
import type { ProductSettingsDraft } from '../settings/product';
import { CheckpointOperations } from './checkpointOperations';
import { DEFAULT_EXCLUSION_PROFILES } from '../../../../backend/modules/checkpoint/CheckpointExclusionProfiles';
import { previewExclusions } from '../../../../backend/modules/checkpoint/CheckpointSnapshotBuilder';

export class CheckpointUi {
  readonly operations = new CheckpointOperations();
  constructor(private readonly app: PlatformApplication) {}
  handlers(client: ClientSession, draft: ProductSettingsDraft, workspaceId?: string): Record<string, (data: Record<string, any>) => unknown> {
    const actorId = client.actorId;
    return {
      'checkpoint.getOperationProgress': data => this.operations.get(client.clientId, data.operationId),
      'checkpoint.cancelOperation': data => this.operations.cancel(client.clientId, data.operationId),
      'checkpoint.getExclusionProfiles': () => ({ profiles: DEFAULT_EXCLUSION_PROFILES }),
      'checkpoint.getManifest': data => this.app.checkpoints.manifest(actorId, data.checkpointId),
      'checkpoint.createManual': data => this.operations.run(client.clientId, 'create', data.conversationId, undefined, async operation => {
        const checkpoint = await this.app.checkpoints.create(actorId, data.conversationId, { name: data.name, operation });
        return { success: true, checkpoint };
      }),
      'checkpoint.restore': data => this.operations.run(client.clientId, 'restore', data.conversationId, data.checkpointId, async operation => {
        await this.app.conversations.idle(actorId, data.conversationId);
        return this.app.checkpoints.restore(actorId, data.conversationId, data.checkpointId, { ...data, operation });
      }),
      'checkpoint.previewExclusions': async () => {
        if (!workspaceId) throw new Error('请先选择工作区。');
        const workspace = this.app.workspace(actorId, workspaceId, ['workspace_read']);
        const config = draft.settings.getCheckpointConfig();
        return previewExclusions({ roots: workspaceSnapshotRoots(workspace),
          customIgnorePatterns: [...(config.customIgnorePatterns ?? []), ...(config.exclusion?.customPatterns ?? [])],
          enabledProfiles: config.exclusion?.enabledProfiles, profilePatterns: config.exclusion?.profilePatterns,
          maxFileSizeBytes: config.exclusion?.maxFileSizeBytes, excludeAbsolutePaths: [this.app.storage.directory] });
      },
      'checkpoint.getAllConversationsWithCheckpoints': () => this.list(actorId),
      'checkpoint.deleteBatch': data => this.operations.run(client.clientId, 'delete', undefined, undefined, async operation => {
        if (!Array.isArray(data.items)) throw new Error('请选择要清理的检查点。');
        const results: Array<{ conversationId: string; success: boolean; deletedIds: string[]; rejectedIds: string[]; error?: string }> = [];
        operation.commit();
        for (const item of data.items) {
          if (typeof item.conversationId !== 'string' || !Array.isArray(item.checkpointIds) || item.checkpointIds.some((id: unknown) => typeof id !== 'string')) throw new Error('检查点清理参数无效。');
          const result = { conversationId: item.conversationId, success: true, deletedIds: [] as string[], rejectedIds: [] as string[], error: undefined as string | undefined };
          let ids: string[] = item.checkpointIds;
          try {
            await this.app.conversation(actorId, item.conversationId);
            if ((await this.app.storage.listRuns({ conversationId: item.conversationId, activeOnly: true, limit: 1 })).length) throw new Error('对话仍有运行任务，已跳过清理。');
            if (!ids.length) ids = (await this.app.checkpoints.list(actorId, item.conversationId)).map(value => value.id);
            for (const id of new Set(ids)) {
              try { await this.app.checkpoints.delete(actorId, item.conversationId, id); result.deletedIds.push(id); }
              catch (error) { result.rejectedIds.push(id); result.error = String(error); }
            }
          } catch (error) { result.success = false; result.rejectedIds = ids.filter(id => !result.deletedIds.includes(id)); result.error = String(error); }
          results.push(result); operation.update('deleting', results.length, data.items.length);
        }
        return { results };
      }),
    };
  }
  private async list(actorId: string) {
    const conversations: Array<{ conversationId: string; title: string; checkpointCount: number; totalSize: number }> = [];
    let cursor: { updatedAt: number; id: string } | undefined;
    do {
      const page = await this.app.storage.listConversations({ limit: 1000, cursor });
      for (const item of page.items) {
        const { checkpoints } = await this.app.checkpoints.summaries(actorId, item.id, true);
        if (checkpoints.length) conversations.push({ conversationId: item.id, title: item.title ?? '未命名对话',
          checkpointCount: checkpoints.length, totalSize: checkpoints.reduce((sum, value) => sum + value.size, 0) });
      }
      cursor = page.nextCursor;
    } while (cursor);
    return { conversations };
  }
}
