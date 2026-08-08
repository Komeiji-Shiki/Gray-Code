/**
 * e2e.ts - End-to-end backend test harness (main process, GRAYCODE_E2E=1).
 *
 * Verifies the full standalone stack against a local mock OpenAI server:
 *  1. create an OpenAI-compatible channel
 *  2. create a conversation
 *  3. run a chatStream and assert we receive stream chunks
 *  4. assert tool calling works (mock returns a read_file tool call)
 *  5. assert conversation history was persisted
 *
 * Run with: GRAYCODE_E2E=1 electron .
 */

import { app } from 'electron';
import * as http from 'http';
import * as path from 'path';
import * as fs from 'fs';
import { BackendHost } from './host/BackendHost.js';

const log = (msg: string) => console.log(`[e2e] ${msg}`);
let failures = 0;
const assert = (cond: boolean, label: string) => {
  if (cond) {
    log(`PASS ${label}`);
  } else {
    failures++;
    log(`FAIL ${label}`);
  }
};

interface PendingRequest {
  resolve: (data: any) => void;
  reject: (err: Error) => void;
}

export async function runE2E(): Promise<void> {
  const userData = path.join(app.getPath('temp'), 'graycode-e2e-' + Date.now());
  fs.mkdirSync(userData, { recursive: true });

  // ---------- mock OpenAI-compatible server ----------
  // Scriptable: sets `mockScenario` before sending chatStream.
  // Only the FIRST request without a tool message receives the scenario tool
  // call; every later non-tool request gets plain text. This keeps nested
  // loops (e.g. sub-agent internal chat) from recursing on the same scenario.
  let mockScenario: 'read_file' | 'apply_diff' | 'write_file_confirm' | 'delete_file_confirm' | 'mcp_echo' | 'subagents' | 'read_cjk' = 'read_file';
  let toolCallSent = false;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = (() => {
        try {
          return JSON.parse(body);
        } catch {
          return {};
        }
      })();
      const wantsStream = parsed.stream === true;
      log(`mock server ${req.method} ${req.url} stream=${wantsStream} messages=${(parsed.messages || []).length} toolRound=${(parsed.messages || []).some((m: any) => m.role === 'tool')}`);
      const chatId = 'chatcmpl-e2e';
      const finishToolCall = parsed.messages?.some((m: any) => m.role === 'tool');
      const send = (obj: any) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      const chunk = (partial: any, finishReason: string | null) => ({
        id: chatId,
        object: 'chat.completion.chunk',
        created: Date.now(),
        model: 'mock-model',
        choices: [{ index: 0, delta: partial, finish_reason: finishReason }]
      });
      const finish = (content: string, finishReason = 'stop') => {
        if (wantsStream) {
          send(chunk({ role: 'assistant', content }, finishReason));
          send(chunk({}, finishReason));
          res.write('data: [DONE]\n\n');
          res.end();
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ id: chatId, object: 'chat.completion', created: Date.now(), model: 'mock-model', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: finishReason }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
        }
      };

      if (wantsStream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        if (finishToolCall) {
          // tool round: model replies after tool result
          send(chunk({ role: 'assistant', content: 'Tool round done.' }, null));
          send(chunk({}, 'stop'));
          res.write('data: [DONE]\n\n');
          res.end();
          log('mock server: tool-round response sent');
          return;
        }
        send(chunk({ role: 'assistant', content: 'Start' }, null));
        let sentToolCall = false;
        if (!toolCallSent) {
          toolCallSent = true;
          sentToolCall = true;
        if (mockScenario === 'read_file') {
          send(chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path": "package.json"}' } }] }, null));
        } else if (mockScenario === 'apply_diff') {
          const patch = [
            '--- a/e2e-diff-test.txt',
            '+++ b/e2e-diff-test.txt',
            '@@ -1,3 +1,3 @@',
            '-line1',
            '+line1-replaced',
            ' line2',
            ' line3'
          ].join('\n');
          send(chunk({ tool_calls: [{ index: 0, id: 'call_2', type: 'function', function: { name: 'apply_diff', arguments: JSON.stringify({ path: 'e2e-diff-test.txt', patch }) } }] }, null));
        } else if (mockScenario === 'write_file_confirm') {
          send(chunk({ tool_calls: [{ index: 0, id: 'call_3', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'e2e-confirm-test.txt', content: 'confirmed content\n' }) } }] }, null));
        } else if (mockScenario === 'delete_file_confirm') {
          send(chunk({ tool_calls: [{ index: 0, id: 'call_4', type: 'function', function: { name: 'delete_file', arguments: JSON.stringify({ path: 'e2e-confirm-test.txt' }) } }] }, null));
        } else if (mockScenario === 'mcp_echo') {
          send(chunk({ tool_calls: [{ index: 0, id: 'call_5', type: 'function', function: { name: 'mcp__e2e-mcp__echo', arguments: JSON.stringify({ text: 'hello from mcp' }) } }] }, null));
        } else if (mockScenario === 'subagents') {
          send(chunk({ tool_calls: [{ index: 0, id: 'call_6', type: 'function', function: { name: 'subagents', arguments: JSON.stringify({ agentName: 'E2E Researcher', prompt: 'research the repo' }) } }] }, null));
        } else if (mockScenario === 'read_cjk') {
          send(chunk({ tool_calls: [{ index: 0, id: 'call_7', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'src/app.txt' }) } }] }, null));
        }
        }
        send(chunk({}, 'tool_calls'));
        res.write('data: [DONE]\n\n');
        setTimeout(() => res.end(), 100);
        log('mock server: ' + (sentToolCall ? `tool call sent (${mockScenario})` : 'plain text reply (tool call already consumed)'));
      } else {
        finish('Hello (non-stream)');
      }
    });
  });

  // 监听端口 0：由系统分配空闲端口，避免固定随机区间（18999-19499）在并发/占用时
  // 撞端口导致 mock server 起不来（listen 回调触发后 address() 才有效）
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as { port: number } | null;
  const PORT = addr?.port ?? 0;
  if (!PORT) {
    throw new Error('failed to obtain ephemeral port for mock server');
  }
  log(`mock server on :${PORT}`);

  const capturedPreviews: any[] = [];
  const host = new BackendHost({
    userDataPath: userData,
    extensionPath: path.resolve(__dirname, '..', '..'),
    postToRenderer: () => undefined,
    native: async <T = any>() => undefined as T,
    onOpenDiffPreview: (payload) => capturedPreviews.push(payload)
  });

  const pending = new Map<string, PendingRequest>();
  let reqId = 0;

  const send = (type: string, data: any, timeoutMs = 30000): Promise<any> => {
    const id = 'e2e_' + ++reqId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`timeout waiting for ${type}`));
        }
      }, timeoutMs);
      void host.handleRendererMessage({ type, requestId: id, data });
    });
  };

  // Capture stream chunks
  const streamChunks: any[] = [];
  const allMessages: string[] = [];
  const realPost = (host as any).options.postToRenderer;
  (host as any).options.postToRenderer = (message: any) => {
    if (message.type === 'streamChunk') streamChunks.push(message.data);
    else if (message.type === 'streamChunkBatch') streamChunks.push(...message.data);
    else allMessages.push(message.type);
    if ((message.type === 'response' || message.type === 'error') && message.requestId && pending.has(message.requestId)) {
      const p = pending.get(message.requestId)!;
      pending.delete(message.requestId);
      if (message.type === 'response') p.resolve(message.data);
      else p.reject(new Error(`backend error: ${message.error?.code} ${message.error?.message}`));
      return;
    }
    realPost(message);
  };

  try {
    await host.ready;
    log('backend ready');

    // use the repo itself as workspace so file tools can run for real
    const repoRoot = path.resolve(__dirname, '..', '..');
    host.setWorkspaceFolders([repoRoot]);
    log('workspace set to repo root');

    // 1. create channel
    const configId = await send('config.createConfig', {
      id: 'e2e-mock-channel',
      type: 'openai',
      name: 'E2E Mock',
      url: `http://127.0.0.1:${PORT}/v1`,
      apiKey: 'mock-key',
      model: 'mock-model',
      options: { stream: true },
      preferStream: true,
      toolMode: 'function_call',
      timeout: 30000,
      enabled: true,
      maxRetries: 0
    });
    assert(typeof configId === 'string' && configId.length > 0, 'config.createConfig returns id');
    log("channel id: " + configId);

    const updateRes = await send('config.updateConfig', {
      configId,
      updates: { active: true, enabled: true }
    });
    assert(updateRes?.success === true, 'config.updateConfig ok');

    const waitForChunks = async (pred: (c: any) => boolean, timeoutMs = 30000): Promise<boolean> => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (streamChunks.some(pred)) return true;
        await new Promise((r) => setTimeout(r, 200));
      }
      return streamChunks.some(pred);
    };
    const resetCapture = () => {
      streamChunks.length = 0;
      allMessages.length = 0;
      toolCallSent = false;
    };

    // =====================================================================
    // Scenario A: basic streaming + tool call + history + settings
    // =====================================================================
    {
      resetCapture();
      mockScenario = 'read_file';
      const convId = 'e2e-conv-' + Date.now();
      const createRes = await send('conversation.createConversation', { conversationId: convId, title: 'E2E' });
      assert(createRes?.success === true, 'conversation.createConversation ok');

      const started = await send('chatStream', { conversationId: convId, message: 'Hello', configId, attachments: [], promptModeId: 'code' });
      assert(started?.started === true, 'chatStream started');

      const completed = await waitForChunks((c) => c.type === 'complete' || c.type === 'error' || c.type === 'cancelled');
      assert(completed, 'stream reached terminal chunk');

      const hasContent = streamChunks.some((c) => JSON.stringify(c.chunk || '').includes('Start') || JSON.stringify(c.content || '').includes('Tool round'));
      const hasToolStatus = streamChunks.some((c) => c.type === 'toolStatus');
      const hasComplete = streamChunks.some((c) => c.type === 'complete');
      const hasErrorChunk = streamChunks.some((c) => c.type === 'error');
      assert(hasContent, `stream delivered text chunks (${streamChunks.length} chunks)`);
      assert(hasToolStatus, 'stream delivered tool status');
      assert(hasComplete, 'stream completed');
      if (hasErrorChunk) {
        const errChunk = streamChunks.find((c) => c.type === 'error');
        log("ERROR CHUNK: " + JSON.stringify(errChunk).slice(0, 400));
      }

      const convs = await send('conversation.listConversations', {});
      assert(Array.isArray(convs) && convs.includes(convId), 'conversation persisted');
      const msgs = await send('conversation.getMessages', { conversationId: convId });
      assert(Array.isArray(msgs) && msgs.length >= 2, `history has messages (${Array.isArray(msgs) ? msgs.length : 0})`);
    }

    // =====================================================================
    // Scenario B: apply_diff -> diff preview -> accept -> file written
    // =====================================================================
    {
      resetCapture();
      mockScenario = 'apply_diff';
      const testFile = path.join(repoRoot, 'e2e-diff-test.txt');
      try {
      fs.writeFileSync(testFile, 'line1\nline2\nline3\n', 'utf-8');

      const convId = 'e2e-conv-diff-' + Date.now();
      await send('conversation.createConversation', { conversationId: convId, title: 'E2E Diff' });
      const started = await send('chatStream', { conversationId: convId, message: 'modify file', configId, attachments: [], promptModeId: 'code' });
      assert(started?.started === true, 'diff chatStream started');

      // wait for the tools to enter executing state (diff tools don't emit toolStatus before the diff is created)
      const toolsExecuting = await waitForChunks((c) => c.type === 'toolsExecuting' || (c.type === 'toolStatus' && c.tool?.name === 'apply_diff'), 30000);
      if (!toolsExecuting) {
        log('B: chunks so far: ' + JSON.stringify(streamChunks.map((c) => ({ type: c.type, tool: c.tool?.name, status: c.tool?.status }))).slice(0, 1200));
      }
      assert(toolsExecuting, 'apply_diff tool executing');

      // the frontend would call diff.openPreview; simulate it
      const openPreviewRes = await send('diff.openPreview', {
        toolId: 'call_2',
        toolName: 'apply_diff',
        filePaths: ['e2e-diff-test.txt'],
        args: { path: 'e2e-diff-test.txt', patch: ['--- a/e2e-diff-test.txt', '+++ b/e2e-diff-test.txt', '@@ -1,3 +1,3 @@', '-line1', '+line1-replaced', ' line2', ' line3'].join('\n') },
        result: { data: {} }
      });
      assert(openPreviewRes?.success === true, 'diff.openPreview ok');

      // backend should have fired the vscode.diff command -> onOpenDiffPreview
      const previews = capturedPreviews;
      assert(previews.length > 0, `vscode.diff fired (${previews.length} previews)`);
      if (previews.length > 0) {
        const p = previews[previews.length - 1];
        log('diff preview: file=' + p.filePath + ' session=' + p.sessionId + ' orig=' + p.originalContent.length + ' new=' + p.newContent.length);
        assert(p.sessionId.startsWith('diff-'), 'diff session id resolved to pending diff id');
        assert(p.originalContent.includes('line1') && p.newContent.includes('line1-replaced'), 'diff contents correct');

        // user accepts in the modal
        const acceptRes = await send('diff.accept', { sessionId: p.sessionId });
        assert(acceptRes?.success === true, 'diff.accept ok');
      }

      // tool round completes and stream finishes
      const completed = await waitForChunks((c) => c.type === 'complete' || c.type === 'error' || c.type === 'cancelled', 30000);
      assert(completed, 'diff stream completed');
      const written = fs.readFileSync(testFile, 'utf-8');
      assert(written.includes('line1-replaced'), 'accepted diff written to disk');
      log('file after accept: ' + JSON.stringify(written));
      } finally {
        fs.rmSync(testFile, { force: true });
      }
    }

    // =====================================================================
    // Scenario C: tool confirmation (delete_file needs chat confirmation)
    // =====================================================================
    {
      resetCapture();
      mockScenario = 'delete_file_confirm';
      const testFile = path.join(repoRoot, 'e2e-confirm-test.txt');
      try {
      fs.writeFileSync(testFile, 'to be deleted\n', 'utf-8');

      // delete_file requires manual confirmation (default)
      await send('updateSettings', {
        settings: { toolAutoExec: { delete_file: false } }
      });

      const convId = 'e2e-conv-confirm-' + Date.now();
      await send('conversation.createConversation', { conversationId: convId, title: 'E2E Confirm' });
      const started = await send('chatStream', { conversationId: convId, message: 'delete file', configId, attachments: [], promptModeId: 'code' });
      assert(started?.started === true, 'confirm chatStream started');

      const awaiting = await waitForChunks((c) => c.type === 'awaitingConfirmation', 30000);
      if (!awaiting) {
        log('C: chunks so far: ' + JSON.stringify(streamChunks.map((c) => ({ type: c.type, tool: c.tool?.name }))).slice(0, 1200));
      }
      assert(awaiting, 'stream paused for confirmation');
      const pendingTool = streamChunks.find((c) => c.type === 'awaitingConfirmation');
      log('pending tools: ' + JSON.stringify(pendingTool?.pendingToolCalls || []).slice(0, 200));

      // user approves in the dialog
      const toolResponses = (pendingTool?.pendingToolCalls || []).map((t: any) => ({
        id: t.id,
        name: t.name,
        confirmed: true
      }));
      assert(toolResponses.length > 0, 'confirmation dialog had pending tools');
      const confirmRes = await send('toolConfirmation', {
        conversationId: convId,
        configId,
        toolResponses,
        annotation: '',
        promptModeId: 'code'
      });
      assert(confirmRes?.started === true, 'toolConfirmation accepted');

      const completed = await waitForChunks((c) => c.type === 'complete' || c.type === 'error' || c.type === 'cancelled', 30000);
      assert(completed, 'confirm stream completed');
      const deleted = !fs.existsSync(testFile);
      assert(deleted, 'confirmed delete_file removed the file');
      } finally {
        fs.rmSync(testFile, { force: true });
      }
    }

    // =====================================================================
    // Scenario D: settings roundtrip + storage stats
    // =====================================================================
    {
      const settings = await send('getSettings', {});
      assert(!!settings?.settings, 'getSettings ok');

      const saved = await send('updateSettings', { settings: { ui: { language: 'en' } } });
      assert(saved?.success === true, 'updateSettings ok');
      const settings2 = await send('getSettings', {});
      assert(settings2?.settings?.ui?.language === 'en', 'settings persisted');

      const stats = await send('storagePath.getStats', {});
      assert(typeof stats?.stats?.totalSize === 'number', 'storagePath.getStats ok');
      log("settings roundtrip done, storage at " + host.getEffectiveDataPath());
    }

    // =====================================================================
    // Scenario E: MCP stdio server (create -> connect -> tool call in stream)
    // =====================================================================
    {
      resetCapture();
      // write the mock MCP server to a temp path without spaces (cmd quoting safety)
      const mockSrc = path.join(__dirname, '..', 'test', 'mock-mcp-server.cjs');
      const mockDst = path.join(app.getPath('temp'), 'graycode-e2e-mcp-' + Date.now() + '.cjs');
      fs.copyFileSync(mockSrc, mockDst);

      const createRes = await send('createMcpServer', {
        customId: 'e2e-mcp',
        input: {
          name: 'E2E MCP Mock',
          description: 'e2e stdio mock',
          transport: { type: 'stdio', command: 'node', args: [mockDst] },
          enabled: true,
          autoConnect: false,
          timeout: 20000
        }
      });
      assert(createRes?.serverId === 'e2e-mcp', 'createMcpServer returns server id');

      const connectRes = await send('connectMcpServer', { serverId: 'e2e-mcp' });
      assert(connectRes?.success === true, 'connectMcpServer ok');

      const serversRes = await send('getMcpServers', {});
      const server = (serversRes?.servers || []).find((s: any) => s.config?.id === 'e2e-mcp');
      assert(server?.status === 'connected', 'mcp server connected (status=' + server?.status + ')');
      const toolNames = server?.capabilities?.tools?.map((t: any) => t.name) || [];
      assert(toolNames.includes('echo') && toolNames.includes('add'), 'mcp tools discovered (' + toolNames.join(',') + ')');

      mockScenario = 'mcp_echo';
      const convId = 'e2e-conv-mcp-' + Date.now();
      await send('conversation.createConversation', { conversationId: convId, title: 'E2E MCP' });
      const started = await send('chatStream', { conversationId: convId, message: 'use mcp', configId, attachments: [], promptModeId: 'code' });
      assert(started?.started === true, 'mcp chatStream started');

      const completed = await waitForChunks((c) => c.type === 'complete' || c.type === 'error' || c.type === 'cancelled', 30000);
      assert(completed, 'mcp stream completed');
      const hasToolStatus = streamChunks.some((c) => c.type === 'toolStatus' && c.tool?.name === 'mcp__e2e-mcp__echo');
      assert(hasToolStatus, 'mcp tool status delivered');

      // the tool result must have been sent back to the model and stored in history
      const msgs = await send('conversation.getMessages', { conversationId: convId });
      const msgsArr = Array.isArray(msgs) ? msgs : [];
      const blob = JSON.stringify(msgsArr);
      const hasEcho = blob.includes('echo:hello from mcp');
      if (!hasEcho) {
        log('MCP history dump: ' + blob.slice(0, 1500));
      }
      assert(hasEcho, 'mcp tool result stored in history');
      const mcpToolStatuses = streamChunks.filter((c) => c.type === 'toolStatus' && c.tool?.name === 'mcp__e2e-mcp__echo');
      assert(mcpToolStatuses.some((c) => c.tool?.status === 'success'), 'mcp tool reported success');

      await send('disconnectMcpServer', { serverId: 'e2e-mcp' });
      fs.rmSync(mockDst, { force: true });
      log('MCP scenario done');
    }

    // =====================================================================
    // Scenario F: sub-agent (create -> list -> model invokes -> run completes)
    // =====================================================================
    {
      resetCapture();
      mockScenario = 'subagents';
      toolCallSent = false;

      const createAgent = await send('subagents.create', {
        type: 'e2e-researcher',
        name: 'E2E Researcher',
        description: 'Test researcher agent used by e2e',
        systemPrompt: 'You are a careful researcher. Investigate and answer.',
        channel: { channelId: configId },
        tools: { mode: 'all' },
        maxIterations: 3,
        enabled: true
      });
      assert(createAgent?.success === true, 'subagents.create ok');

      const listRes = await send('subagents.list', {});
      assert(
        (listRes?.agents || []).some((a: any) => a.type === 'e2e-researcher'),
        'subagents.list contains the agent'
      );

      const convId = 'e2e-conv-sub-' + Date.now();
      await send('conversation.createConversation', { conversationId: convId, title: 'E2E Sub' });
      const started = await send('chatStream', { conversationId: convId, message: 'research the repo', configId, attachments: [], promptModeId: 'code' });
      assert(started?.started === true, 'subagent chatStream started');

      const completed = await waitForChunks((c) => c.type === 'complete' || c.type === 'error' || c.type === 'cancelled', 60000);
      assert(completed, 'subagent stream completed');
      const subStatuses = streamChunks.filter((c) => c.type === 'toolStatus' && c.tool?.name === 'subagents');
      assert(subStatuses.length > 0, 'subagents tool status delivered');
      assert(subStatuses.some((c) => c.tool?.status === 'success'), 'subagents tool succeeded');
      if (subStatuses.some((c) => c.tool?.status === 'error')) {
        log('subagent error: ' + JSON.stringify(subStatuses.map((c) => c.tool?.result)).slice(0, 800));
      }

      // the sub-agent ran its own internal loop against the mock channel;
      // its response must have been folded back into the main conversation
      const msgs = await send('conversation.getMessages', { conversationId: convId });
      const blob = JSON.stringify(msgs);
      assert(blob.includes('Ok.') || blob.includes('Tool round done.'), 'subagent run content stored in history');

      await send('subagents.delete', { type: 'e2e-researcher' });
      const listAfter = await send('subagents.list', {});
      assert(!(listAfter?.agents || []).some((a: any) => a.type === 'e2e-researcher'), 'subagents.delete removed agent');
      log('subagent scenario done');
    }

    // =====================================================================
    // Scenario G: workspace folder with a CJK/space path (open-folder flow)
    // =====================================================================
    {
      resetCapture();
      const wsRoot = path.join(app.getPath('temp'), 'graycode-e2e-鲸鱼监控 project');
      const srcDir = path.join(wsRoot, 'src');
      fs.mkdirSync(srcDir, { recursive: true });
      fs.writeFileSync(path.join(srcDir, 'app.txt'), 'hello 中文 workspace\n', 'utf-8');

      host.setWorkspaceFolders([wsRoot]);

      const uri = await send('getWorkspaceUri', {});
      assert(
        typeof uri === 'string' && decodeURIComponent(uri).includes('鲸鱼监控'),
        'getWorkspaceUri round-trips CJK path (' + uri + ')'
      );

      const read = await send('readWorkspaceTextFile', { path: 'src/app.txt' });
      if (!(read?.success === true && read?.content === 'hello 中文 workspace\n')) {
        log('readWorkspaceTextFile response: ' + JSON.stringify(read).slice(0, 400));
      }
      assert(read?.success === true && read?.content === 'hello 中文 workspace\n', 'readWorkspaceTextFile works in CJK workspace');

      // the read_file tool must also resolve relative to the new workspace
      mockScenario = 'read_cjk';
      toolCallSent = false;
      const convId = 'e2e-conv-ws-' + Date.now();
      await send('conversation.createConversation', { conversationId: convId, title: 'E2E WS' });
      await send('chatStream', { conversationId: convId, message: 'read src/app.txt', configId, attachments: [], promptModeId: 'code' });
      const done = await waitForChunks((c) => c.type === 'complete' || c.type === 'error' || c.type === 'cancelled', 30000);
      assert(done, 'read_file stream completed in CJK workspace');
      const blob2 = JSON.stringify(streamChunks);
      assert(blob2.includes('hello 中文 workspace'), 'read_file returned the CJK workspace file content');

      fs.rmSync(wsRoot, { recursive: true, force: true });
      log('workspace scenario done');
    }
  } catch (err) {
    failures++;
    log('E2E ERROR: ' + (err as Error).message);
    console.error(err);
  } finally {
    server.close();
    await host.dispose();
    log(failures === 0 ? 'ALL TESTS PASSED' : `${failures} TEST(S) FAILED`);
    process.exit(failures === 0 ? 0 : 1);
  }
}
