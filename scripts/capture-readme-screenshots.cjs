// Run with: npx electron scripts/capture-readme-screenshots.cjs (after npm run build:desktop).
// 用隔离数据目录、脚本化的本机模型端点、假 DeepSeek 搜索端和假 NapCat 端重放演示任务，把 README 与手册截图写入 wiki/assets。
// 运行数据留在 .tmp/readme-shots，每次运行前清空；--record 额外把各场景录成 .tmp/readme-shots/*.mp4，供宣传片剪辑（需要 ffmpeg）。
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { createServer } = require('node:http');
const { execFileSync } = require('node:child_process');
const { WebSocketServer } = require('ws');
const root = path.resolve(__dirname, '..');
const output = path.join(root, '.tmp', 'readme-shots');
const project = path.join(output, 'todo-api');
const assets = path.join(root, 'wiki', 'assets');
// 截图中的工作区路径统一显示为虚构目录，避免把本机路径写进提交的图片。
const displayedPaths = [[project, 'D:\\Projects\\todo-api'], [path.join(output, 'documents'), 'C:\\Users\\Gray\\Documents']];
const model = 'deepseek-v4.1-flash';
const recording = process.argv.includes('--record');
const bridgeSource = require('esbuild').buildSync({ entryPoints: [path.join(root, 'shared/desktopBridge.ts')],
  bundle: true, write: false, format: 'iife', globalName: 'GraycodeShotsBridge' }).outputFiles[0].text;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(check, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await sleep(100);
  }
  throw new Error(`Timed out: ${label}`);
}

const fixture = {
  'package.json': JSON.stringify({ name: 'todo-api', version: '0.4.2', private: true, type: 'module',
    scripts: { start: 'node src/server.ts', test: 'node --test "test/*.test.ts"' } }, null, 2) + '\n',
  'README.md': '# todo-api\n\n轻量的待办事项 HTTP 服务，零依赖，运行在 Node.js 内置的 http 模块上。\n\n```bash\nnpm start\nnpm test\n```\n',
  '.gitignore': 'node_modules/\n',
  'src/http.ts': `import type { IncomingMessage, ServerResponse } from 'node:http';

export async function readJson(req: IncomingMessage): Promise<Record<string, string>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

export function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}
`,
  'src/users.ts': `import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const users = new Map<string, Buffer>([['demo', hash('correct horse')]]);

function hash(password: string) {
  return createHash('sha256').update(password).digest();
}

export function verifyPassword(username: string, password: string) {
  const expected = users.get(username);
  return !!expected && timingSafeEqual(expected, hash(password ?? ''));
}

export function issueToken(username: string) {
  return \`\${username}.\${randomBytes(16).toString('hex')}\`;
}
`,
  'src/routes/auth.ts': `import type { IncomingMessage, ServerResponse } from 'node:http';
import { readJson, send } from '../http.ts';
import { issueToken, verifyPassword } from '../users.ts';

export async function login(req: IncomingMessage, res: ServerResponse) {
  const { username, password } = await readJson(req);
  if (!verifyPassword(username, password)) return send(res, 401, { error: 'invalid_credentials' });
  send(res, 200, { token: issueToken(username) });
}
`,
  'src/routes/todos.ts': `import type { IncomingMessage, ServerResponse } from 'node:http';
import { readJson, send } from '../http.ts';

const todos: Array<{ id: number; title: string; done: boolean }> = [];

export function listTodos(_req: IncomingMessage, res: ServerResponse) {
  send(res, 200, todos);
}

export async function createTodo(req: IncomingMessage, res: ServerResponse) {
  const { title } = await readJson(req);
  if (!title?.trim()) return send(res, 400, { error: 'title_required' });
  const todo = { id: todos.length + 1, title: title.trim(), done: false };
  todos.push(todo);
  send(res, 201, todo);
}
`,
  'src/server.ts': `import { createServer } from 'node:http';
import { send } from './http.ts';
import { login } from './routes/auth.ts';
import { createTodo, listTodos } from './routes/todos.ts';

const routes = {
  'POST /api/login': login,
  'GET /api/todos': listTodos,
  'POST /api/todos': createTodo,
};

export const server = createServer((req, res) => {
  const handler = routes[\`\${req.method} \${req.url?.split('?')[0]}\`];
  if (!handler) return send(res, 404, { error: 'not_found' });
  handler(req, res);
});

if (process.argv[1]?.endsWith('server.ts')) server.listen(3000);
`,
  'test/auth.test.ts': `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { issueToken, verifyPassword } from '../src/users.ts';

test('正确的密码通过校验', () => {
  assert.equal(verifyPassword('demo', 'correct horse'), true);
});

test('错误的密码和不存在的用户被拒绝', () => {
  assert.equal(verifyPassword('demo', 'wrong'), false);
  assert.equal(verifyPassword('nobody', 'correct horse'), false);
});

test('签发的令牌带用户名前缀', () => {
  assert.match(issueToken('demo'), /^demo\\.[0-9a-f]{32}$/);
});
`,
  'public/index.html': `<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8">
<title>todo-api · 看板</title>
<style>
  body { margin: 0; font: 15px/1.6 "Segoe UI", "Microsoft YaHei", sans-serif; background: #11141a; color: #d8dee9; }
  main { max-width: 560px; margin: 56px auto; padding: 0 28px; }
  h1 { margin: 0; font-size: 24px; letter-spacing: .02em; }
  h1::before { content: ""; display: block; width: 48px; height: 4px; margin-bottom: 18px; background: #7aa2f7; }
  p { margin: 4px 0 28px; color: #7d8699; }
  form { display: flex; gap: 8px; margin-bottom: 18px; }
  input[type=text] { flex: 1; padding: 10px 12px; border: 1px solid #2a3140; background: #181c24; color: inherit; font: inherit; }
  button { padding: 10px 20px; border: 0; background: #7aa2f7; color: #0f1218; font: inherit; font-weight: 600; cursor: pointer; }
  ul { margin: 0; padding: 0; list-style: none; }
  li { display: flex; align-items: center; gap: 12px; margin-bottom: 4px; padding: 12px 14px; background: #171b23; }
  li input { width: 16px; height: 16px; accent-color: #7aa2f7; }
  li.done span { color: #566073; text-decoration: line-through; }
  footer { margin-top: 20px; color: #7d8699; font-size: 13px; }
</style>
<main>
  <h1>todo-api 看板</h1>
  <p>0.4.2 迭代 · 本周待办</p>
  <form id="add"><input type="text" id="title" aria-label="新待办" placeholder="添加待办…"><button>添加</button></form>
  <ul id="list"></ul>
  <footer id="summary"></footer>
</main>
<script>
  const items = [
    { title: '为 /api/todos 增加分页', done: false },
    { title: '整理 0.4.2 发布说明', done: false },
    { title: '测试迁移到 node:test', done: true },
  ];
  const list = document.getElementById('list');
  function summarize() {
    const done = items.filter(item => item.done).length;
    document.getElementById('summary').textContent = \`共 \${items.length} 项 · 已完成 \${done} 项\`;
  }
  function render() {
    list.replaceChildren(...items.map(item => {
      const row = document.createElement('li');
      row.className = item.done ? 'done' : '';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = item.done;
      box.setAttribute('aria-label', item.title);
      // 勾选只更新当前行，保留复选框节点，自动化工具才能确认勾选后的状态。
      box.addEventListener('change', () => { item.done = box.checked; row.className = item.done ? 'done' : ''; summarize(); });
      const text = document.createElement('span');
      text.textContent = item.title;
      row.append(box, text);
      return row;
    }));
    summarize();
  }
  document.getElementById('add').addEventListener('submit', event => {
    event.preventDefault();
    const field = document.getElementById('title');
    if (field.value.trim()) items.unshift({ title: field.value.trim(), done: false });
    field.value = '';
    render();
  });
  render();
</script>
</html>
`,
};

