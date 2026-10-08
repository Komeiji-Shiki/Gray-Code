const { PlatformStorage } = require('@graycode/core');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');

/** 使用独立数据目录中的真实历史存储和真实消息列表，不注入私有组件状态。 */
async function seedRendererWorkload(directory) {
  const storage = await PlatformStorage.open(directory);
  try {
    for (const count of [1000, 5000]) {
      const id = `renderer-benchmark-${count}`;
      await storage.createConversation({ id, actorId: 'owner', title: `Renderer benchmark ${count}`, createdAt: Date.now(), updatedAt: Date.now(), custom: { platformMode: 'chat' } });
      for (let start = 0; start < count; start += 100) {
        await storage.appendHistory(id, Array.from({ length: Math.min(100, count - start) }, (_, offset) => {
          const index = start + offset;
          const content = index % 5 === 0 ? '\n$$\\sum_{k=1}^{n} k = n(n+1)/2$$'
            : index % 5 === 1 ? '\n```mermaid\ngraph LR\nA[Read] --> B[Render]\n```'
            : index % 5 === 2 ? '\n```typescript\n' + Array.from({ length: 80 }, (_, line) => `const value${line} = ${line};`).join('\n') + '\n```' : '\n' + '合成对话用于滚动与布局测量。'.repeat(30);
          return { id: `${id}-${index}`, parentId: index ? `${id}-${index - 1}` : null, role: index % 2 ? 'model' : 'user',
            timestamp: 1_700_000_000_000 + index, parts: [{ text: `BENCH-${count}-${index}${content}` }] };
        }));
      }
    }
  } finally { await storage.close(); }
}

function streamRendererWorkload(body, response) {
  if (!body.stream || !JSON.stringify(body.messages ?? []).includes('renderer benchmark streaming')) return false;
  response.setHeader('Content-Type', 'text/event-stream');
  let index = 0;
  const started = performance.now();
  const timer = setInterval(() => {
    const done = performance.now() - started >= 3000;
    response.write(`data: ${JSON.stringify({ id: 'renderer-fixture', object: 'chat.completion.chunk', model: 'smoke-model', choices: [{ index: 0,
      delta: { content: done ? '\nrenderer benchmark complete' : `流式片段 ${index++}。` }, finish_reason: done ? 'stop' : null }] })}\n\n`);
    if (done) { clearInterval(timer); response.end('data: [DONE]\n\n'); }
  }, 16);
  response.on('close', () => clearInterval(timer));
  return true;
}

async function measureRendererSamples({ rpc, ui, chat, until, output, configId }) {
  const samples = [];
  await ui('config.updateConfig', { configId, updates: { preferStream: true, timeout: 60000, maxContextTokens: 2000000, contextManagementEnabled: false } });
  await ui('ui.settings.save');
  for (const count of [1000, 5000]) {
    const start = performance.now();
    await rpc('ui.command', { command: 'platform.openModeConversation', data: { conversationId: `renderer-benchmark-${count}` } });
    await until(() => chat(`document.body.innerText.includes('BENCH-${count}-${count - 1}')`), `history ${count}`, 60_000).catch(async error => {
      const state = await chat('JSON.stringify({text:document.body.innerText.slice(-5000),messages:Array.from(document.querySelectorAll("[data-message-id]")).map(node=>node.getAttribute("data-message-id")).slice(-12)})');
      await fs.writeFile(path.join(output, 'renderer-failure-state.json'), state); throw error;
    });
    const openMilliseconds = performance.now() - start;
    await chat('const editor=document.querySelector(".input-editor"); editor.focus(); editor.textContent="renderer benchmark streaming"; editor.dispatchEvent(new InputEvent("input",{bubbles:true,inputType:"insertText",data:editor.textContent}));');
    await until(() => chat('!!document.querySelector(".send-button:not(:disabled)")'), 'benchmark input');
    await chat('document.querySelector(".send-button").click()');
    const result = await chat(`new Promise(resolve => {
      const frames=[], tasks=[]; let previous=performance.now(), peakNodes=0, tick=0;
      const observer=new PerformanceObserver(list => tasks.push(...list.getEntries().map(entry => entry.duration)));
      observer.observe({type:'longtask',buffered:false});
      const step=now=>{
        frames.push(now-previous); previous=now;
        const list=Array.from(document.querySelectorAll('.message-list')).find(node=>node.getBoundingClientRect().height>0);
        peakNodes=Math.max(peakNodes,list?.querySelectorAll('.messages-container [data-message-id]').length??0);
        const container=list?.querySelector('.scroll-container');
        if(container){container.dispatchEvent(new WheelEvent('wheel',{deltaY:tick%60<30?-200:200,bubbles:true}));container.scrollTop=Math.max(0,container.scrollTop+(tick%60<30?-80:80));}
        if(++tick<180){requestAnimationFrame(step);return;}
        observer.disconnect();frames.sort((a,b)=>a-b);
        resolve({frameP50:frames[Math.floor(frames.length*.5)],frameP95:frames[Math.floor(frames.length*.95)],frameP99:frames[Math.floor(frames.length*.99)],longTasks:tasks.length,longTaskMax:Math.max(0,...tasks),peakMountedMessages:peakNodes,samples:frames.length});
      };requestAnimationFrame(step);
    })`);
    await chat('Array.from(document.querySelectorAll(".message-list")).find(node=>node.getBoundingClientRect().height>0)?.querySelector(".jump-btn-bottom")?.click()');
    await until(() => chat('document.body.innerText.includes("renderer benchmark complete")'), 'benchmark stream completed', 90_000);
    assert(result.peakMountedMessages > 0 && result.peakMountedMessages < 300, '消息窗口必须保持有界');
    samples.push({ messages: count, openMilliseconds, ...result });
    await fs.writeFile(path.join(output, 'renderer-performance.partial.json'), JSON.stringify(samples, null, 2));
  }
  await ui('config.updateConfig', { configId, updates: { preferStream: false } });
  await ui('ui.settings.save');
  const os = require('node:os'), cpus = os.cpus();
  const report = { generatedAt: new Date().toISOString(), environment: 'Electron offscreen, synthetic history and local SSE, single machine',
    runtime: { electron: process.versions.electron, node: process.versions.node, platform: process.platform, arch: process.arch,
      cpuModel: cpus[0]?.model, cpuCount: cpus.length, memoryGiB: Math.round(os.totalmem() / 1024 ** 3), sourceCommit: process.env.GITHUB_SHA },
    tracing: process.env.GRAYCODE_RENDER_TRACE === '1', samples };
  await fs.writeFile(path.join(output, 'renderer-performance.json'), JSON.stringify(report, null, 2));
  return report;
}

