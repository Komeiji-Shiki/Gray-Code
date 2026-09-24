import path from 'node:path';
import { mkdir, realpath, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { PlatformApplication } from '../application';
import type { BotChannelIdentity } from './channelAccess';
import { documentsDirectory } from '../workspace/documentsDirectory';

export class BotWorkspaces {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly documentsDirectory: () => Promise<string>;
  constructor(private readonly app: PlatformApplication, suppliedDocuments?: string) { this.documentsDirectory = documentsDirectory(suppliedDocuments); }
  async get(context: BotChannelIdentity, conversationId: string, options: { existingOnly?: boolean; workspaceUri?: string } = {}): Promise<string> {
    const operation = this.queue.catch(() => {}).then(async () => {
      const id = `workspace-${conversationId}`;
      const previous = this.app.settings.snapshot().settings.workspaces.find(workspace => workspace.id === id);
      if (previous) return previous.id;
      const channel = context.channelId.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 48) || 'conversation';
      const directory = path.join(await this.documentsDirectory(), 'graycode', context.platform === 'discord' ? 'discord' : 'qq', `${channel}-${conversationId.slice(-12)}`);
      if (options.existingOnly) {
        // 旧会话的自动工作区登记丢失时，只认原本应存在的目录，不创建空目录冒充旧文件。
        const existing = await stat(directory).catch(error => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('原自动工作区目录已不存在，请由主人重新选择工作区。');
          throw error;
        });
        if (!existing.isDirectory()) throw new Error('原自动工作区路径不是目录，请由主人重新选择工作区。');
        if (options.workspaceUri) {
          const actual = await realpath(directory);
          const original = await realpath(fileURLToPath(options.workspaceUri));
          const normalize = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
          if (normalize(actual) !== normalize(original)) throw new Error('自动工作区目录与原会话记录不一致，请由主人重新选择工作区。');
        }
      } else await mkdir(directory, { recursive: true });
      const current = this.app.settings.snapshot();
      if (!current.settings.workspaces.some(workspace => workspace.id === id)) {
        current.settings.workspaces.push({ id, directory, deviceId: 'local', managedConversationId: conversationId, name: `${context.platform === 'discord' ? 'Discord' : 'QQ'} · ${context.channelId}` });
        await this.app.settings.save({ settings: current.settings, expectedRevision: current.revision });
      }
      return id;
    });
    this.queue = operation;
    return operation;
  }
}
