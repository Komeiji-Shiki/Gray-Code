import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import type { PlatformApplication } from '../application';
import { documentsDirectory } from './documentsDirectory';

export class ConversationWorkspaces {
  private readonly documents: () => Promise<string>;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly app: PlatformApplication, suppliedDocuments?: string) { this.documents = documentsDirectory(suppliedDocuments); }
  async root(): Promise<string> { return path.join(await this.documents(), 'graycode'); }
  get(conversationId: string, title: string, createdAt: number): Promise<string> {
    const operation = this.queue.catch(() => {}).then(async () => {
      const previous = this.app.settings.snapshot().settings.workspaces.find(item => item.managedConversationId === conversationId);
      if (previous) return previous.id;
      const date = new Date(createdAt);
      const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
      const digest = createHash('sha256').update(conversationId).digest('hex');
      const folder = `${conversationId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48)}-${digest.slice(0, 12)}`;
      const directory = path.join(await this.root(), day, folder);
      await mkdir(directory, { recursive: true });
      const snapshot = this.app.settings.snapshot(); const id = `auto-${digest.slice(0, 24)}`;
      snapshot.settings.workspaces.push({ id, name: title || '新对话', directory, deviceId: 'local', managedConversationId: conversationId });
      await this.app.settings.save({ settings: snapshot.settings, expectedRevision: snapshot.revision });
      return id;
    });
    this.queue = operation; return operation;
  }
}
