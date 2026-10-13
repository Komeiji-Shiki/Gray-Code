import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdir, rmdir } from 'node:fs/promises';
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
  release(conversationIds: readonly string[]): Promise<void> {
    const ids = new Set(conversationIds);
    const operation = this.queue.catch(() => {}).then(async () => {
      const snapshot = this.app.settings.snapshot();
      const released = snapshot.settings.workspaces.filter(item => item.managedConversationId && ids.has(item.managedConversationId));
      if (!released.length) return;
      snapshot.settings.workspaces = snapshot.settings.workspaces.filter(item => !item.managedConversationId || !ids.has(item.managedConversationId));
      await this.app.settings.save({ settings: snapshot.settings, expectedRevision: snapshot.revision });
      for (const workspace of released) {
        try {
          // rmdir 只删除空目录，检查与删除由文件系统一次完成，用户已经写入的文件始终保留。
          await rmdir(workspace.directory);
        } catch (error) {
          if (['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) continue;
          console.warn('[对话工作区] 空目录清理失败，已保留目录：', workspace.directory, String(error));
        }
      }
    });
    this.queue = operation; return operation;
  }
  async cleanupOrphans(): Promise<void> {
    const ids = [...new Set(this.app.settings.read('workspaces').workspaces
      .flatMap(item => item.managedConversationId ? [item.managedConversationId] : []))];
    const orphaned: string[] = [];
    for (let offset = 0; offset < ids.length; offset += 1000) {
      const batch = ids.slice(offset, offset + 1000);
      const page = await this.app.storage.listConversations({ ids: batch, limit: batch.length });
      const existing = new Set(page.items.map(item => item.id));
      orphaned.push(...batch.filter(id => !existing.has(id)));
    }
    if (orphaned.length) await this.release(orphaned);
  }
}