const rateLimitSource = `export interface RateLimitOptions {
  windowMs: number;
  max: number;
  now?: () => number;
}

/** 按键计数的滑动窗口限流器，只保存窗口内的请求时间。 */
export function createRateLimiter({ windowMs, max, now = Date.now }: RateLimitOptions) {
  const hits = new Map<string, number[]>();
  return {
    take(key: string) {
      const current = now();
      const recent = (hits.get(key) ?? []).filter(time => current - time < windowMs);
      if (recent.length >= max) {
        hits.set(key, recent);
        return { allowed: false, retryAfter: Math.ceil((recent[0] + windowMs - current) / 1000) };
      }
      recent.push(current);
      hits.set(key, recent);
      return { allowed: true, retryAfter: 0 };
    },
  };
}
`;
const rateLimitTest = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRateLimiter } from '../src/middleware/rateLimit.ts';

function limiterAt(start = 0) {
  const clock = { now: start };
  return { clock, limiter: createRateLimiter({ windowMs: 60_000, max: 5, now: () => clock.now }) };
}

test('同一 IP 在窗口内超过上限后被拒绝', () => {
  const { limiter } = limiterAt();
  for (let i = 0; i < 5; i++) assert.equal(limiter.take('10.0.0.1').allowed, true);
  assert.deepEqual(limiter.take('10.0.0.1'), { allowed: false, retryAfter: 60 });
});

test('不同 IP 分别计数', () => {
  const { limiter } = limiterAt();
  for (let i = 0; i < 5; i++) limiter.take('10.0.0.1');
  assert.equal(limiter.take('10.0.0.2').allowed, true);
});

