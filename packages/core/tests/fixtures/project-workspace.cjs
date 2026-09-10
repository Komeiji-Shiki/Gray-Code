const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createHash } = require('node:crypto');
const { PlatformApplication } = require('../../../../apps/server/dist/application.cjs');
const { ApplicationRouter } = require('../../../../apps/server/dist/router.cjs');

(async () => {
  const root = await fs.realpath(process.argv[2]);
  if (path.dirname(root) !== path.resolve('.tmp') || !path.basename(root).startsWith('platform-test-')) throw new Error('验证目录不属于本次临时数据');
  const source = path.join(root, 'legacy');
  const app = await PlatformApplication.open({ dataDirectory: path.join(root, 'new'), models: { generate: async () => { throw new Error('项目验证不得调用模型'); } } });
  const router = new ApplicationRouter(app); const client = { actorId: 'owner', clientId: 'project-workspace' };
  const ui = (type, data = {}) => router.call(client, 'ui.request', { type, data });
  const events = []; const stop = app.subscribe(event => events.push(event));
  try {
    const directory = path.join(root, 'Project'); await fs.mkdir(directory);
    const uri = pathToFileURL(directory).href;
    const oldUri = process.platform === 'win32' ? uri.replace(/^file:\/\/\/([a-z]):/i, (_, drive) => `file:///${drive.toLowerCase()}%3A`) : uri;
    const oldRoot = { id: 'ws_1111111111111111', name: 'Project', uri: oldUri };
    const bytes = Buffer.from('原检查点的内容\n');
    await fs.mkdir(path.join(source, 'checkpoints', 'cp', oldRoot.id), { recursive: true });
    await fs.writeFile(path.join(source, 'checkpoints', 'cp', oldRoot.id, 'example.txt'), bytes);
    await fs.writeFile(path.join(source, 'conversations', 'old.json'), JSON.stringify([{ role: 'user', parts: [{ text: '旧项目历史' }] }]));
    await fs.writeFile(path.join(source, 'conversations', 'old.meta.json'), JSON.stringify({ id: 'old', title: '旧项目', createdAt: 1, updatedAt: 1, workspaceUri: oldUri,
      custom: { checkpoints: [{ id: 'cp', workspaceRoots: [oldRoot], fileHashes: { [`${oldRoot.id}/example.txt`]: createHash('md5').update(bytes).digest('hex') } }] } }));
    const workspace = await router.call(client, 'workspaces.add', { directory, name: 'Project' });
    assert.deepEqual((await app.migration.importDirectory('owner', source)).issues, []);
    const navigation = await ui('conversation.navigation');
    assert.equal(navigation.items.find(item => item.id === 'old').workspaceId, workspace.id);
    await ui('ui.conversation.focus', { conversationId: 'old' });
    assert.equal((await app.storage.getConversation('old')).workspaceId, workspace.id);
    assert.equal(events.filter(event => event.type === 'ui.conversation.focused').at(-1).workspaceId, workspace.id);
    const checkpoint = await app.storage.getRecord('workspace-checkpoints', 'cp');
    assert.equal(checkpoint.workspaceId, workspace.id);
    const scoped = Object.keys(checkpoint.contentIds)[0];
    assert.equal(scoped, `${checkpoint.manifest.roots[0].id}/example.txt`);
    assert.deepEqual(Buffer.from(await app.storage.getRecord('workspace-checkpoint-content', checkpoint.contentIds[scoped])), bytes);
    const secondDirectory = path.join(root, 'another', 'Project'); await fs.mkdir(secondDirectory, { recursive: true });
    await app.storage.initializeConversation({ id: 'other', title: '同名不同目录', actorId: 'owner', createdAt: 2, updatedAt: 2, legacySource: source, workspaceUri: pathToFileURL(secondDirectory).href }, []);
    await ui('ui.conversation.focus', { conversationId: 'other' });
    const second = await app.storage.getConversation('other'); assert.notEqual(second.workspaceId, workspace.id); assert.ok(second.workspaceId);
    assert.equal(app.settings.snapshot().settings.workspaces.length, 2);
    const repeated = await router.call(client, 'workspaces.add', { directory: process.platform === 'win32' ? directory.toLowerCase() : directory, name: 'Project' });
    assert.equal(repeated.id, workspace.id);
    await app.storage.initializeConversation({ id: 'missing', title: '目录已移走', actorId: 'owner', createdAt: 3, updatedAt: 3, legacySource: source, workspaceUri: pathToFileURL(path.join(root, 'missing')).href }, [{ role: 'user', parts: [{ text: '历史仍可读取' }] }]);
    await ui('ui.conversation.focus', { conversationId: 'missing' });
    assert.equal(events.filter(event => event.type === 'ui.conversation.focused').at(-1).workspaceId, null);
    assert.ok(events.some(event => event.type === 'notification' && event.message.includes('无法访问')));
    assert.equal((await app.storage.readHistory('missing')).total, 1);
    assert.equal(app.settings.snapshot().settings.workspaces.length, 2);
    console.log('PROJECT_RESULT ' + JSON.stringify({ aliasMatched: true, focusedWorkspace: true, checkpointBound: true, separateProjects: true, missingPathReadable: true }));
  } finally { stop(); await app.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
