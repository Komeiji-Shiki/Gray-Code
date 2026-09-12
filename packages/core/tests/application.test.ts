import path from 'node:path';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { PlatformApplication } from '../../../apps/server/src/application';
import { ApplicationRouter } from '../../../apps/server/src/transport/router';
import { startHttpServer } from '../../../apps/server/src/transport/http';
import { fixture } from './fixtures';
import type { SettingsSnapshot } from '@graycode/contracts';

describe('application composition and local clients', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  let app: PlatformApplication;
  let router: ApplicationRouter;
  const owner = { actorId: 'owner', clientId: 'editor-one' };
  const key = randomBytes(32);
  beforeEach(async () => {
    f = await fixture(); await f.store.close();
    app = await PlatformApplication.open({ dataDirectory: f.data,
      secretCodec: {
        encrypt: async text => { const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv); const content = Buffer.concat([cipher.update(text), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), content]); },
        decrypt: async value => { const bytes = Buffer.from(value); const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)); cipher.setAuthTag(bytes.subarray(12, 28)); return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString(); },
      },
      models: { generate: async input => input.messages.some(message => message.role === 'model')
        ? { role: 'model', parts: [{ text: 'File created.' }] }
        : { role: 'model', parts: [{ functionCall: { id: 'write-once', name: 'workspace_files',
          args: { action: 'write', path: 'result.txt', content: 'written by model', expectedHash: null, oldText: null, newText: null } } }] } },
    });
    const draft = app.settings.snapshot();
    draft.settings.workspaces.push({ id: 'project', name: 'Fixture', directory: f.source, deviceId: 'local' });
    draft.settings.accounts.push({ id: 'guest', displayName: '主人', role: 'guest', effects: ['public_read'], workspaceIds: [] });
    await app.settings.save({ settings: draft.settings, expectedRevision: draft.revision });
    router = new ApplicationRouter(app);
  });
  afterEach(async () => { await app.close(); await f.cleanup(); });

  test('runs model tools through the public application interface with authenticated identity and paired history', async () => {
    const conversation = await router.call(owner, 'conversations.create', { title: 'Integration', workspaceId: 'project' }) as { id: string };
    const run = await router.call(owner, 'runs.start', { actorId: 'guest', role: 'guest', conversationId: conversation.id,
      requestKey: 'one', agentId: 'default', text: 'Create a file.' }) as { id: string };
    expect((await app.runtime.wait(run.id))?.status).toBe('completed');
    expect(await readFile(path.join(f.source, 'result.txt'), 'utf8')).toBe('written by model');
    const messages = (await app.storage.readFullHistory(conversation.id)).messages;
    expect(messages[0].actorId).toBe('owner');
    expect(messages[2].parts[0]).toMatchObject({ functionResponse: { id: 'write-once', response: { success: true } } });
    const guest = { actorId: 'guest', clientId: 'other' };
    await expect(router.call(guest, 'settings.get')).rejects.toThrow('Owner access');
    await expect(router.call(guest, 'conversations.history', { id: conversation.id })).rejects.toThrow('not accessible');
    expect(await router.call(guest, 'conversations.list')).toMatchObject({ items: [] });
  });

  test('preserves editor drafts, enforces disk hashes and serializes concurrent writes', async () => {
    await writeFile(path.join(f.source, 'editor.txt'), 'initial');
    const params = { workspaceId: 'project', path: 'editor.txt' };
    const opened = await router.call(owner, 'documents.open', params) as { version: number; baseHash: string };
    const draft = await router.call(owner, 'documents.update', { ...params, version: opened.version, text: 'user edit' }) as { version: number };
    const workspace = app.workspace('owner', 'project', []);
    await expect(app.files.write(workspace, 'editor.txt', 'model edit', opened.baseHash)).rejects.toThrow('DOCUMENT_DIRTY');
    await router.call(owner, 'documents.save', { ...params, version: draft.version });
    expect(await readFile(path.join(f.source, 'editor.txt'), 'utf8')).toBe('user edit');
    await expect(app.files.write(workspace, 'editor.txt', 'stale overwrite', opened.baseHash)).rejects.toThrow('FILE_CONFLICT');
    const latest = await app.files.read(workspace, 'editor.txt');
    const results = await Promise.allSettled([app.files.write(workspace, 'editor.txt', 'one', latest.hash), app.files.write(workspace, 'editor.txt', 'two', latest.hash)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  });

  test('rejects workspace traversal and existing junctions leading outside the authorized directory', async () => {
    const outside = path.join(f.root, 'outside'); await mkdir(outside);
    await writeFile(path.join(outside, 'private.txt'), 'private');
    await symlink(outside, path.join(f.source, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    const workspace = app.workspace('owner', 'project', []);
    await expect(app.files.read(workspace, '../outside/private.txt')).rejects.toThrow('outside');
    await expect(app.files.write(workspace, 'escape/new/file.txt', 'blocked', null)).rejects.toThrow('路径不在本次批准的写入范围内');
    await expect(readFile(path.join(outside, 'new/file.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('atomically saves a whole settings draft and encrypted secrets without returning secret values', async () => {
    const first = app.settings.snapshot(); const other = structuredClone(first);
    first.settings.appearance.fontSize = 16;
    const saved = await router.call(owner, 'settings.save', { settings: first.settings, expectedRevision: first.revision, credentials: { provider: 'fixture-private-key' } }) as SettingsSnapshot;
    expect(saved.settings.appearance.fontSize).toBe(16); expect(saved.credentialIds).toContain('provider');
    expect(JSON.stringify(saved)).not.toContain('fixture-private-key');
    expect(await app.settings.credential('provider')).toBe('fixture-private-key');
    await expect(app.settings.save({ settings: other.settings, expectedRevision: other.revision, credentials: { provider: 'stale-key' } })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    expect(await app.settings.credential('provider')).toBe('fixture-private-key');
  });

  test('authenticates HTTP requests and ignores client-supplied account authority', async () => {
    const token = randomBytes(32).toString('hex');
    const server = await startHttpServer(app, { token, actorId: 'guest' });
    try {
      const url = `http://127.0.0.1:${server.port}/rpc`;
      expect((await fetch(url, { method: 'POST', body: '{}' })).status).toBe(401);
      const response = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ method: 'settings.get', params: { actorId: 'owner', role: 'owner' } }) });
      expect(response.status).toBe(400); expect(await response.json()).toMatchObject({ error: 'Owner access is required.' });
      expect((await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, Origin: 'https://untrusted.example' }, body: '{}' })).status).toBe(403);
    } finally { await server.close(); }
  });
});
