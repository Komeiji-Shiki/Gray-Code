import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import type { WorkspaceDefinition } from '@graycode/contracts';
import type { ToolContext } from '@graycode/core';
import type { PlatformApplication } from '../../application';
import { BOT_CHANNEL_ACCESS, type BotChannelAccess } from '../../bots/channelAccess';
import { safeDirectoryName } from '../../bots/workspaces';
import { workspaceDirectoryKey } from '../../workspace/identity';
import { inside, resolveWorkspacePath } from '../../workspace/paths';
import { paths } from '../../workspace/writeAccess';
import { GENERAL_FILE_WRITE_TOOLS } from '../../../../../backend/modules/settings/modeToolsPolicy';

export async function memoryRoots(
  app: PlatformApplication, actorId: string, conversationId: string | undefined, workspace?: WorkspaceDefinition,
): Promise<Array<{ label: 'global' | 'project' | 'channel' | 'story'; directory: string }>> {
  if (!app.product.runtimeSettings().isMemoryEnabled()) return [];
  const base = path.join(app.storage.directory, 'memory');
  if (conversationId) {
    const rootId = app.subagents.rootConversationId(conversationId);
    const access = await app.storage.getRecord(BOT_CHANNEL_ACCESS, rootId) as BotChannelAccess | null;
    if (access?.version === 1) {
      const channel = access.context;
      const platform = channel.platform === 'discord' ? 'discord' : 'qq';
      const name = `${platform}-${channel.direct ? 'dm-' : ''}${safeDirectoryName(channel.channelId)}`;
      return [{ label: 'channel', directory: path.join(base, 'bots', name) }];
    }
    const conversation = await app.storage.getConversationInfo(rootId);
    if (conversation?.metadata.custom?.platformMode === 'character') {
      return [{ label: 'story', directory: path.join(base, 'characters', rootId) }];
    }
  }
  if (app.actor(actorId)?.role !== 'owner') return [];
  const roots: Array<{ label: 'global' | 'project'; directory: string }> = [{ label: 'global', directory: path.join(base, 'global') }];
  if (workspace && !workspace.id.startsWith('memory:')) {
    const hash = createHash('sha256').update(workspaceDirectoryKey(workspace.directory)!).digest('hex').slice(0, 12);
    const name = `${safeDirectoryName(path.basename(workspace.directory))}-${hash}`;
    roots.push({ label: 'project', directory: path.join(base, 'projects', name) });
  }
  return roots;
}

export async function prepareMemoryWorkspace(app: PlatformApplication, context: ToolContext, name: string, args: Record<string, unknown>): Promise<void> {
  if (context.workspace || !GENERAL_FILE_WRITE_TOOLS.has(name) && !['read_file', 'list_files', 'find_files', 'search_in_files'].includes(name)) return;
  const requested = paths(args);
  if (!requested.length) return;
  const targets = await Promise.all(requested.map(value => app.files.resolveAbsolute(resolveWorkspacePath(undefined, value), name === 'delete_file')));
  for (const root of await memoryRoots(app, context.actorId, context.conversationId)) {
    const directory = await app.files.resolveAbsolute(root.directory);
    if (targets.every(target => inside(directory, target))) {
      await mkdir(root.directory, { recursive: true });
      context.workspace = { id: `memory:${path.basename(root.directory)}`, name: root.label, directory: root.directory, deviceId: 'local' };
      return;
    }
  }
}
