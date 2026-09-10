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
  const app = await PlatformApplication.open({ dataDirectory: path.join(root, 'new'), models: { generate: async () => { throw new Error('迁移验证不得调用模型'); } } });
  const router = new ApplicationRouter(app);
  const client = { actorId: 'owner', clientId: 'migration-progress' };
  const ui = (type, data = {}) => router.call(client, 'ui.request', { type, data });
  async function finished() {
    for (let count = 0; count < 200; count++) {
      const status = await ui('migration.status');
      if (!status.active) return status;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('迁移没有结束');
  }
  let release = () => {};
  try {
    const workspace = { id: 'ws_1111111111111111', name: '项目', uri: pathToFileURL(path.join(root, 'workspace')).href };
    const bytes = Buffer.from('需要逐字节保留的旧检查点\n');
    const checkpoints = ['first', 'second'].map(id => ({ id, conversationId: 'old', backupDir: id, workspaceRoots: [workspace],
      fileHashes: { [`${workspace.id}/file.txt`]: createHash('md5').update(bytes).digest('hex') } }));
    const history = path.join(source, 'conversations', 'old.json');
    await fs.writeFile(history, JSON.stringify([{ id: 'm0', role: 'user', parts: [{ text: '旧消息' }] }]));
    await fs.writeFile(path.join(source, 'conversations', 'old.meta.json'), JSON.stringify({ id: 'old', title: '迁移验证', createdAt: 1, updatedAt: 1, custom: { checkpoints } }));
    for (const checkpoint of checkpoints) {
      await fs.mkdir(path.join(source, 'checkpoints', checkpoint.id, workspace.id), { recursive: true });
      await fs.writeFile(path.join(source, 'checkpoints', checkpoint.id, workspace.id, 'file.txt'), bytes);
    }
    const sourceBefore = await fs.readFile(history);
    const original = app.storage.getVersionedRecord.bind(app.storage);
    let enter; const writing = new Promise(resolve => enter = resolve); const gate = new Promise(resolve => release = resolve);
    app.storage.getVersionedRecord = async (namespace, id) => {
      if (namespace === 'workspace-checkpoint-content' && id.startsWith('second-')) { enter(); await gate; }
      return original(namespace, id);
    };
    const started = await ui('migration.start', { source });
    assert.equal(started.active, true); await writing;
    // 停在写入处读取同客户端设置，旧版长请求队列会在这里无法返回。
    assert.ok(await ui('platform.settings.get'));
    assert.equal((await ui('migration.status')).progress.phase, 'artifacts');
    assert.ok(await app.storage.getRecord('workspace-checkpoints', 'first'));
    await ui('migration.cancel'); release();
    assert.equal((await finished()).state, 'cancelled');
    assert.equal(await app.storage.getRecord('workspace-checkpoints', 'second'), null);
    app.storage.getVersionedRecord = original;
    await ui('migration.start', { source }); const done = await finished();
    assert.equal(done.state, 'completed');
    const report = await ui('migration.report', { operationId: done.operationId });
    assert.deepEqual(report.issues, []); assert.deepEqual(report.skipped, ['old']); assert.equal(report.readyForCutover, true);
    const restoredMetadata = await app.storage.getConversation('old');
    assert.equal(restoredMetadata.actorId, 'owner'); assert.equal(restoredMetadata.legacySource, source);
    assert.deepEqual((await ui('migration.workspaceRoots', { conversationId: 'old' })).roots, [workspace]);
    const checkpoint = await app.storage.getRecord('workspace-checkpoints', 'second');
    assert.deepEqual(Buffer.from(await app.storage.getRecord('workspace-checkpoint-content', checkpoint.contentIds[`${workspace.id}/file.txt`])), bytes);
    assert.deepEqual(await fs.readFile(history), sourceBefore);
    await ui('migration.start', { source: path.join(root, 'missing') }); const failure = await finished();
    assert.equal(failure.state, 'failed'); assert.ok(failure.error); assert.deepEqual(await ui('migration.status'), failure);
    console.log('MIGRATION_RESULT ' + JSON.stringify({ settingsResponsive: true, cancelled: true, resumed: true, failureVisible: true, sourceUnchanged: true }));
  } finally { release(); await app.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
