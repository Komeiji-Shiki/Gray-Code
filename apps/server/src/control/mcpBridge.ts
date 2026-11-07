/**
 * 外部控制接口的 MCP stdio 桥。MCP 客户端（Codex、Claude Code 等）启动本进程，工具调用经本机管道转给
 * 正在运行的 GrayCode，不需要令牌和端口。工具由接口自己的 GET /v1 说明生成：GrayCode 未运行时列表为空，
 * 之后启动、重启或升级让工具变化时通知客户端刷新。
 *
 * 启动方式见发现文件或「设置 → 外部控制」：桌面版用 GrayCode.exe 加 ELECTRON_RUN_AS_NODE=1 运行本脚本，
 * 命令行版用 node 运行。同时运行多个实例时连接最近启动的一个，--data <数据目录> 指定实例。
 */
import { request } from 'node:http';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { controlDiscoveryDirectory, processAlive, type ControlDiscovery } from './discovery';
import type { ControlRoute } from './routes';
import packageMetadata from '../../../../package.json';

const protocolVersions = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const pollMs = 5_000;
const instructions = '控制本机正在运行的 GrayCode：查看状态与会话、发送消息启动任务、等待结果、处理审批与提问。'
  + '先用 get_status 查看可用的智能体、模型渠道与工作区；send_message 的 wait 传秒数可直接拿到最终回复。'
  + 'MCP 工具调用通常有超时，wait 建议不超过 50 秒，任务未完成时用 get_run 继续等待。';

type CatalogRoute = Omit<ControlRoute, 'handle'>;
interface BridgeTool { name: string; description: string; inputSchema: Record<string, unknown>; route: CatalogRoute; params: string[] }
interface Instance extends ControlDiscovery { pid: number; startedAt: number }

const { values } = parseArgs({ options: { data: { type: 'string' } } });
const wanted = values.data ? path.resolve(values.data) : undefined;
const samePath = (left: string, right: string) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;

async function instance(): Promise<Instance | undefined> {
  const directory = controlDiscoveryDirectory();
  const found: Instance[] = [];
  for (const name of (await readdir(directory).catch(() => [])).filter(name => name.endsWith('.json'))) {
    try {
      const value = JSON.parse(await readFile(path.join(directory, name), 'utf8')) as Instance;
      if (typeof value.pipe === 'string' && processAlive(value.pid)) found.push(value);
    } catch { /* 文件正在写入或刚被删除，下次轮询再读。 */ }
  }
  return found.filter(item => !wanted || samePath(path.resolve(item.dataDirectory), wanted)).sort((left, right) => right.startedAt - left.startedAt)[0];
}

function call(pipe: string, method: string, route: string, body?: unknown): Promise<{ status: number; value: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const outgoing = request({ socketPath: pipe, method, path: route,
      headers: { host: 'localhost', ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}) } }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let value: unknown = text;
        try { value = JSON.parse(text); } catch { /* 非 JSON 响应按原文返回。 */ }
        resolve({ status: response.statusCode ?? 0, value });
      });
    });
    outgoing.on('error', reject);
    outgoing.end(payload);
  });
}

/** 路径参数必填；查询和请求体参数沿用接口说明里的文字描述，类型由接口自己校验。 */
function toolsOf(routes: CatalogRoute[]): BridgeTool[] {
  return routes.filter(route => route.tool).map(route => {
    const params = [...route.path.matchAll(/:(\w+)/g)].map(match => match[1]);
    const properties = {
      ...Object.fromEntries(params.map(name => [name, { type: 'string', description: `路径 ${route.path} 中的 :${name}` }])),
      ...Object.fromEntries(Object.entries({ ...route.query, ...route.body }).map(([name, description]) => [name, { description }])),
    };
    return { name: route.tool!, description: `${route.summary}（${route.method} ${route.path}）`, route, params,
      inputSchema: { type: 'object', properties, ...(params.length ? { required: params } : {}) } };
  });
}

let tools: BridgeTool[] = [];
let signature = '[]';
let catalogPipe: string | undefined;

/** 返回工具列表是否变化；同一个实例的接口说明不会变，只在实例变化时重新读取。 */
async function refresh(): Promise<boolean> {
  const target = await instance();
  if (target?.pipe === catalogPipe) return false;
  let next: BridgeTool[] = [];
  if (target) {
    try {
      const { status, value } = await call(target.pipe, 'GET', '/v1');
      if (status === 200) next = toolsOf((value as { routes: CatalogRoute[] }).routes);
    } catch { /* 管道刚关闭，按未运行处理。 */ }
  }
  catalogPipe = next.length ? target!.pipe : undefined;
  const nextSignature = JSON.stringify(next.map(({ name, description, inputSchema }) => [name, description, inputSchema]));
  const changed = nextSignature !== signature;
  tools = next; signature = nextSignature;
  return changed;
}

async function invoke(tool: BridgeTool, args: Record<string, unknown>) {
  const failed = (text: string) => ({ content: [{ type: 'text', text }], isError: true });
  const target = await instance();
  if (!target) return failed('GrayCode 没有运行，请先打开 GrayCode。');
  const rest = { ...args };
  let route = tool.route.path;
  for (const name of tool.params) {
    const value = rest[name];
    delete rest[name];
    if (typeof value !== 'string' || !value) return failed(`缺少路径参数 ${name}。`);
    route = route.replace(`:${name}`, encodeURIComponent(value));
  }
  if (tool.route.method === 'GET') {
    const query = new URLSearchParams(Object.entries(rest).filter(([, value]) => value !== undefined && value !== null)
      .map(([name, value]): [string, string] => [name, typeof value === 'string' ? value : JSON.stringify(value)]));
    if (query.size) route += `?${query}`;
  }
  const { status, value } = await call(target.pipe, tool.route.method, route, tool.route.method === 'POST' ? rest : undefined);
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }], ...(status >= 400 ? { isError: true } : {}) };
}

const send = (message: Record<string, unknown>) => { process.stdout.write(`${JSON.stringify(message)}\n`); };
const handlers: Record<string, (params: Record<string, any>) => Promise<unknown>> = {
  initialize: async params => {
    await refresh();
    return { protocolVersion: protocolVersions.includes(params.protocolVersion) ? params.protocolVersion : protocolVersions[0],
      capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'graycode', version: packageMetadata.version }, instructions };
  },
  ping: async () => ({}),
  'tools/list': async () => {
    await refresh();
    return { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) };
  },
  'tools/call': async params => {
    let tool = tools.find(item => item.name === params.name);
    if (!tool && await refresh()) tool = tools.find(item => item.name === params.name);
    if (!tool) throw Object.assign(new Error(`未知工具：${params.name}`), { code: -32602 });
    return invoke(tool, params.arguments ?? {});
  },
};

async function serve() {
  let initialized = false;
  const poll = setInterval(() => {
    if (initialized) void refresh().then(changed => { if (changed) send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }); });
  }, pollMs);
  for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    let message: { id?: string | number; method?: string; params?: Record<string, any> };
    try { message = JSON.parse(line); }
    catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); continue; }
    if (message.method === 'notifications/initialized') initialized = true;
    // 通知和客户端对请求的应答都没有需要处理的内容。
    if (message.id === undefined || !message.method) continue;
    const { id } = message;
    const handler = handlers[message.method];
    if (!handler) { send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${message.method}` } }); continue; }
    handler(message.params ?? {}).then(result => send({ jsonrpc: '2.0', id, result }),
      (error: Error & { code?: number }) => send({ jsonrpc: '2.0', id, error: { code: error.code ?? -32603, message: error.message } }));
  }
  clearInterval(poll);
}

void serve();
