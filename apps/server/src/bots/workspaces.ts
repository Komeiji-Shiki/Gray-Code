import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import type { PlatformApplication } from '../application';
import type { BotChannelIdentity } from './channelAccess';
import { documentsDirectory } from '../workspace/documentsDirectory';

export class BotWorkspaces {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly documentsDirectory: () => Promise<string>;
  constructor(private readonly app: PlatformApplication, suppliedDocuments?: string) { this.documentsDirectory = documentsDirectory(suppliedDocuments); }
  async get(context: BotChannelIdentity, conversationId: string): Promise<string> {
    const operation = this.queue.catch(() => {}).then(async () => {
      const id = `workspace-${conversationId}`;
      const previous = this.app.settings.snapshot().settings.workspaces.find(workspace => workspace.id === id);
      if (previous) return previous.id;
      const channel = context.channelId.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 48) || 'conversation';
      const directory = path.join(await this.documentsDirectory(), 'graycode', context.platform === 'discord' ? 'discord' : 'qq', `${channel}-${conversationId.slice(-12)}`);
      await mkdir(directory, { recursive: true });
      const current = this.app.settings.snapshot();
      if (!current.settings.workspaces.some(workspace => workspace.id === id)) {
        current.settings.workspaces.push({ id, directory, deviceId: 'local', name: `${context.platform === 'discord' ? 'Discord' : 'QQ'} · ${context.channelId}` });
        await this.app.settings.save({ settings: current.settings, expectedRevision: current.revision });
      }
      return id;
    });
    this.queue = operation;
    return operation;
  }
}
