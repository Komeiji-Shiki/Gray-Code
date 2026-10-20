import type { PlatformApplication } from '../../../apps/server/src/application';
import { startControlServer } from '../../../apps/server/src/control/server';

const token = 'a'.repeat(64);
const conversation = { id: 'conversation-1', title: 'Hello', actorId: 'owner', createdAt: 1, updatedAt: 2, workspaceId: 'workspace-1' };

function createApp() {
  const listeners: ((event: Record<string, any>) => void)[] = [];
  const starts: Record<string, any>[] = [];
  const synthesized: Record<string, any>[] = [];
  const app = {
    settings: { read: (key: string) => key === 'agents' ? { agents: [{ id: 'default', name: 'GrayCode' }] } : {} },
    runtime: {
      activeCount: 2,
      start: async (input: Record<string, any>) => {
        starts.push(input);
        return { id: 'run-1', status: 'running', conversationId: input.conversationId };
      },
      wait: async () => ({ id: 'run-1', status: 'completed', conversationId: conversation.id }),
      cancel: async () => {},
    },
    storage: {
      listConversations: async () => ({ items: [conversation] }),
      readHistory: async (id: string) => ({ conversationId: id, messages: [{ role: 'user', parts: [{ text: 'hi' }] }] }),
      getRun: async (id: string) => id === 'run-1' ? { id, conversationId: conversation.id, status: 'completed' } : null,
      readRunEvents: async () => [{ sequence: 1, event: { type: 'run.completed' } }],
    },
    conversation: async () => conversation,
    createConversation: async (_actor: string, title: string) => ({ ...conversation, id: 'conversation-2', title }),
    subscribe: (listener: (event: Record<string, any>) => void) => { listeners.push(listener); return () => {}; },
    emit: (event: Record<string, any>) => { for (const listener of listeners) listener(event); },
    speech: {
      synthesize: async (input: Record<string, any>) => { synthesized.push(input);
        return { provider: 'fish', clips: [{ text: input.text, mimeType: 'audio/mpeg', base64: 'YQ==' }] }; },
      clone: async () => ({ id: 'voice-2', state: 'trained' }),
    },
    requireOwner: () => {},
    files: { clientConnected: () => {}, clientClosed: async () => {} },
    languages: { clientConnected: () => {}, clientClosed: async () => {} },
    productUi: { clientConnected: () => {}, clientClosed: async () => {}, commands: { connected: () => {} } },
    starts,
    synthesized,
  };
  return { app: app as unknown as PlatformApplication & typeof app };
}

async function request(port: number, path: string, init: RequestInit = {}) {
  return fetch(`http://127.0.0.1:${port}${path}`, init);
}

describe('external control API', () => {
  test('requires the bearer token and exposes status and conversations', async () => {
    const { app } = createApp();
    const server = await startControlServer(app, { port: 0, token, allowLan: false });
    try {
      expect((await request(server.port, '/v1/health')).status).toBe(401);
      const headers = { Authorization: `Bearer ${token}` };
      const health = await request(server.port, '/v1/health', { headers });
      expect(await health.json()).toMatchObject({ name: 'GrayCode', status: 'ok' });
      const status = await request(server.port, '/v1/status', { headers });
      expect(await status.json()).toMatchObject({ actorId: 'owner', activeRuns: 2,
        agents: [{ id: 'default', name: 'GrayCode' }] });
      const list = await request(server.port, '/v1/conversations', { headers });
      expect(await list.json()).toMatchObject({ items: [{ id: 'conversation-1' }] });
    } finally { await server.close(); }
  });

  test('starts a run with the message and supports waiting for completion', async () => {
    const { app } = createApp();
    const server = await startControlServer(app, { port: 0, token, allowLan: false });
    try {
      const response = await request(server.port, '/v1/conversations/conversation-1/messages', {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: '你好', wait: true }),
      });
      expect(response.status).toBe(202);
      expect(await response.json()).toMatchObject({ conversationId: 'conversation-1',
        run: { id: 'run-1', status: 'completed' } });
      expect(app.starts[0]).toMatchObject({ actorId: 'owner', agentId: 'default', conversationId: 'conversation-1',
        message: { role: 'user', parts: [{ text: '你好' }] } });
    } finally { await server.close(); }
  });

  test('streams filtered events and can resume from Last-Event-ID', async () => {
    const { app } = createApp();
    const server = await startControlServer(app, { port: 0, token, allowLan: false });
    const controller = new AbortController();
    try {
      const response = await request(server.port, '/v1/events?types=run.completed', {
        headers: { Authorization: `Bearer ${token}` }, signal: controller.signal,
      });
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      await reader.read();
      app.emit({ type: 'run.created', runId: 'run-1' });
      app.emit({ type: 'run.completed', runId: 'run-1' });
      const chunk = decoder.decode((await reader.read()).value);
      expect(chunk).toContain('run.completed');
      expect(chunk).not.toContain('run.created');
      controller.abort();
      await reader.cancel().catch(() => {});
    } finally { controller.abort(); await server.close(); }
  });

  test('synthesizes speech and rejects disabled operations with a clear status', async () => {
    const { app } = createApp();
    const server = await startControlServer(app, { port: 0, token, allowLan: false });
    try {
      const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
      const speech = await request(server.port, '/v1/speech', { method: 'POST', headers, body: JSON.stringify({ text: '你好' }) });
      expect(await speech.json()).toMatchObject({ provider: 'fish', clips: [{ base64: 'YQ==' }] });
      expect(app.synthesized[0]).toMatchObject({ text: '你好' });
      const missing = await request(server.port, '/v1/does-not-exist', { headers });
      expect(missing.status).toBe(404);
    } finally { await server.close(); }
  });
});
