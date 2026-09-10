import path from 'node:path';
import { stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { PlatformApplication } from '../application';
import type { PlatformConversation, WorkspaceDefinition } from '@graycode/contracts';
import { workspaceDirectory, workspaceDirectoryKey } from '../workspace/identity';
import { workspaceSnapshotRoots } from '../workspace/paths';
import { migrationWorkspaceRoots, bindMigrationWorkspace } from '../migration/workspaceBindings';

/** 只在主人打开迁入对话时建立关系，不扫描或恢复项目中的文件。 */
export async function activateConversationWorkspace(app: PlatformApplication, actorId: string, conversation: PlatformConversation) {
  if (conversation.workspaceId || !conversation.workspaceUri || !conversation.legacySource) return conversation;
  app.requireOwner(actorId);
  const directory = workspaceDirectory(conversation.workspaceUri);
  if (!directory) throw new Error('这个旧项目不是可打开的本地目录，请在旧存档迁移中重新绑定工作区。');
  const originals = (await migrationWorkspaceRoots(app, actorId, conversation.id)).roots;
  const snapshot = app.settings.snapshot();
  const primary = snapshot.settings.workspaces.filter(workspace => workspaceDirectoryKey(workspace.directory) === workspaceDirectoryKey(directory));
  const candidates = primary.filter(workspace => originals.every(original => workspaceSnapshotRoots(workspace)
    .some(root => workspaceDirectoryKey(root.uri) === workspaceDirectoryKey(original.uri))));
  if (candidates.length > 1 || primary.length && !candidates.length)
    throw new Error('这个旧项目对应多个目录，无法唯一匹配现有工作区，请在旧存档迁移中逐个对应目录。');
  let workspace: WorkspaceDefinition | undefined = candidates[0];
  if (!workspace) {
    const directories = new Map([[workspaceDirectoryKey(directory)!, { name: path.basename(directory) || directory, directory }]]);
    for (const original of originals) {
      const originalDirectory = workspaceDirectory(original.uri);
      if (!originalDirectory) throw new Error('旧项目包含非本地目录，请在旧存档迁移中对应工作区。');
      if (!directories.has(workspaceDirectoryKey(originalDirectory)!)) directories.set(workspaceDirectoryKey(originalDirectory)!, { name: original.name, directory: originalDirectory });
    }
    for (const item of directories.values()) {
      if (!(await stat(item.directory).catch(() => null))?.isDirectory()) throw new Error(`旧项目目录已不存在或无法访问：${item.directory}。请在旧存档迁移中绑定现有目录。`);
    }
    workspace = { id: randomUUID(), name: path.basename(directory) || directory, directory, deviceId: 'local',
      ...(directories.size > 1 ? { roots: [...directories.values()] } : {}) };
    snapshot.settings.workspaces.push(workspace);
    await app.settings.save({ settings: snapshot.settings, expectedRevision: snapshot.revision });
  }
  const targetRoots = workspaceSnapshotRoots(workspace);
  const mapping = Object.fromEntries(originals.map(original => [original.id,
    targetRoots.find(root => workspaceDirectoryKey(root.uri) === workspaceDirectoryKey(original.uri))!.fsPath]));
  await bindMigrationWorkspace(app, actorId, conversation.id, workspace.id, mapping);
  return app.conversation(actorId, conversation.id);
}
