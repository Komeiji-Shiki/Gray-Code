// 用法：node scripts/smoke-browser.cjs。真实 Electron、网站及模型端点均使用本机隔离夹具。
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const root = path.resolve(__dirname, '..');

async function launch() {
  const output = path.join(root, '.tmp', `browser-smoke-${randomUUID().slice(0, 8)}`);
  await fs.mkdir(output, { recursive: true });
  await require('esbuild').build({
    stdin: { contents: 'export { DesktopBrowser } from "./apps/desktop/src/browser"; export { PlatformApplication } from "./apps/server/src/application";', resolveDir: root, loader: 'ts' },
    outfile: path.join(output, 'host.cjs'), bundle: true, platform: 'node', format: 'cjs', target: 'node22',
    external: ['electron', 'sharp', 'jsonc-parser', 'node-pty', 'better-sqlite3', 'discord.js', 'velopack', '@graycode/core', '@graycode/contracts', 'typescript', 'typescript-language-server'],
  });
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [__filename, output], { cwd: root, env, windowsHide: true, stdio: 'inherit' });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  console.log(`Browser smoke report: ${path.join(output, 'report.json')}`);
  process.exitCode = code ?? 1;
}

function fixtureHtml(origin, crossOrigin) {
  return `<!doctype html><meta charset="utf-8"><title>Research browser fixture</title>
  <style>body{background:#17191d;color:#ddd;font:16px sans-serif;margin:16px}a{color:#8ab4ff}nav{height:90px;overflow:auto}
  button,input,select{border:1px solid #777;border-radius:0;padding:8px;margin:4px}iframe{width:400px;height:170px}
  #menu{display:none}#hover:hover #menu{display:block}#covered{position:relative;width:240px;height:50px}#cover{position:absolute;inset:0;background:#444}
  #large{display:block;width:1800px;height:1000px}</style>
  <nav>${Array.from({ length: 310 }, (_, i) => `<a href="#nav-${i}">Navigation ${i}</a> `).join('')}</nav>
  <main><h1>Research catalog</h1>
  <form id="search"><label>Search papers<input name="query" type="search" aria-label="Search papers"></label><button>Search</button></form>
  <div id="results" role="status">Ready for query</div>
  <label>Discipline<select aria-label="Discipline"><option value="theory">Theory</option><option value="systems">Systems</option><option value="closed" disabled>Closed</option></select></label>
  <select aria-label="Topics" multiple><option value="a">Alpha</option><option value="b">Beta</option></select>
  <label><input type="checkbox" aria-label="Peer reviewed">Peer reviewed</label><p id="checkCount">Checkbox changes: 0</p>
  <input type="number" aria-label="Year" value="2020"><input type="date" aria-label="Published after">
  <div contenteditable="true" role="textbox" aria-label="Abstract notes">Old abstract</div>
  <div id="hover"><button aria-label="Analysis menu">Analysis menu</button><div id="menu"><button onclick="document.getElementById('results').textContent='Metrics opened'">Metrics</button></div></div>
  <div id="shadow"></div><div id="covered"><button aria-label="Covered control">Covered control</button><div id="cover">Overlay</div></div>
  <iframe title="Same origin" src="${origin}/frame"></iframe><iframe title="Cross origin" src="${crossOrigin}/frame"></iframe>
  ${'<section role="group">'.repeat(35)}<button aria-label="Deep component" onclick="this.textContent='Deep clicked'">Deep component</button>${'</section>'.repeat(35)}
  <a href="${origin}/paper">Read paper here</a><a target="_blank" href="${origin}/paper">Open paper tab</a>
  <button id="large" onclick="this.textContent='Large clicked'">Large surface</button></main>
  <script>
  let changed=0;
  document.querySelector('[aria-label="Peer reviewed"]').addEventListener('change',()=>{document.getElementById('checkCount').textContent='Checkbox changes: '+(++changed);});
  document.getElementById('search').addEventListener('submit',event=>{
    event.preventDefault();document.getElementById('results').textContent='Searching';
    setTimeout(()=>{document.getElementById('results').innerHTML='<h2>Results ready</h2><table><tr><th>Title</th><th>Year</th></tr><tr><td><a href="/paper">Quantum methods</a></td><td>2026</td></tr></table>';},450);
  });
  const shadow=document.getElementById('shadow').attachShadow({mode:'open'});
  shadow.innerHTML='<button aria-label="Shadow analysis">Shadow analysis</button>';
  shadow.querySelector('button').onclick=()=>{shadow.querySelector('button').textContent='Shadow clicked';};
  </script>`;
}