async function summarizeRendererCpu(profile, longTasks, output) {
  const { SourceMap } = require('node:module');
  const assetRoot = path.resolve(__dirname, '../apps/client/dist'), maps = new Map();
  const parents = new Map(), nodes = new Map(profile.nodes.map(node => [node.id, node]));
  for (const node of profile.nodes) for (const child of node.children ?? []) parents.set(child, node.id);
  let time = profile.startTime;
  const samples = (profile.samples ?? []).map((id, index) => {
    const start = time; time += profile.timeDeltas?.[index] ?? 0; return { id, start, end: time };
  });
  const source = async frame => {
    if (!frame.url.startsWith('graycode://app/')) return undefined;
    const file = path.resolve(assetRoot, decodeURIComponent(new URL(frame.url).pathname).replace(/^\/+/, '') + '.map');
    const relative = path.relative(assetRoot, file);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return undefined;
    let pending = maps.get(file);
    if (!pending) {
      pending = fs.readFile(file, 'utf8').then(text => new SourceMap(JSON.parse(text)))
        .catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      maps.set(file, pending);
    }
    const entry = (await pending)?.findEntry(frame.lineNumber, frame.columnNumber);
    return entry?.originalSource ? { file: entry.originalSource, line: entry.originalLine + 1,
      column: entry.originalColumn + 1, name: entry.name } : undefined;
  };
  const rank = async (start, end, limit) => {
    const self = new Map(), total = new Map();
    for (const sample of samples) {
      const weight = Math.max(0, Math.min(end, sample.end) - Math.max(start, sample.start)) / 1000;
      if (!weight) continue;
      self.set(sample.id, (self.get(sample.id) ?? 0) + weight);
      for (let id = sample.id; id !== undefined; id = parents.get(id)) total.set(id, (total.get(id) ?? 0) + weight);
    }
    const rows = [...total].filter(([id]) => !['(root)', '(idle)'].includes(nodes.get(id)?.callFrame.functionName))
      .map(([id, milliseconds]) => ({ id, sampledTotalMilliseconds: milliseconds, sampledSelfMilliseconds: self.get(id) ?? 0 }));
    const describe = async row => {
      const frame = nodes.get(row.id).callFrame;
      return { ...row, functionName: frame.functionName, url: frame.url, line: frame.lineNumber + 1, column: frame.columnNumber + 1,
        source: await source(frame) };
    };
    return { bySelf: await Promise.all([...rows].sort((left, right) => right.sampledSelfMilliseconds - left.sampledSelfMilliseconds).slice(0, limit).map(describe)),
      byTotal: await Promise.all(rows.sort((left, right) => right.sampledTotalMilliseconds - left.sampledTotalMilliseconds).slice(0, limit).map(describe)) };
  };
  const summary = { samples: samples.length, durationMilliseconds: (profile.endTime - profile.startTime) / 1000,
    overall: await rank(profile.startTime, profile.endTime, 15), longTasks: [] };
  for (const task of longTasks.slice(0, 3)) summary.longTasks.push({ milliseconds: task.dur / 1000,
    ...await rank(task.ts, task.ts + task.dur, 6) });
  await fs.writeFile(path.join(output, 'renderer-cpu-summary.json'), JSON.stringify(summary, null, 2));
  process.stdout.write(JSON.stringify({ rendererCpuSummary: summary }) + '\n');
}

