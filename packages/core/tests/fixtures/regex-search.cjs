const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { PlatformApplication } = require('../../../../apps/server/dist/application.cjs');
const { ApplicationRouter } = require('../../../../apps/server/dist/router.cjs');

(async () => {
  const root = await fs.realpath(process.argv[2]);
  if (path.dirname(root) !== path.resolve('.tmp') || !path.basename(root).startsWith('platform-test-')) throw new Error('验证目录不属于本次临时数据');
  const directory = path.join(root, 'legacy'), slow = 'a'.repeat(24000);
  await fs.writeFile(path.join(directory, 'slow.txt'), slow);
  await fs.writeFile(path.join(directory, 'safe.txt'), 'needle 12\nneedle 34');
  const app = await PlatformApplication.open({ dataDirectory: path.join(root, 'new'), models: { generate: async () => { throw new Error('正则验证不得调用模型'); } } });
  const router = new ApplicationRouter(app), client = { actorId: 'owner', clientId: 'regex-fixture' };
  const rpc = (method, params) => router.call(client, method, { workspaceId: 'regex', ...params });
  try {
    const snapshot = app.settings.snapshot();
    snapshot.settings.workspaces.push({ id: 'regex', name: 'fixture', directory, deviceId: 'local' });
    await app.settings.save({ settings: snapshot.settings, expectedRevision: snapshot.revision });
    const normal = await rpc('files.search', { requestId: 'normal', options: { query: 'needle (\\d+)', regex: true, include: 'safe.txt' } });
    assert.equal(normal.count, 2);
    const edits = await rpc('files.replacePreview', { options: { query: 'needle (\\d+)', regex: true }, replacement: '$1', files: normal.files });
    assert.equal(edits[0].after, '12\n34');
    const search = assert.rejects(rpc('files.search', { requestId: 'slow', options: { query: 'a+a+a+a+b', regex: true, include: 'slow.txt' } }), /搜索已取消/);
    // 父测试另有进程级期限，即使回归成同步阻塞也不会挂住整个测试运行器。
    const cancel = setTimeout(() => app.workspaceSearch.cancel(client, 'slow'), 150);
    try { await search; } finally { clearTimeout(cancel); }
    const tool = app.tools.catalog(['search_in_files']).entries.get('search_in_files').tool;
    for (const mode of ['search', 'replace']) {
      const controller = new AbortController();
      const pending = tool.execute({ mode, query: 'a+a+a+a+b', isRegex: true, pattern: 'slow.txt', ...(mode === 'replace' ? { replace: 'done' } : {}) },
        { actorId: 'owner', runId: 'regex-fixture', workspace: snapshot.settings.workspaces.find(value => value.id === 'regex'),
          signal: controller.signal, progress() {}, askUser: async () => { throw new Error('不应询问'); } });
      const timer = setTimeout(() => controller.abort(new Error('fixture tool cancelled')), 150);
      try {
        const result = await pending;
        assert.equal(result.success, false);
        assert.match(result.error, /cancelled/);
      } finally { clearTimeout(timer); }
    }
    const replacement = assert.rejects(rpc('files.replacePreview', { options: { query: 'a+a+a+a+b', regex: true },
      replacement: 'done', files: [{ path: 'slow.txt', hash: createHash('sha256').update(slow).digest('hex') }] }), /退出/);
    const stop = setTimeout(() => { void app.workspaceSearch.close(); }, 150);
    try { await replacement; } finally { clearTimeout(stop); }
    assert.equal(await fs.readFile(path.join(directory, 'slow.txt'), 'utf8'), slow);
    console.log('REGEX_RESULT ' + JSON.stringify({ searchCancelled: true, toolsCancelled: true, replaceStopped: true, diskUnchanged: true }));
  } finally { await app.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