async function run(output) {
  const { app, BrowserWindow, nativeImage } = require('electron');
  app.setPath('userData', path.join(output, 'profile'));
  app.commandLine.appendSwitch('host-resolver-rules', 'MAP browser.fixture 127.0.0.1, MAP frame.fixture 127.0.0.1');
  app.commandLine.appendSwitch('no-proxy-server');
  app.commandLine.appendSwitch('site-per-process');
  app.on('window-all-closed', () => {});
  const checks = [];
  let browser, platform, parent, server, origin, crossOrigin, step = 0, modelTab, modelRef;
  const report = { checks };
  try {
    await app.whenReady();
    // 合成夹具没有可见工作台；使用真实 Chromium 离屏合成，避免 Windows 遮挡优化挂起 rAF。
    // 截图仍经正式 BrowserPage.capturePage 路径采集，不跳过像素和动作后的观察断言。
    parent = new BrowserWindow({ show: false, opacity: 0, focusable: false, skipTaskbar: true,
      webPreferences: { offscreen: true, backgroundThrottling: false } });
    server = createServer(async (request, response) => {
      try {
        if (request.url === '/model') {
          const chunks = []; for await (const chunk of request) chunks.push(chunk);
          const input = JSON.parse(Buffer.concat(chunks).toString());
          const last = input.messages.flatMap(message => message.parts).filter(part => part.functionResponse).at(-1)?.functionResponse?.response;
          if (step) assert.equal(last?.success, true, JSON.stringify(last));
          let call;
          if (step === 0) call = { name: 'browser_tabs', args: { action: 'create', url: origin } };
          if (step === 1) { modelTab = last.data.id; call = { name: 'browser_read', args: { action: 'snapshot', tabId: modelTab, query: 'Search papers', role: 'searchbox', compact: false } }; }
          if (step === 2) {
            modelRef = last.data.nodes[0].ref;
            call = { name: 'browser_action', args: { action: 'fill', tabId: modelTab, url: origin + '/', ref: modelRef, text: 'quantum methods', after: 'both', snapshotOptions: { compact: false, query: 'Search papers', role: 'searchbox' } } };
          }
          if (step === 3) {
            assert.equal(last.data.url, last.data.observation.url); assert.equal(last.data.url, last.data.snapshot.url);
            modelRef = last.data.snapshot.nodes[0].ref;
            assert.notEqual(modelRef, undefined);
            assert(input.messages.some(message => message.parts.some(part => part.inlineData)));
            call = { name: 'browser_action', args: { action: 'press', tabId: modelTab, url: last.data.url, ref: modelRef, key: 'Enter' } };
          }
          if (step === 4) call = { name: 'browser_read', args: { action: 'wait', tabId: modelTab, query: 'Results ready', timeoutMs: 4000 } };
          if (step === 5) assert.equal(last.data.conditionMet, true);
          const message = { role: 'model', parts: call ? [{ functionCall: { id: `model-${step}`, ...call } }] : [{ text: 'Research results confirmed.' }] };
          step++; response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(message)); return;
        }
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        if (request.url === '/frame') {
          response.end('<title>Embedded research</title><label>Frame field<input aria-label="Frame field"></label><button onclick="this.textContent=\'Frame clicked\'">Frame action</button>'
            + '<div role="region" aria-label="Frame scroll" style="height:60px;overflow:auto" onscroll="document.getElementById(\'state\').textContent=\'Frame scrolled\'">'
            + '<p>Scrollable row</p>'.repeat(30) + '</div><p id="state">Not scrolled</p>'); return;
        }
        if (request.url === '/paper') { response.end('<title>Quantum paper</title><h1>Quantum methods paper</h1>'); return; }
        response.end(fixtureHtml(origin, crossOrigin));
      } catch (error) { response.statusCode = 500; response.end(String(error.stack ?? error)); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    origin = `http://browser.fixture:${port}`; crossOrigin = `http://frame.fixture:${port}`;
    const { DesktopBrowser, PlatformApplication } = require(path.join(output, 'host.cjs'));
    platform = await PlatformApplication.open({ dataDirectory: path.join(output, 'data'),
      browser: application => (browser = new DesktopBrowser(application, () => parent, () => {})),
      models: { generate: async input => {
        const response = await fetch(`http://127.0.0.1:${port}/model`, { method: 'POST', body: JSON.stringify(input) });
        if (!response.ok) throw new Error(await response.text());
        return response.json();
      } },
    });
    const context = { actorId: 'owner', runId: 'native-browser-smoke', signal: new AbortController().signal,
      toolCallId: '', askUser: async () => {}, progress: () => {} };
    let sequence = 0;
    const tool = (name, args) => browser.tool(name, args, { ...context, toolCallId: `smoke-${++sequence}` });
    const created = await tool('browser_tabs', { action: 'create', url: origin });
    assert.equal(created.success, true); const tabId = created.data.id;
    const url = origin + '/';
    const read = args => tool('browser_read', { action: 'snapshot', tabId, compact: false, ...args });
    const find = async (query, role, extra = {}) => {
      const result = await read({ query, role, ...extra });
      assert.equal(result.success, true); assert.equal(result.data.total, 1, JSON.stringify(result.data));
      return result.data.nodes[0].ref;
    };
    const action = async args => {
      const result = await tool('browser_action', { tabId, url, ...args });
      assert.equal(result.success, true, JSON.stringify(result));
      assert.equal(result.data.status, 'completed');
      if (args.after === 'snapshot') { assert(result.data.snapshot, JSON.stringify(result)); assert.equal(result.attachments, undefined); }
      else { assert(result.data.observation, JSON.stringify(result)); assert.equal(result.data.url, result.data.observation.url); }
      if (args.after === 'both') { assert(result.data.snapshot, JSON.stringify(result)); assert.equal(result.data.url, result.data.snapshot.url); }
      return result;
    };
    const shot = await tool('browser_read', { action: 'screenshot', tabId });
    assert.equal(shot.success, true, JSON.stringify(shot));
    const first = await read({ maxNodes: 20 });
    assert.equal(first.data.nextOffset, 20); assert(first.data.total > 600);
    const second = await read({ maxNodes: 20, offset: first.data.nextOffset });
    assert.equal(second.data.offset, 20); assert.notEqual(second.data.nodes[0].name, first.data.nodes[0].name);
    await action({ action: 'hover', observationId: shot.data.id, x: 20, y: 20 });
    checks.push('pagination-and-screenshot-preservation');
    const deepRef = await find('Deep component', 'button'); assert(deepRef);
    const searchRef = await find('Search papers', 'searchbox');
    const filled = await action({ action: 'fill', ref: searchRef, text: 'first query', after: 'snapshot', snapshotOptions: { query: 'Search papers', role: 'searchbox', compact: false } });
    await action({ action: 'fill', ref: filled.data.snapshot.nodes[0].ref, text: '' });
    checks.push('snapshot-only-ref-chaining-without-extra-read');
    assert.equal((await read({ query: 'Search papers', role: 'searchbox' })).data.nodes[0].value ?? '', '');
    const submitted = await action({ action: 'type', ref: await find('Search papers', 'searchbox'), text: 'quantum methods' });
    await action({ action: 'press', observationId: submitted.data.observation.id, key: 'Enter' });
    const waited = await tool('browser_read', { action: 'wait', tabId, query: 'Results ready', timeoutMs: 4000 });
    assert.equal(waited.success, true, JSON.stringify(waited));
    const link = await read({ query: 'Quantum methods', role: 'link' }); assert.equal(link.data.nodes[0].url, origin + '/paper');
    checks.push('deep-components-empty-fill-type-and-async-results');
    await action({ action: 'select', ref: await find('Discipline', 'combobox'), labels: ['Systems'] });
    assert.equal((await read({ query: 'Discipline', role: 'combobox' })).data.nodes[0].value, 'Systems');
    await action({ action: 'select', ref: await find('Topics', 'listbox'), values: ['a', 'b'] });
    await action({ action: 'select', ref: await find('Topics', 'listbox'), values: [] });
    await action({ action: 'check', ref: await find('Peer reviewed', 'checkbox'), checked: true });
    await action({ action: 'check', ref: await find('Peer reviewed', 'checkbox'), checked: true });
    assert.equal((await read({ query: 'Peer reviewed', role: 'checkbox' })).data.nodes[0].checked, 'true');
    assert((await read({ query: 'Checkbox changes: 1' })).data.total > 0);
    await action({ action: 'fill', ref: await find('Year', 'spinbutton'), text: '2026' });
    await action({ action: 'fill', ref: await find('Published after', 'Date'), text: '2026-09-01' });
    await action({ action: 'fill', ref: await find('Abstract notes', 'textbox'), text: '' });
    checks.push('native-select-multiselect-checkbox-number-date-contenteditable');
    await action({ action: 'hover', ref: await find('Analysis menu', 'button') });
    await action({ action: 'click', ref: await find('Metrics', 'button') });
    await action({ action: 'click', ref: await find('Shadow analysis', 'button') });
    assert.equal((await read({ query: 'Shadow clicked' })).data.total > 0, true);
    checks.push('hover-menu-and-shadow-dom');
    const frames = (await read({ query: 'Frame field', role: 'textbox' })).data;
    assert.equal(frames.total, 2, JSON.stringify(frames)); assert.equal(frames.partial, false);
    const frameIds = frames.nodes.map(node => node.frameId);
    for (const frameId of frameIds) {
      await action({ action: 'fill', ref: await find('Frame field', 'textbox', { frameId }), text: 'embedded query' });
      await action({ action: 'click', ref: await find('Frame action', 'button', { frameId }) });
      assert((await read({ frameId, query: 'Frame clicked' })).data.total > 0);
      await action({ action: 'scroll', ref: await find('Frame scroll', 'region', { frameId }), direction: 'down', distance: 200 });
      const scrolled = await tool('browser_read', { action: 'wait', tabId, frameId, query: 'Frame scrolled', timeoutMs: 1000 });
      assert.equal(scrolled.success, true, JSON.stringify(scrolled));
    }
    checks.push('same-origin-and-cross-origin-frame-actions');
    const blocked = await tool('browser_action', { tabId, url, action: 'click', ref: await find('Covered control', 'button') });
    assert.equal(blocked.success, false); assert(blocked.error.includes('遮挡'), JSON.stringify(blocked));
    await action({ action: 'click', ref: await find('Large surface', 'button') });
    assert((await read({ query: 'Large clicked' })).data.total > 0);
    checks.push('overlay-rejection-and-partially-visible-large-element');
    const screenshot = await tool('browser_read', { action: 'screenshot', tabId });
    const image = nativeImage.createFromBuffer(Buffer.from(screenshot.attachments[0].data, 'base64'));
    assert(!image.isEmpty()); await fs.writeFile(path.join(output, 'browser.png'), image.toPNG());
    const navigated = await action({ action: 'click', ref: await find('Read paper here', 'link') });
    assert.equal(navigated.data.url, origin + '/paper'); assert.equal(navigated.data.title, 'Quantum paper');
    const back = await action({ action: 'back', url: navigated.data.url, after: 'both', snapshotOptions: { query: 'Search papers', role: 'searchbox' } });
    assert.equal(back.data.url, url); assert.equal(back.data.title, 'Research browser fixture');
    checks.push('click-and-back-refresh-url-title-and-observations');
    browser.finishRun(context.runId);
    const draft = await platform.product.draft();
    for (const name of ['browser_tabs', 'browser_read', 'browser_action']) await draft.settings.setToolAutoExec(name, true);
    await platform.product.save(draft);
    const conversation = await platform.createConversation('owner', 'Browser model fixture');
    const run = await platform.runtime.start({ actorId: 'owner', agentId: 'default', conversationId: conversation.id,
      requestKey: 'browser-model-smoke', message: { role: 'user', parts: [{ text: 'Find quantum methods in the research catalog.' }] } });
    const result = await platform.runtime.wait(run.id);
    assert.equal(result.status, 'completed', JSON.stringify(result)); assert.equal(step, 6);
    checks.push('synthetic-http-model-tool-loop-with-images');
    report.success = true; report.modelRequests = step;
  } catch (error) { report.success = false; report.error = error.stack ?? String(error); console.error(report.error); }
  finally {
    try { if (platform) await platform.close(); else browser?.close(); }
    catch (error) { report.success = false; report.cleanupError = String(error); }
    parent?.destroy();
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report)); app.exit(report.success ? 0 : 1);
  }
}

if (process.versions.electron) void run(process.argv[2]);
else void launch().catch(error => { console.error(error); process.exitCode = 1; });