async function measureRendererWorkload(options) {
  if (process.env.GRAYCODE_RENDER_TRACE !== '1') return measureRendererSamples(options);
  const { contentTracing } = require('electron');
  await contentTracing.startRecording({ recording_mode: 'record-until-full', trace_buffer_size_in_kb: 32768,
    included_categories: ['toplevel', 'devtools.timeline', 'disabled-by-default-devtools.timeline', 'v8.execute', 'blink.user_timing'],
    excluded_categories: ['*'] });
  let profile;
  const inspector = options.contents.debugger;
  try {
    inspector.attach('1.3');
    try {
      await inspector.sendCommand('Profiler.enable');
      await inspector.sendCommand('Profiler.setSamplingInterval', { interval: 1000 });
      await inspector.sendCommand('Profiler.start');
      try { return await measureRendererSamples(options); }
      finally {
        ({ profile } = await inspector.sendCommand('Profiler.stop'));
        await fs.writeFile(path.join(options.output, 'renderer-cpu.cpuprofile'), JSON.stringify(profile));
      }
    } finally { inspector.detach(); }
  }
  finally {
    const file = await contentTracing.stopRecording(path.join(options.output, 'renderer-trace.json'));
    const { traceEvents: events } = JSON.parse(await fs.readFile(file, 'utf8'));
    const threads = new Map(events.filter(event => event.ph === 'M' && event.name === 'thread_name')
      .map(event => [`${event.pid}:${event.tid}`, event.args?.name]));
    const timed = events.filter(event => event.ph === 'X' && typeof event.dur === 'number');
    const renderer = timed.filter(event => threads.get(`${event.pid}:${event.tid}`) === 'CrRendererMain');
    const location = event => {
      const data = event.args?.data ?? {};
      return { name: event.name, milliseconds: event.dur / 1000, url: data.url,
        functionName: data.functionName, lineNumber: data.lineNumber, columnNumber: data.columnNumber };
    };
    // 这里只列包含关系中的耗时事件；父子事件会重叠，不能相加当作总耗时。
    const longest = renderer.filter(event => event.dur >= 50000).sort((left, right) => right.dur - left.dur).slice(0, 25);
    const summary = { events: events.length, rendererTimedEvents: renderer.length, file: path.basename(file),
      longest: longest.map(event => ({ ...location(event), pid: event.pid, tid: event.tid,
        children: renderer.filter(child => child !== event && child.pid === event.pid && child.tid === event.tid
          && child.ts >= event.ts && child.ts + child.dur <= event.ts + event.dur)
          .sort((left, right) => right.dur - left.dur).slice(0, 6).map(location) })) };
    await fs.writeFile(path.join(options.output, 'renderer-trace-summary.json'), JSON.stringify(summary, null, 2));
    process.stdout.write(JSON.stringify({ rendererTraceSummary: summary }) + '\n');
    if (profile) await summarizeRendererCpu(profile,
      longest.filter(event => event.name === 'RunTask' && event.pid === options.contents.getOSProcessId()), options.output);
  }
}
module.exports = { seedRendererWorkload, streamRendererWorkload, measureRendererWorkload };

if (require.main === module) {
  // 先由 Node 关闭准备数据的核心，再启动 Electron；不绕过数据目录的单实例锁。
  const { spawn } = require('node:child_process');
  const { randomUUID } = require('node:crypto');
  const root = path.resolve(__dirname, '..');
  const output = path.join(root, '.tmp', `desktop-smoke-renderer-${randomUUID().slice(0, 8)}`);
  void seedRendererWorkload(path.join(output, 'data')).then(() => {
    const child = spawn(require('electron'), [path.join(__dirname, 'smoke-desktop.cjs')], { cwd: root, windowsHide: true, stdio: 'inherit',
      env: { ...process.env, GRAYCODE_RENDER_BENCHMARK: '1', GRAYCODE_SMOKE_OUTPUT: output, GRAYCODE_BENCHMARK_ONLY: process.argv.includes('--only') ? '1' : '0',
        GRAYCODE_RENDER_TRACE: process.argv.includes('--trace') || process.env.GRAYCODE_RENDER_TRACE === '1' ? '1' : '0' } });
    child.once('error', error => { console.error(error); process.exitCode = 1; });
    child.once('exit', code => { process.exitCode = code ?? 1; });
  }).catch(error => { console.error(error); process.exitCode = 1; });
}
