// Run with: electron scripts/smoke-desktop.cjs. All data and screenshots stay in .tmp.
const { app, BrowserWindow, dialog, webContents, nativeImage } = require('electron');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const { createServer } = require('node:http');
const { randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const output = path.join(root, '.tmp', `desktop-smoke-${randomUUID().slice(0, 8)}`);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const errors = [];
const paintedFrames = new Map();
let requests = 0;
let server;
async function until(check, label, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await check(); if (result) return result; await sleep(100); }
  throw new Error(`Timed out: ${label}`);
}
async function verifyShutdownRetry(rpc, window) {
  if (process.platform !== 'win32') return false;
  const originalQuit = app.quit.bind(app), originalError = dialog.showErrorBox, originalQuestion = dialog.showMessageBox;
  const childProcesses = require('node:child_process'), originalExecFile = childProcesses.execFile;
  const systemRoot = process.env.SystemRoot;
  let quitRequested = false, prematureExit = false, failed = '', completed = false, questions = 0, exitDuringStop = false, probe;
  const holdExit = event => { event.preventDefault(); prematureExit = true; };
  try {
    // 只创建本夹具的有界进程；异常中断夹具时它也会自行结束，不留下常驻后台程序。
    probe = await rpc('processes.start', { workspaceId: 'smoke', command: 'node.exe',
      args: ['-e', 'console.log("shutdown-probe:" + process.pid); setTimeout(() => {}, 30000)'] });
    const identity = /shutdown-probe:(\d+)/.exec(probe.output); assert(identity);
    const pid = Number(identity[1]); assert(pid > 0);
    app.on('will-quit', holdExit);
    // 发起真实 before-quit；截住成功清理后的最终退出，先验证自己持有的进程已经消失。
    app.quit = () => { quitRequested = true; };
    dialog.showMessageBox = async () => { questions++; return { response: 1, checkboxChecked: false }; };
    dialog.showErrorBox = (_title, message) => { failed = message; };
    childProcesses.execFile = (file, args, ...options) => {
      // 真实停止命令发出时再请求一次退出，验证清理期间也会拦截原生退出。
      if (!exitDuringStop && path.basename(file) === 'taskkill.exe' && args[1] === String(pid)) {
        exitDuringStop = true; originalQuit();
      }
      return originalExecFile(file, args, ...options);
    };
    process.env.SystemRoot = path.join(output, 'missing-system-root');
    originalQuit();
    originalQuit();
    await until(() => failed || prematureExit, 'shutdown failure reported');
    assert(exitDuringStop); assert(!prematureExit); assert(!quitRequested); assert(!window.isDestroyed());
    assert.equal(questions, 1); assert(failed.includes('受管进程关闭失败'));
    assert.doesNotThrow(() => process.kill(pid, 0));
    if (systemRoot === undefined) delete process.env.SystemRoot; else process.env.SystemRoot = systemRoot;
    originalQuit();
    await until(() => quitRequested || prematureExit, 'shutdown retry completed');
    assert(quitRequested && !prematureExit);
    assert.equal(questions, 1);
    assert.throws(() => process.kill(pid, 0));
    completed = true;
    return true;
  } finally {
    if (systemRoot === undefined) delete process.env.SystemRoot; else process.env.SystemRoot = systemRoot;
    app.quit = originalQuit; dialog.showErrorBox = originalError; dialog.showMessageBox = originalQuestion;
    childProcesses.execFile = originalExecFile;
    app.removeListener('will-quit', holdExit);
    if (!completed && probe && !window.isDestroyed()) await rpc('processes.stop', { id: probe.id })
      .catch(error => { errors.push(`Shutdown fixture cleanup: ${String(error)}`); });
  }
}
async function verifyRegexCancellation(rpc) {
  const file = path.join(output, 'project', 'regex-worker.txt'), text = 'a'.repeat(24000);
  await fs.writeFile(file, text);
  const pending = assert.rejects(rpc('files.search', { workspaceId: 'smoke', requestId: 'regex-cancel',
    options: { query: 'a+a+a+a+b', regex: true, include: 'regex-worker.txt' } }), /搜索已取消/);
  await sleep(150);
  await rpc('files.searchCancel', { requestId: 'regex-cancel' });
  await pending;
  const result = await rpc('files.search', { workspaceId: 'smoke', requestId: 'regex-next',
    options: { query: '^(a+)$', regex: true, include: 'regex-worker.txt' } });
  assert.equal(result.count, 1);
  assert.equal(result.files[0].matches[0].range.end.character, text.length);
  const edits = await rpc('files.replacePreview', { workspaceId: 'smoke', options: { query: '^(a+)$', regex: true },
    replacement: '$1', files: result.files });
  assert.deepEqual(edits, []);
  assert.equal(await fs.readFile(file, 'utf8'), text);
}
async function main() {
  fsSync.mkdirSync(path.join(output, 'project'), { recursive: true });
  fsSync.mkdirSync(path.join(output, 'profile'), { recursive: true });
  fsSync.mkdirSync(path.join(output, 'app-data'), { recursive: true });
  fsSync.mkdirSync(path.join(output, 'documents'), { recursive: true });
  fsSync.writeFileSync(path.join(output, 'project', 'hello.ts'), 'export const message: string = "Hello GrayCode";\n');
  fsSync.writeFileSync(path.join(output, 'project', 'index.html'), '<!doctype html><title>Preview verified</title><h1>GrayCode preview</h1>');
  app.setPath('userData', path.join(output, 'profile'));
  // 旧设置自动迁移和普通对话工作区也必须使用夹具目录，避免读取本机账号配置。
  app.setPath('appData', path.join(output, 'app-data'));
  app.setPath('documents', path.join(output, 'documents'));
  process.env.GRAYCODE_DESKTOP_SMOKE = '1';
  process.argv.push('--data', path.join(output, 'data'));
  dialog.showErrorBox = (title, message) => { process.stderr.write(`${title}: ${message}\n`); app.exit(1); };
  app.on('browser-window-created', (_event, window) => {
    window.webContents.on('paint', (_event, _rect, image) => paintedFrames.set(window.webContents.id, image.toPNG()));
    window.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
    window.webContents.on('render-process-gone', (_event, details) => errors.push(`Renderer exited: ${details.reason}`));
  });
  require(path.join(root, 'apps/desktop/dist/main.cjs'));
  server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks)); requests++;
    const answerReceived = body.messages.some(message => typeof message.content === 'string' && message.content.includes('Answer to optional question'));
    const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
    const completed = body.messages.filter(message => message.role === 'tool').length;
    let tool;
    if (!completed) tool = call('smoke-write', 'workspace_files', { action: 'write', path: 'generated.txt', content: 'Desktop model/tool integration verified.', expectedHash: null });
    else if (completed === 1) tool = call('smoke-question', 'ask_user', { questions: [{ title: '选择验证结果标签', options: ['已验证', '继续检查'] }] });
    else if (answerReceived && completed === 2) tool = call('smoke-command', 'run_command', { command: 'powershell.exe', args: ['-NoProfile', '-Command', 'Remove-Item -LiteralPath generated.txt'] });
    const message = tool ? { role: 'assistant', content: null, tool_calls: [tool] } : { role: 'assistant', content: answerReceived ? '文件已生成，已收到回答，高危命令已按选择拒绝。' : '文件已经完成；可以补充验证标签。' };
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message, finish_reason: tool ? 'tool_calls' : 'stop' }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const window = await until(() => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().startsWith('graycode://app/index')), 'main window');
  const evaluate = source => window.webContents.executeJavaScript(source, true);
  const rpc = (method, params = {}) => evaluate(`window.graycode.call(${JSON.stringify(method)}, ${JSON.stringify(params)})`);
  const ui = (type, data = {}) => rpc('ui.request', { type, data });
  const chat = source => {
    const frame = window.webContents.mainFrame.frames.find(frame => frame.url.includes('/chat/platform.html'));
    return frame ? frame.executeJavaScript('{' + source + '\n}', true) : Promise.resolve(false);
  };
  await until(() => evaluate('!!document.querySelector(".desktop-workspace")'), 'application ready');
  await until(() => chat('!!document.querySelector(".input-editor")'), 'original input area');
  await ui('ui.settings.begin');
  const settings = await ui('platform.settings.get');
  settings.workspaces.push({ id: 'smoke', name: '桌面验证项目', directory: path.join(output, 'project'), deviceId: 'local' });
  await ui('platform.settings.update', { settings });
  const configId = await ui('config.createConfig', { name: '本地验证模型', type: 'openai' });
  await ui('config.updateConfig', { configId, updates: { url: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'smoke-only', model: 'smoke-model',
    models: [{ id: 'smoke-model', name: 'smoke-model' }], preferStream: false, timeout: 10000 } });
  await ui('settings.setActiveChannelId', { channelId: configId });
  const saved = await ui('ui.settings.save');
  assert(!JSON.stringify(saved).includes('smoke-only'));
  await ui('ui.settings.end');
  window.webContents.reload();
  await until(() => evaluate('!!document.querySelector(".desktop-workspace") && document.body.innerText.includes("桌面验证项目")'), 'configured application');
  await until(() => chat('!!document.querySelector(".input-editor") && document.body.innerText.includes("smoke-model")'), 'configured original input');
  await until(() => evaluate('Array.from(document.querySelectorAll(".navigation-project-select")).some(node => node.textContent.includes("桌面验证项目"))'), 'project navigation');
  await evaluate('Array.from(document.querySelectorAll(".navigation-project-select")).find(node => node.textContent.includes("桌面验证项目")).click()');
  // 选择项目只切换工作台；通过项目新建按钮明确建立绑定该工作区的代码任务。
  await evaluate('window.__smokeProjectFocused = false; window.graycode.subscribe(event => { if (event.type === "ui.conversation.focused" && event.workspaceId === "smoke" && event.conversationId) window.__smokeProjectFocused = true; }); undefined');
  await evaluate('Array.from(document.querySelectorAll(".navigation-project-select")).find(node => node.textContent.includes("桌面验证项目")).closest(".navigation-group-heading").querySelector(".navigation-project-add").click()');
  await until(() => evaluate('window.__smokeProjectFocused'), 'project conversation focused');
  await until(() => evaluate('Array.from(document.querySelectorAll(".tree-row")).some(node => node.textContent.includes("hello.ts"))'), 'workspace file tree');
  await evaluate('Array.from(document.querySelectorAll(".tree-row")).find(node=>node.textContent.includes("hello.ts")).click()');
  await until(() => evaluate('!!document.querySelector(".monaco-editor")'), 'Monaco editor');
  const terminal = await rpc('terminal.create', { workspaceId: 'smoke' });
  await evaluate(`window.__smokeTerminalOutput = ''; window.graycode.subscribe(event => { if(event.type==='terminal.data' && event.id===${JSON.stringify(terminal.id)}) window.__smokeTerminalOutput += event.data; }); undefined`);
  await rpc('terminal.input', { id: terminal.id, data: "Write-Output ('native-' + 'terminal-ok')\r" });
  await until(() => evaluate('window.__smokeTerminalOutput.includes("native-terminal-ok")'), 'native terminal output');
  await rpc('terminal.stop', { id: terminal.id });
  await chat('const editor=document.querySelector(".input-editor"); editor.focus(); editor.textContent="创建验证文件并询问标签。"; editor.dispatchEvent(new InputEvent("input",{bubbles:true,inputType:"insertText",data:editor.textContent}));');
  await chat('document.querySelector(".send-button").click()');
  const question = await until(async () => (await rpc('questions.list'))[0], 'async question');
  await until(() => chat('!!document.querySelector(".async-question input")'), 'question input');
  await chat('const field=document.querySelector(".async-question input"); field.value="已验证"; field.dispatchEvent(new Event("input",{bubbles:true}));');
  await chat('document.querySelector(".async-question button").click()');
  const approval = await until(async () => (await rpc('approvals.list'))[0], 'operation approval');
  // 通过真实工具卡提交审批，才能覆盖审批身份在 parts 与界面投影之间的传递。
  await until(() => chat('!!document.querySelector(".reject-btn:not([disabled])")'), 'tool-card reject button');
  await chat('document.querySelector(".reject-btn:not([disabled])").click()');
  await until(async () => !(await rpc('approvals.list')).some(value => value.id === approval.id), 'UI approval acknowledgement');
  await until(async () => (await rpc('runs.list'))[0]?.status === 'completed', 'task completed');
  await until(() => chat('document.body.innerText.includes("文件已生成，已收到回答，高危命令已按选择拒绝。")'), 'final reply rendered after external approval');
  assert.equal(await fs.readFile(path.join(output, 'project', 'generated.txt'), 'utf8'), 'Desktop model/tool integration verified.');
  const conversationId = (await rpc('runs.list'))[0].conversationId;
  const beforeReroll = await rpc('conversations.history', { id: conversationId });
  const oldReplyId = beforeReroll.messages.at(-1).id;
  const requestsBeforeReroll = requests;
  await chat('Array.from(document.querySelectorAll(".message-actions .codicon-refresh")).at(-1).closest("button").click()');
  await until(() => chat('!!document.querySelector(".dialog-btn.confirm")'), 'reroll confirmation dialog');
  await chat('document.querySelector(".dialog-btn.confirm").click()');
  // 可选问题的交付时机会影响前一轮请求数；重生成本身必须恰好新增一次模型调用。
  await until(async () => requests === requestsBeforeReroll + 1 && (await rpc('runs.list'))[0]?.status === 'completed', 'reroll from original UI');
  await until(() => chat('Array.from(document.querySelectorAll(".branch-switcher-position-text")).some(node => node.textContent.replace(/\\s/g, "") === "2/2")'), 'branch candidate switcher');
  const rerolled = await rpc('conversations.history', { id: conversationId });
  assert.notEqual(rerolled.messages.at(-1).id, oldReplyId);
  assert.equal(rerolled.messages.filter(message => message.isFunctionResponse).length, beforeReroll.messages.filter(message => message.isFunctionResponse).length);
  await chat('Array.from(document.querySelectorAll(".branch-switcher-bar .codicon-chevron-left")).at(-1).closest("button").click()');
  await until(() => chat('!!document.querySelector("[role=dialog] .dialog-btn.confirm")'), 'branch workspace confirmation');
  await chat('document.querySelector("[role=dialog] .dialog-btn.confirm").click()');
  await until(async () => (await rpc('conversations.history', { id: conversationId })).messages.at(-1)?.id === oldReplyId, 'switch original candidate');
  await until(() => chat('Array.from(document.querySelectorAll(".branch-switcher-position-text")).some(node => node.textContent.replace(/\\s/g, "") === "1/2")'), 'original candidate rendered');
  await sleep(300);
  await fs.writeFile(path.join(output, 'workbench.png'), await until(() => paintedFrames.get(window.webContents.id), 'workbench frame'));
  await rpc('ui.command', { command: 'showSettings' });
  await until(() => chat('!!document.querySelector(".settings-panel")'), 'settings panel');
  assert((await chat('document.querySelectorAll(".settings-sidebar .settings-tab").length')) >= 20);
  await chat('Array.from(document.querySelectorAll(".settings-tab")).find(node=>node.textContent.trim()==="外观").click()');
  const fonts = await rpc('desktop.fonts');
  assert(fonts.length > 0);
  await until(() => chat('document.querySelector("select[aria-label=界面字体]")?.options.length > 10'), 'system font dropdown');
  const selectedFont = JSON.stringify(fonts.includes('Consolas') ? 'Consolas' : fonts[0]);
  const revisionBefore = (await rpc('settings.get')).revision;
  await chat('const field=document.querySelector(".appearance-settings input.text-input"); field.value="正在认真处理…"; field.dispatchEvent(new Event("input",{bubbles:true}));');
  await chat('const select=document.querySelector("select[aria-label=界面字体]"); select.value=' + JSON.stringify(selectedFont) + '; select.dispatchEvent(new Event("change",{bubbles:true}));');
  await chat('Array.from(document.querySelectorAll(".settings-tab")).find(node=>node.textContent.trim()==="Discord Bot").click()');
  await until(() => chat('!!document.querySelector(".discord-settings .discord-header") && document.body.innerText.includes("Discord Bot")'), 'Discord settings');
  await chat('Array.from(document.querySelectorAll(".settings-tab")).find(node=>node.textContent.includes("MCP")).click()');
  await until(() => chat('!!document.querySelector(".mcp-toolbar .codicon-json")'), 'MCP settings');
  await chat('document.querySelector(".mcp-toolbar .codicon-json").closest("button").click()');
  await until(() => chat('!!document.querySelector(".mcp-json-editor textarea:not([disabled])")'), 'MCP JSON editor');
  const mcpJson = JSON.stringify({ mcpServers: { native: { name: '原生 MCP 验证', type: 'streamable-http', url: 'http://127.0.0.1:1/mcp', autoConnect: false, headers: { Authorization: 'native-mcp-fixture' } } } }, null, 2);
  await chat('const field=document.querySelector(".mcp-json-editor textarea"); field.value=' + JSON.stringify(mcpJson) + '; field.dispatchEvent(new Event("input",{bubbles:true}));');
  assert.equal((await rpc('settings.get')).revision, revisionBefore);
  await chat('Array.from(document.querySelectorAll(".settings-tab")).find(node=>node.textContent.trim()==="外观").click()');
  await until(() => chat('document.querySelector(".appearance-settings input.text-input")?.value === "正在认真处理…"'), 'cross-section draft retained');
  await chat('document.querySelector(".platform-settings-footer button.primary").click()');
  await until(async () => (await rpc('settings.get')).revision > revisionBefore, 'save all settings');
  assert.equal((await rpc('settings.get')).settings.appearance.uiFont, selectedFont);
  assert.equal((await ui('getSettings')).settings.ui.appearance.loadingText, '正在认真处理…');
  assert.equal((await ui('getMcpServers')).servers[0].config.name, '原生 MCP 验证');
  // 导入图片在草稿中即可预览；撤销不留资源，保存后改用实际持久化的图片地址。
  const backgroundId = randomUUID();
  const backgroundUrl = `graycode://app/assets/background/${backgroundId}`;
  const backgroundData = nativeImage.createFromBitmap(Buffer.from([40, 50, 60, 255]), { width: 1, height: 1 }).toDataURL();
  const importBackground = async () => ui('settings.importData', { value: { format: 'graycode-platform', version: 1,
    settings: { appearance: { ...(await rpc('settings.get')).settings.appearance, backgroundImage: backgroundUrl } },
    backgrounds: [{ id: backgroundId, url: backgroundUrl, name: '导入背景验证', dataUrl: backgroundData, thumbnail: backgroundData, width: 1, height: 1 }] } });
  const imageLoads = url => evaluate(`new Promise(resolve => { const picture = new Image(); picture.onload = () => resolve(picture.naturalWidth === 1); picture.onerror = () => resolve(false); picture.src = ${JSON.stringify(url)}; })`);
  await importBackground();
  const stagedBackground = (await ui('appearance.images.list')).find(image => image.name === '导入背景验证');
  assert(stagedBackground.url.startsWith('data:image/'));
  assert(await imageLoads(stagedBackground.url));
  await ui('ui.settings.discard');
  assert(!(await ui('appearance.images.list')).some(image => image.name === '导入背景验证'));
  await importBackground(); await ui('ui.settings.save');
  const savedBackground = (await rpc('settings.get')).settings.appearance.backgroundImage;
  assert(savedBackground.startsWith('graycode://app/assets/background/'));
  assert(await imageLoads(savedBackground));
  await sleep(150);
  await fs.writeFile(path.join(output, 'settings.png'), paintedFrames.get(window.webContents.id));
  await rpc('browser.openFile', { workspaceId: 'smoke', path: 'index.html' });
  // 页面也可能挂在后台 BaseWindow 上，按真实 WebContents 查找，不依赖可见窗口层级。
  const preview = await until(() => webContents.getAllWebContents().find(contents => contents.getURL().startsWith('graycode-preview://')), 'embedded browser');
  await until(() => preview.getTitle() === 'Preview verified', 'local HTML preview');
  assert.equal(await preview.executeJavaScript('document.querySelector("h1").textContent'), 'GrayCode preview');
  await verifyRegexCancellation(rpc);
  const shutdownRetryVerified = await verifyShutdownRetry(rpc, window);
  const report = { ok: true, electron: process.versions.electron, node: process.versions.node, requests, regexSearchVerified: true,
    verified: ['SQLite worker', 'encrypted settings', 'Monaco', 'native PTY', 'HTTP model/tool loop', 'async question', 'approval denial', 'HTML preview', 'original tabs and input', '20 settings sections', 'system fonts', 'shared settings draft', 'MCP JSON draft and encrypted configuration', 'original UI reroll and branch switching', 'background import preview, discard and atomic save', ...(shutdownRetryVerified ? ['shutdown failure and retry with owned process'] : [])], fontCount: fonts.length, errors, output };
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  process.stdout.write(`${JSON.stringify(report)}\n`);
  server.closeAllConnections(); server.close();
  app.quit();
}
main().catch(async error => {
  process.stderr.write(`${error?.stack ?? String(error)}\n`);
  await fs.writeFile(path.join(output, 'failure.json'), JSON.stringify({ error: error?.stack ?? String(error), requests, errors })).catch(() => {});
  server?.closeAllConnections(); server?.close(); app.exit(1);
});
