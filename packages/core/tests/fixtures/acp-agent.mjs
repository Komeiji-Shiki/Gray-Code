import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { appendFile, readFile, unlink, writeFile } from 'node:fs/promises';
import { Readable, Writable } from 'node:stream';

const require = createRequire(new URL('../../../../apps/server/package.json', import.meta.url));
const { agent, ndJsonStream, PROTOCOL_VERSION, RequestError } = await import(pathToFileURL(require.resolve('@agentclientprotocol/sdk')).href);
const directory = process.env.ACP_FIXTURE_DIRECTORY;
const trace = (method, params) => appendFile(path.join(directory, 'trace.jsonl'), JSON.stringify({ method, params, pid: process.pid, cwd: process.cwd() }) + '\n');
const load = async id => JSON.parse(await readFile(path.join(directory, `${id}.json`), 'utf8'));
const save = state => writeFile(path.join(directory, `${state.sessionId}.json`), JSON.stringify(state));
const pending = new Map();
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jIh8AAAAASUVORK5CYII=';
const config = state => ({ configOptions: [
  { id: 'model', name: 'Model', type: 'select', currentValue: state.model, options: [{ value: 'one', name: 'One' }, { value: 'two', name: 'Two' }] },
  { id: 'thoughts', name: 'Thoughts', type: 'boolean', currentValue: state.thoughts },
], modes: { currentModeId: state.mode, availableModes: [{ id: 'default', name: 'Default' }, { id: 'plan', name: 'Plan' }] } });
const app = agent({ name: 'Controlled ACP fixture' })
  .onRequest('initialize', async ({ params }) => {
    await trace('initialize', params);
    return { protocolVersion: PROTOCOL_VERSION, agentInfo: { name: 'fixture', version: '1' },
      agentCapabilities: { loadSession: true, promptCapabilities: { image: true }, sessionCapabilities: { resume: {}, fork: {}, close: {} } } };
  })
  .onRequest('session/new', async ({ params }) => {
    await trace('session/new', params);
    if (process.env.ACP_FIXTURE_WAIT_NEW === '1') await new Promise(() => {});
    const state = { sessionId: randomUUID(), prompts: [], mode: 'default', model: 'one', thoughts: false };
    await save(state); return { sessionId: state.sessionId, ...config(state) };
  })
  .onRequest('session/resume', async ({ params, client }) => {
    await trace('session/resume', params);
    const failure = path.join(directory, 'fail-resume-once');
    if (existsSync(failure)) { await unlink(failure); throw new RequestError(-32000, 'Fixture refused session resume'); }
    const state = await load(params.sessionId);
    await client.notify('session/update', { sessionId: state.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'REPLAY MUST NOT BE APPENDED' } } });
    return config(state);
  })
  .onRequest('session/load', async ({ params }) => { await trace('session/load', params); return config(await load(params.sessionId)); })
  .onRequest('session/fork', async ({ params }) => {
    await trace('session/fork', params);
    const state = { ...await load(params.sessionId), sessionId: randomUUID() };
    await save(state); return { sessionId: state.sessionId, ...config(state) };
  })
  .onRequest('session/set_config_option', async ({ params }) => {
    await trace('session/set_config_option', params);
    const state = await load(params.sessionId); state[params.configId] = params.value;
    await save(state); return { configOptions: config(state).configOptions };
  })
  .onRequest('session/set_mode', async ({ params, client }) => {
    await trace('session/set_mode', params);
    const state = await load(params.sessionId); state.mode = params.modeId; await save(state);
    await client.notify('session/update', { sessionId: state.sessionId, update: { sessionUpdate: 'current_mode_update', currentModeId: state.mode } });
    return {};
  })
  .onRequest('session/close', async ({ params }) => { await trace('session/close', params); return {}; })
  .onNotification('session/cancel', async ({ params }) => { await trace('session/cancel', params); pending.get(params.sessionId)?.({ stopReason: 'cancelled' }); })
  .onRequest('session/prompt', async ({ params, client }) => {
    await trace('session/prompt', params);
    const state = await load(params.sessionId); state.prompts.push(params.prompt); await save(state);
    const text = params.prompt.find(block => block.type === 'text')?.text;
    if (text === 'crash') process.exit(23);
    if (text === 'wait') return new Promise(resolve => pending.set(params.sessionId, resolve));
    const update = value => client.notify('session/update', { sessionId: params.sessionId, update: value });
    if (text === 'permission') {
      for (const index of [1, 2]) {
        const result = await client.request('session/request_permission', { sessionId: params.sessionId,
          toolCall: { toolCallId: `edit-${index}`, title: `修改文件 ${index}`, rawInput: { path: `example-${index}.txt` } },
          options: [{ optionId: `yes-${index}`, name: '允许一次', kind: 'allow_once' }, { optionId: `no-${index}`, name: '拒绝一次', kind: 'reject_once' }] });
        await trace('permission.result', result);
      }
    }
    await update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '内部分析。' } });
    await update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '已处理：' } });
    await update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
    if (text === 'permission') await update({ sessionUpdate: 'agent_message_chunk', content: { type: 'image', mimeType: 'image/png', data: png } });
    return { stopReason: 'end_turn' };
  });
const connection = app.connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
await connection.closed;
