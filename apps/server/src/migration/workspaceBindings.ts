import { pathToFileURL } from 'node:url';
import type { RecordMutation } from '@graycode/contracts';
import type { PlatformApplication } from '../application';
import type { WorkspaceCheckpoint } from '../workspace/checkpoints';
import { workspaceSnapshotRoots } from '../workspace/paths';
import { createWorkspaceScopedPath, parseWorkspaceScopedPath } from '../../../../backend/modules/checkpoint/CheckpointWorkspace';

export async function migrationWorkspaceRoots(app: PlatformApplication, actorId: string, conversationId: string) {
  app.requireOwner(actorId);
  const conversation = await app.conversation(actorId, conversationId);
  if (!conversation.legacySource) throw new Error('只有已迁入的旧对话可以在此对应目录。');
  const roots = new Map<string, { id: string; name: string; uri: string }>();
  for (const checkpoint of await app.checkpoints.list(actorId, conversationId)) for (const root of checkpoint.manifest.roots) {
    const previous = roots.get(root.id);
    if (previous && previous.uri !== root.uri) throw new Error('旧检查点中的目录标识不一致，请检查迁移报告。');
    roots.set(root.id, root);
  }
  return { roots: [...roots.values()], workspaceId: conversation.workspaceId };
}

/** 显式对应每个旧目录；仅修改存档归属，文件恢复仍由原来的预览与确认入口完成。 */
export async function bindMigrationWorkspace(app: PlatformApplication, actorId: string, conversationId: string, workspaceId: string,
  mapping?: Record<string, string>) {
  app.requireOwner(actorId);
  await app.conversations.idle(actorId, conversationId);
  const workspace = app.workspace(actorId, workspaceId, ['workspace_read']);
  const state = await app.storage.readConversationState(conversationId);
  if (!state.metadata.legacySource) throw new Error('只有已迁入的旧对话可以在此绑定工作区。');
  const targets = workspaceSnapshotRoots(workspace);
  const originals = (await migrationWorkspaceRoots(app, actorId, conversationId)).roots;
  const selected = new Map<string, typeof targets[number]>();
  for (const source of originals) {
    const target = mapping?.[source.id];
    const root = originals.length === 1 && targets.length === 1 && target === undefined ? targets[0] : targets.find(item => item.fsPath === target);
    if (!root) throw new Error(`请为旧目录「${source.name}」选择当前工作区中的对应目录。`);
    selected.set(source.id, root);
  }
  const records: RecordMutation[] = [];
  for (const id of await app.storage.listRecords('workspace-checkpoints', conversationId)) {
    const record = await app.storage.getVersionedRecord('workspace-checkpoints', id);
    const checkpoint = record.value as WorkspaceCheckpoint;
    const previousRoots = checkpoint.manifest.roots.map(root => ({ ...root, fsPath: '' }));
    const roots = checkpoint.manifest.roots.map(root => selected.get(root.id)!);
    if (new Set(roots.map(root => root.id)).size !== roots.length) throw new Error('同一个检查点中的不同旧目录不能合并到同一个新目录。');
    const scoped = (key: string) => {
      const parsed = parseWorkspaceScopedPath(key, previousRoots);
      return createWorkspaceScopedPath(selected.get(parsed.root.id)!.id, parsed.relativePath);
    };
    const remap = <T>(values: Record<string, T>): Record<string, T> => Object.fromEntries(Object.entries(values).map(([key, value]) => [scoped(key), value]));
    records.push({ namespace: 'workspace-checkpoints', id, ownerId: conversationId, expectedRevision: record.revision,
      value: { ...checkpoint, workspaceId, directory: workspace.directory, contentIds: remap(checkpoint.contentIds),
        manifest: { ...checkpoint.manifest, workspaceId, roots: roots.map(({ id, name, uri }) => ({ id, name, uri })), files: remap(checkpoint.manifest.files),
          excluded: checkpoint.manifest.excluded.map(entry => ({ ...entry, path: scoped(entry.path) })),
          absentPaths: checkpoint.manifest.absentPaths.map(scoped), emptyDirs: checkpoint.manifest.emptyDirs.map(scoped) } } });
  }
  await app.storage.commitConversation({ conversationId, expectedRevision: state.history.revision, expectedMetadataToken: state.metadataToken,
    metadata: { ...state.metadata, workspaceId, workspaceUri: pathToFileURL(workspace.directory).toString() }, records });
  app.productUi.conversations.clearMetadataCache();
  app.publish({ type: 'workspace.checkpoint.changed', conversationId });
  app.publish({ type: 'conversation.changed', conversationId });
  return { success: true, workspaceId };
}