test('窗口滑过后恢复配额', () => {
  const { clock, limiter } = limiterAt();
  for (let i = 0; i < 5; i++) limiter.take('10.0.0.1');
  clock.now += 60_000;
  assert.equal(limiter.take('10.0.0.1').allowed, true);
});
`;

// 浏览器场景的标签页和 ref 由真实快照决定：标签页取自 create 的回执，ref 按角色和可见名称从最近的快照里查找。
function toolResult(message) {
  return JSON.parse(message.content);
}
function findTabId(body) {
  return toolResult(body.messages.find(message => message.tool_call_id === 'browser-0-0')).data.id;
}
function findRef(body, role, label) {
  for (const message of body.messages.filter(item => item.role === 'tool').reverse()) {
    for (const node of toolResult(message).data?.snapshot?.nodes ?? []) {
      const match = node.match(/\[(e\d+)\] (\w+) "([^"]*)"/);
      if (match?.[2] === role && match[3] === label) return match[1];
    }
  }
  throw new Error(`Browser ref not found: ${role} ${label}`);
}

const searchResults = [
  { title: '联网搜索 API | DeepSeek API 文档', url: 'https://api-docs.deepseek.com/zh-cn/api/web-search',
    site_name: 'DeepSeek API 文档', date: '2026-09-28', authority: 5,
    snippet: '联网搜索接口返回网页标题、链接、摘要、站点与发布日期，支持 site:、lang:、after: 等检索运算符。',
    summary: '官方联网搜索接口。返回标题、链接、摘要、站点、日期与权威等级；每个账户每秒最多 5 次请求，超出时返回 429，可稍后重试。' },
  { title: '网页抓取 API | DeepSeek API 文档', url: 'https://api-docs.deepseek.com/zh-cn/api/web-fetch',
    site_name: 'DeepSeek API 文档', date: '2026-09-28', authority: 5,
    snippet: '读取指定网页并返回 Markdown 正文。',
    summary: '读取单个 HTTP/HTTPS 网页并返回 Markdown 正文，与联网搜索共用 API Key 和频率配额。' },
  { title: '错误码 | DeepSeek API 文档', url: 'https://api-docs.deepseek.com/zh-cn/quick_start/error_codes',
    site_name: 'DeepSeek API 文档', date: '2026-08-14', authority: 5,
    snippet: '429 - 请求速率达到上限。',
    summary: '429 表示请求速率达到上限，请降低请求频率后重试；5xx 为服务端临时错误。' },
];
const fetchedPage = { title: '联网搜索 API | DeepSeek API 文档', content: [
  '# 联网搜索 API', '', '使用联网搜索检索公开网页，结果包含标题、链接、摘要、站点、发布日期与权威等级。', '',
  '## 频率限制', '', '- 每个账户每秒最多 5 次请求，搜索与抓取共用配额。', '- 超出限制时返回 `429`，请等待后重试。', '',
  '## 检索运算符', '', '| 运算符 | 说明 |', '| --- | --- |', '| `site:` | 限定站点 |', '| `lang:` | 限定语言 |', '| `after:` | 限定发布日期之后 |',
].join('\n') };

const scenes = [
  {
    id: 'code', match: '撞库',
    steps: [
      () => ({
        reasoning: '要给登录接口加限流。先确认登录路由在哪、现有的中间件写法和测试结构，再决定限流器放在哪里。',
        content: '先看看登录路由和现有测试。',
        tools: [
          ['search_in_files', { query: 'login', path: 'src' }],
          ['read_file', { files: [{ path: 'src/routes/auth.ts' }, { path: 'test/auth.test.ts' }] }],
        ],
      }),
      () => ({
        reasoning: 'login 直接校验密码，没有任何频率限制。项目零依赖、测试用 node:test，所以限流器写成纯函数工厂，时间源可注入，测试不必真的等一分钟。'
          + '按 IP 计数，超出时返回 429 并带 Retry-After，方便客户端退避。',
        content: '登录处理没有任何频率限制。我新增一个按 IP 计数的滑动窗口限流器接到登录路由上，并用可注入的时钟补测试。',
        tools: [
          ['write_file', { path: 'src/middleware/rateLimit.ts', content: rateLimitSource }],
          ['apply_diff', { path: 'src/routes/auth.ts', hunks: [
            { oldContent: "import { issueToken, verifyPassword } from '../users.ts';\n",
              newContent: "import { issueToken, verifyPassword } from '../users.ts';\nimport { createRateLimiter } from '../middleware/rateLimit.ts';\n\n"
                + 'const loginLimiter = createRateLimiter({ windowMs: 60_000, max: 5 });\n' },
            { oldContent: '  const { username, password } = await readJson(req);\n',
              newContent: "  const limit = loginLimiter.take(req.socket.remoteAddress ?? 'unknown');\n  if (!limit.allowed) {\n"
                + "    res.setHeader('Retry-After', String(limit.retryAfter));\n    return send(res, 429, { error: 'too_many_attempts' });\n  }\n"
                + '  const { username, password } = await readJson(req);\n' },
          ] }],
          ['write_file', { path: 'test/rateLimit.test.ts', content: rateLimitTest }],
        ],
      }),
      () => ({ reasoning: '改动完成，跑一遍全部测试，确认原有用例没有被破坏。', tools: [['execute_command', { command: 'npm test' }]] }),
      () => ({ content: [
        '登录接口已经加上按 IP 的限流，测试全部通过。', '',
        '| 文件 | 改动 |', '| --- | --- |',
        '| `rateLimit.ts` | 新增滑动窗口限流器，只保留窗口内的请求时间，时钟可注入 |',
        '| `auth.ts` | 同一 IP 每分钟最多 5 次登录尝试，超出返回 `429` 并带 `Retry-After` |',
        '| `rateLimit.test.ts` | 覆盖超限拒绝、不同 IP 分别计数和窗口滑过后恢复 |', '',
        '`npm test` 共 6 项用例，全部通过。', '',
        '还有一点要留意：服务如果部署在反向代理后面，`req.socket.remoteAddress` 拿到的是代理地址，所有用户会共用一份配额。'
          + '需要的话我可以加一个受信代理列表，从 `X-Forwarded-For` 里取真实 IP。',
      ].join('\n') }),
    ],
  },
  {
    id: 'browser', match: '看板页面',
    steps: [
      () => ({ content: '好，我在内置浏览器里打开看板。', tools: [['browser_tabs', { action: 'create', path: 'public/index.html' }]] }),
      body => ({ tools: [['browser_action', { action: 'fill', tabId: findTabId(body), ref: findRef(body, 'textbox', '新待办'), text: '登录接口加按 IP 限流' }]] }),
      body => ({ tools: [['browser_action', { action: 'click', tabId: findTabId(body), ref: findRef(body, 'button', '添加') }]] }),
      body => ({ tools: [['browser_action', { action: 'check', tabId: findTabId(body), ref: findRef(body, 'checkbox', '整理 0.4.2 发布说明'), checked: true }]] }),
      body => ({ tools: [['browser_tabs', { action: 'show', tabId: findTabId(body) }]] }),
      () => ({ content: '看板已经更新：\n\n- 新增待办「登录接口加按 IP 限流」\n- 「整理 0.4.2 发布说明」已勾选完成\n\n页面底部显示共 4 项、已完成 2 项。标签页留在内置浏览器里，你可以接着操作。' }),
    ],
  },
  {
    id: 'bot', match: '搜索 API',
    steps: [
      () => ({ reasoning: '群友问 DeepSeek 官方搜索 API 的频率限制，先联网搜官方文档。', tools: [['web_search', { query: 'DeepSeek 官方联网搜索 API 频率限制' }]] }),
      () => ({ tools: [['web_fetch', { url: searchResults[0].url }]] }),
      () => ({ content: '有的，按账户算每秒最多 5 次，搜索和抓取共用这份配额，超了会返回 429。GrayCode 遇到 429 会等一下自动重试一次，一般感觉不到。\n'
        + '接入在「设置 → 工具 → 网页搜索」里填接口地址和 API Key，和模型渠道分开配置，用第三方中转的模型也能搜。配好以后像现在这样，群里问问题我就能直接查官方文档啦~' }),
    ],
  },
];

function sceneFor(body) {
  const text = JSON.stringify(body.messages.filter(message => message.role === 'user').map(message => message.content));
  return scenes.find(scene => text.includes(scene.match));
}
function stepOf(body, scene) {
  const steps = body.messages.filter(message => message.role === 'tool')
    .map(message => message.tool_call_id?.match(new RegExp(`^${scene.id}-(\\d+)-`))?.[1]).filter(Boolean).map(Number);
  return steps.length ? Math.max(...steps) + 1 : 0;
}

async function streamReply(res, step, { reasoning = '', content = '', tools = [] }, prefix) {
  res.setHeader('Content-Type', 'text/event-stream');
  // 录制时保留接近真实模型的首字延迟，画面上能看到等待与开始输出的节奏。
  if (recording) await sleep(700);
  const send = delta => res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta }] }) + '\n\n');
  // 正文和工具参数都按小块输出，界面上的流式节奏与 tok/s 接近真实模型，录制时也能看到打字效果。
  let streamed = 0;
  for (const [field, text] of [['reasoning_content', reasoning], ['content', content]]) {
    for (let index = 0; index < text.length; index += 3) {
      send({ [field]: text.slice(index, index + 3) });
      await sleep(12);
    }
    streamed += text.length;
  }
  for (const [index, [name, args]] of tools.entries()) {
    const text = JSON.stringify(args);
    send({ tool_calls: [{ index, id: `${prefix}-${step}-${index}`, type: 'function', function: { name, arguments: '' } }] });
    for (let offset = 0; offset < text.length; offset += 6) {
      send({ tool_calls: [{ index, function: { arguments: text.slice(offset, offset + 6) } }] });
      await sleep(12);
    }
    streamed += text.length;
  }
  const usage = { prompt_tokens: 18432 + step * 2311, completion_tokens: Math.ceil(streamed / 1.5),
    prompt_tokens_details: { cached_tokens: 16384 + step * 2048 } };
  usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
  res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: tools.length ? 'tool_calls' : 'stop' }], usage }) + '\n\n');
  res.end('data: [DONE]\n\n');
}

function createModelServer() {
  return createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/search') return res.end(JSON.stringify({ results: searchResults }));
    if (req.url === '/fetch') return res.end(JSON.stringify(fetchedPage));
    const scene = sceneFor(body);
    if (!scene) return streamReply(res, 0, { content: '好的。' }, 'misc');
    const step = stepOf(body, scene);
    fs.writeFileSync(path.join(output, 'requests', `${scene.id}-${step}.json`), JSON.stringify(body, null, 2));
    try {
      return await streamReply(res, step, scene.steps[Math.min(step, scene.steps.length - 1)](body), scene.id);
    } catch (error) {
      process.stderr.write(`${scene.id} step ${step}: ${error.message}\n`);
      res.statusCode = 500;
      res.end(JSON.stringify({ error: { message: error.message } }));
    }
  });
}

// 假 NapCat：只实现演示用到的 OneBot 11 动作，记录 GrayCode 发回群里的消息。
function createOneBotServer(sent) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  server.on('connection', client => client.on('message', raw => {
    const action = JSON.parse(raw.toString());
    let data = {};
    if (action.action === 'get_login_info') data = { user_id: 10001, nickname: '灰魂' };
    else if (action.action === 'get_group_info') data = { group_id: 70001, group_name: 'GrayCode 用户群', member_count: 233 };
    else if (action.action === 'get_group_member_info') data = { user_id: 20002, nickname: '竹林', card: '竹林' };
    else if (action.action.startsWith('send_')) {
      sent.push(action);
      data = { message_id: 9000 + sent.length };
    }
    client.send(JSON.stringify({ status: 'ok', retcode: 0, data, echo: action.echo }));
  }));
  return server;
}

// Electron 内置 Node 24 的 rmSync 遇到只读文件（夹具仓库的 .git/objects）会直接 EPERM；
// 异步 rm 能处理，但桌面入口必须在 app ready 前同步加载，所以先恢复写权限再同步删除。
function clearOutput() {
  if (!fs.existsSync(output)) return;
  for (const entry of fs.readdirSync(output, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) fs.chmodSync(path.join(entry.parentPath, entry.name), 0o666);
  }
  fs.rmSync(output, { recursive: true, force: true });
}

// 界面里可能出现本机路径的地方不止状态栏（请求预览正文、工作区提示等），统一换成虚构目录；JSON 正文里还有转义和正斜杠写法。
// 界面会随状态重新渲染，所以用 MutationObserver 持续替换，截图和录屏都不会露出本机路径。
const maskPathsSource = `(() => {
  if (window.__graycodeShotsMask) return;
  window.__graycodeShotsMask = true;
  const pairs = ${JSON.stringify(displayedPaths.flatMap(([local, shown]) => [[local, shown],
    [JSON.stringify(local).slice(1, -1), JSON.stringify(shown).slice(1, -1)], [local.replaceAll('\\', '/'), shown.replaceAll('\\', '/')]]))};
  const maskText = node => {
    let text = node.nodeValue;
    for (const [local, shown] of pairs) text = text.split(local).join(shown);
    if (text !== node.nodeValue) node.nodeValue = text;
  };
  const mask = root => {
    if (root.nodeType === Node.TEXT_NODE) return maskText(root);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) maskText(node);
  };
  mask(document.body);
  new MutationObserver(records => records.forEach(record => mask(record.target)))
    .observe(document.body, { subtree: true, childList: true, characterData: true });
})()`;

// 离屏窗口每次重绘都会触发 paint：按时间戳保存帧，结束后按真实间隔拼成 30fps 视频，供宣传片剪辑。
function startRecording(window, name) {
  const dir = path.join(output, 'frames', name);
  fs.mkdirSync(dir, { recursive: true });
  const frames = [];
  const onPaint = (_event, _dirty, image) => {
    const time = performance.now();
    if (frames.length && time - frames.at(-1).time < 1000 / 30) return;
    const file = path.join(dir, `${String(frames.length).padStart(5, '0')}.jpg`).replaceAll('\\', '/');
    fs.writeFileSync(file, image.toJPEG(92));
    frames.push({ file, time });
  };
  window.webContents.on('paint', onPaint);
  window.webContents.invalidate();
  return () => {
    window.webContents.off('paint', onPaint);
    const seconds = index => ((frames[index + 1]?.time ?? frames[index].time + 1500) - frames[index].time) / 1000;
    const list = frames.map((frame, index) => `file '${frame.file}'\nduration ${seconds(index).toFixed(4)}`);
    // concat 分离器忽略最后一项的时长，重复最后一帧才能保留结尾停顿。
    list.push(`file '${frames.at(-1).file}'`);
    fs.writeFileSync(path.join(dir, 'frames.txt'), list.join('\n'));
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', path.join(dir, 'frames.txt'),
      '-vf', 'fps=30,format=yuv420p', '-c:v', 'libx264', '-crf', '14', '-preset', 'slow', path.join(output, `${name}.mp4`)]);
    process.stdout.write(`recorded ${name}.mp4 (${frames.length} frames)\n`);
  };
}

async function main() {
  clearOutput();
  for (const [file, content] of Object.entries(fixture)) {
    fs.mkdirSync(path.dirname(path.join(project, file)), { recursive: true });
    fs.writeFileSync(path.join(project, file), content);
  }
  for (const dir of ['profile', 'app-data', 'documents', 'requests', 'frames']) fs.mkdirSync(path.join(output, dir), { recursive: true });
  const git = (...args) => execFileSync('git', args, { cwd: project, stdio: 'ignore' });
  git('init', '-q');
  git('add', '.');
  git('-c', 'user.name=GrayCode', '-c', 'user.email=demo@graycode.invalid', 'commit', '-q', '-m', '初始化 todo-api');
  app.setPath('userData', path.join(output, 'profile'));
  app.setPath('appData', path.join(output, 'app-data'));
  app.setPath('documents', path.join(output, 'documents'));
  process.env.GRAYCODE_DESKTOP_SMOKE = '1';
  process.argv.push('--data', path.join(output, 'data'));
  require(path.join(root, 'apps/desktop/dist/main.cjs'));

  const modelServer = createModelServer();
  await new Promise(resolve => modelServer.listen(0, '127.0.0.1', resolve));
  const modelUrl = `http://127.0.0.1:${modelServer.address().port}`;
  const sent = [];
  const onebotServer = createOneBotServer(sent);
  await new Promise(resolve => onebotServer.once('listening', resolve));

  const window = await until(() => BrowserWindow.getAllWindows().find(item => item.webContents.getURL().startsWith('graycode://app/index')), 'main window');
  window.unmaximize();
  window.setContentSize(1600, 1000);
  // 冒烟模式的窗口默认隐藏，内置浏览器只在窗口可见时挂上视图；透明显示既不打扰桌面，又让视图参与布局。
  window.setOpacity(0);
  window.setSkipTaskbar(true);
  window.showInactive();
  const failWith = source => error => { throw new Error(`${error.message}\n  in: ${source.slice(0, 200)}`); };
  const evaluate = source => window.webContents.executeJavaScript(source, true).catch(failWith(source));
  const rpc = (method, params = {}) => evaluate(`(() => { ${bridgeSource}
    return GraycodeShotsBridge.callDesktopBridge(window.graycode, ${JSON.stringify(method)}, ${JSON.stringify(params)}); })()`);
  const ui = (type, data = {}) => rpc('ui.request', { type, data });
  const chat = source => {
    const frame = window.webContents.mainFrame.frames.find(item => item.url.includes('/chat/platform.html'));
    return frame ? frame.executeJavaScript('{' + source + '\n}', true).catch(failWith(source)) : Promise.resolve(false);
  };
  const clickText = (selector, text) => evaluate(`Array.from(document.querySelectorAll(${JSON.stringify(selector)}))
    .find(node => node.textContent.trim() === ${JSON.stringify(text)}).click()`);
  const capture = async name => {
    await evaluate(maskPathsSource);
    await chat(maskPathsSource);
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    await sleep(250);
    // 内置浏览器是叠在主页面上的独立视图，主页面截图不含它，按视图位置合成到同一张图里。
    const overlays = [];
    for (const view of window.contentView.children.filter(child => child.getVisible() && child.webContents)) {
      const { x, y, width, height } = view.getBounds();
      // 离屏模式下子视图按整个窗口尺寸排版，截图前把视口模拟成视图自身的大小，再裁出对应区域。
      view.webContents.enableDeviceEmulation({ screenPosition: 'desktop', screenSize: { width, height }, viewPosition: { x: 0, y: 0 },
        viewSize: { width, height }, deviceScaleFactor: 0, scale: 1 });
      await sleep(400);
      const image = await view.webContents.capturePage({ x: 0, y: 0, width, height });
      view.webContents.disableDeviceEmulation();
      overlays.push({ x, y, width, height, url: image.toDataURL() });
    }
    const base = (await window.webContents.capturePage()).toDataURL();
    const png = await evaluate(`(async () => {
      const load = source => new Promise(resolve => { const image = new Image(); image.onload = () => resolve(image); image.src = source; });
      const base = await load(${JSON.stringify(base)});
      const canvas = Object.assign(document.createElement('canvas'), { width: base.width, height: base.height });
      const context = canvas.getContext('2d');
      context.drawImage(base, 0, 0);
      for (const overlay of ${JSON.stringify(overlays)}) context.drawImage(await load(overlay.url), overlay.x, overlay.y, overlay.width, overlay.height);
      return canvas.toDataURL('image/png');
    })()`);
    fs.writeFileSync(path.join(assets, name), Buffer.from(png.split(',')[1], 'base64'));
    process.stdout.write(`captured ${name}\n`);
  };
  const record = name => (recording ? startRecording(window, name) : () => {});
  const send = async text => {
    await until(() => chat('!!document.querySelector(".input-editor")'), 'chat input');
    // 录制时逐字输入，画面里能看到需求是怎么打出来的。
    for (const typed of recording ? Array.from(text, (_char, index) => text.slice(0, index + 1)) : [text]) {
      await chat(`const editor = document.querySelector('.input-editor'); editor.focus(); editor.textContent = ${JSON.stringify(typed)};
        editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: editor.textContent }));`);
      if (recording) await sleep(40);
    }
    await until(() => chat('!!document.querySelector(".send-button:not([disabled])")'), 'send enabled');
    if (recording) await sleep(400);
    await chat('document.querySelector(".send-button").click()');
  };
  // 演示任务中的命令审批也走真实工具卡，录制时能看到确认动作。
  const finishRun = async conversationId => until(async () => {
    if ((await rpc('approvals.list')).length) await chat('document.querySelector(".confirm-btn:not([disabled])")?.click()');
    const run = (await rpc('runs.list')).find(item => item.conversationId === conversationId);
    if (run?.status === 'failed') throw new Error(run.error || 'Demo run failed.');
    return run?.status === 'completed';
  }, 'demo run', 120000);
  const focusedConversation = async () => {
    await evaluate(`window.__shotsFocus = null; window.graycode.subscribe(event => {
      if (event.type === 'ui.conversation.focused' && event.workspaceId === 'demo' && event.conversationId) {
        window.__shotsFocus = event.conversationId;
      } }); undefined`);
    await evaluate(`Array.from(document.querySelectorAll('.navigation-project-select')).find(node => node.textContent.includes('todo-api'))
      .closest('.navigation-group-heading').querySelector('.navigation-project-add').click()`);
    return until(() => evaluate('window.__shotsFocus'), 'project conversation');
  };
  const setSidePanel = open => evaluate(`if (document.querySelector('.desktop-workspace').classList.contains('chat-focused') === ${open}) {
    document.querySelector('.titlebar .panel-toggle').click(); }`);
  const openPanel = async label => {
    await setSidePanel(true);
    await until(() => evaluate('!!document.querySelector(".workbench-tabbar .add-panel")'), 'workbench tab bar');
    await evaluate('document.querySelector(".workbench-tabbar .add-panel").click()');
    await until(() => evaluate('!!document.querySelector(".workbench-add-menu")'), 'workbench panel menu');
    await evaluate(`Array.from(document.querySelectorAll('.workbench-add-menu button'))
      .find(node => node.querySelector('span')?.textContent === ${JSON.stringify(label)}).click()`);
  };

  await until(() => evaluate('!!document.querySelector(".desktop-workspace") && !document.querySelector(".splash")'), 'application ready');
  await ui('ui.settings.begin');
  const settings = await ui('platform.settings.get');
  settings.workspaces.push({ id: 'demo', name: 'todo-api', directory: project, deviceId: 'local' });
  await ui('platform.settings.update', { settings });
  const configId = await ui('config.createConfig', { name: 'DeepSeek', type: 'openai' });
  await ui('config.updateConfig', { configId, updates: { url: `${modelUrl}/v1`, apiKey: 'demo-only', model,
    models: [{ id: model, name: model }], preferStream: true, timeout: 20000 } });
  await ui('settings.setActiveChannelId', { channelId: configId });
  await ui('tools.updateApplyDiffConfig', { config: { autoSave: true, autoApplyWithoutDiffView: true } });
  await ui('tools.updateToolConfig', { toolName: 'web_search', config: { endpoint: `${modelUrl}/search`, fetchEndpoint: `${modelUrl}/fetch`,
    apiKey: 'demo-only', count: 5, needContent: false } });
  await ui('updateUISettings', { ui: { language: 'zh-CN' } });
  await ui('ui.settings.save');
  await ui('ui.settings.end');
  window.webContents.reload();
  await until(() => evaluate('!!document.querySelector(".desktop-workspace") && document.body.innerText.includes("todo-api")'), 'configured application');
  await until(() => chat(`!!document.querySelector(".input-editor") && document.body.innerText.includes(${JSON.stringify(model)})`), 'configured chat');
  await evaluate(maskPathsSource);
  await chat(maskPathsSource);

  // 编码：一句话需求 → 搜索、读取、修改、跑测试，再在审查面板里看 auth.ts 的红绿 diff。
  const codeConversation = await focusedConversation();
  let stop = record('code');
  await send('登录接口最近被撞库了，给 /api/login 加上按 IP 的限流（每分钟 5 次），并补上测试。');
  await finishRun(codeConversation);
  await openPanel('审查');
  await until(() => evaluate('Array.from(document.querySelectorAll(".diff-row")).some(node => node.textContent.includes("auth.ts"))'), 'review rows');
  await evaluate('Array.from(document.querySelectorAll(".diff-row")).find(node => node.textContent.includes("auth.ts")).click()');
  await sleep(1500);
  stop();
  await capture('workbench.png');

  // 诊断：同一次运行的请求预览。
  await evaluate('document.querySelector(".run-status-strip .quiet-button").click()');
  await until(() => evaluate('document.body.innerText.includes("实际请求正文")'), 'run inspector');
  await sleep(800);
  await capture('diagnostics.png');
  await evaluate('document.querySelector(".run-status-strip .quiet-button").click()');

  // 网页操控：模型在内置浏览器里填表、点击、勾选。
  const browserConversation = await focusedConversation();
  stop = record('browser');
  await send('打开项目里的看板页面，把「登录接口加按 IP 限流」加进待办，再把发布说明那项勾掉。');
  await finishRun(browserConversation);
  await sleep(1500);
  stop();
  await capture('browser.png');

  // QQ Bot：假 NapCat 推送一条真实格式的群消息，GrayCode 联网搜索后回复到群里。
  const latest = await ui('platform.settings.get');
  const owner = latest.accounts.find(account => account.role === 'owner') ?? latest.accounts[0];
  latest.bindings.push({ id: 'qq-demo', platform: 'onebot', network: 'qq', platformUserId: '20002', accountId: owner.id });
  latest.onebot = { enabled: true, endpoint: `ws://127.0.0.1:${onebotServer.address().port}`, protocolVersion: 11, autoConnect: false,
    processingHint: true, mentionOnly: true, agentId: latest.agents[0].id, allowedChannelIds: ['group:70001'],
    channels: { 'group:70001': { name: 'GrayCode 用户群' } }, defaultProfile: { toolsEnabled: true } };
  await ui('ui.settings.begin');
  await ui('platform.settings.update', { settings: latest });
  await ui('ui.settings.save');
  await ui('ui.settings.end');
  await rpc('onebot.start');
  await until(() => onebotServer.clients.size > 0, 'OneBot connection');
  await setSidePanel(false);
  await clickText('.navigation-bottom button', '机器人会话');
  stop = record('bot');
  const [socket] = onebotServer.clients;
  const question = ' DeepSeek 新出的官方搜索 API 有调用频率限制吗？怎么接进 GrayCode？';
  socket.send(JSON.stringify({ time: Math.floor(Date.now() / 1000), self_id: 10001, post_type: 'message', message_type: 'group', sub_type: 'normal',
    message_id: 5001, group_id: 70001, user_id: 20002, font: 0, raw_message: `[CQ:at,qq=10001]${question}`,
    sender: { user_id: 20002, nickname: '竹林', card: '竹林', role: 'member' },
    message: [{ type: 'at', data: { qq: '10001' } }, { type: 'text', data: { text: question } }] }));
  const botRow = 'Array.from(document.querySelectorAll(".navigation-row")).find(node => node.textContent.includes("70001"))';
  await until(() => evaluate(`!!${botRow}`), 'bot conversation row');
  await evaluate(`${botRow}.querySelector("button, a, [role=button]")?.click()`);
  await until(() => sent.length > 0, 'OneBot reply', 60000);
  await until(() => chat('document.body.innerText.includes("搜索和抓取共用这份配额")'), 'bot conversation opened');
  await chat('Array.from(document.querySelectorAll(".tool-item")).find(node => node.textContent.includes("搜索"))?.querySelector(".tool-summary")?.click()');
  await sleep(1500);
  stop();
  await capture('bot.png');

  // 设置页：OneBot 的真实连接状态，以及 Discord 的默认回复配置。
  await rpc('ui.command', { command: 'showSettings' });
  await until(() => chat('!!document.querySelector(".settings-panel")'), 'settings panel');
  const openSettings = label => chat(`Array.from(document.querySelectorAll('.settings-tab'))
    .find(node => node.textContent.trim() === ${JSON.stringify(label)}).click()`);
  await openSettings('NapCat / OneBot');
  await sleep(900);
  await capture('onebot-settings.png');
  await openSettings('Discord Bot');
  await sleep(600);
  await chat(`Array.from(document.querySelectorAll('[role=tab], .settings-panel button')).find(node => node.textContent.trim() === '默认回复').click()`);
  await sleep(900);
  await capture('discord-settings.png');

  modelServer.closeAllConnections();
  modelServer.close();
  for (const client of onebotServer.clients) client.terminate();
  onebotServer.close();
  app.quit();
}

main().catch(error => {
  process.stderr.write(`${error?.stack ?? String(error)}\n`);
  app.exit(1);
});
