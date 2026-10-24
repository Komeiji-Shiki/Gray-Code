import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { PlatformMessage, RunRecord } from '@graycode/contracts';
import type { PlatformApplication } from '../application';
import type { ApplicationRouter, ClientSession } from '../transport/router';
import { chatUserMessage } from '../transport/chatInput';
import { maxReferenceAudioBytes } from '../speech/service';
import { compactMessage, preview, runFinished, runReply } from './view';
import packageMetadata from '../../../../package.json';

export const session: ClientSession = { actorId: 'owner', clientId: 'control-api' };
/** 消息附件按 base64 内联；参考录音上限按 base64 膨胀后的大小再留出字段余量。 */
export const jsonBodyLimit = 40 * 1024 * 1024;
const cloneBodyLimit = Math.ceil(maxReferenceAudioBytes / 3) * 4 + 64 * 1024;
const maxWaitSeconds = 3_600;
const replyWindow = 50;

export class ControlRequestError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export interface RouteContext {
  url: URL;
  params: Record<string, string>;
  request: IncomingMessage;
  response: ServerResponse;
  body(limit?: number): Promise<Record<string, any>>;
}

export interface ControlRoute {
  method: 'GET' | 'POST';
  path: string;
  summary: string;
  query?: Record<string, string>;
  body?: Record<string, string>;
  /** 返回状态码与响应体；事件流这类自行写出响应的接口不返回。 */
  handle(context: RouteContext): Promise<[number, unknown] | void>;
}

function integer(value: string | null, fallback: number, min: number, max: number, name: string): number {
  if (value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new ControlRequestError(400, `${name} 必须是 ${min} 至 ${max} 之间的整数。`);
  return parsed;
}

/** 等待参数：true 表示等到任务结束，数字表示最多等待的秒数。 */
function waitSeconds(value: unknown): number | true | undefined {
  if (value === undefined || value === false || value === 0) return undefined;
  if (value === true) return true;
  if (typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= maxWaitSeconds) return value;
  throw new ControlRequestError(400, `wait 必须是 true 或 1 至 ${maxWaitSeconds} 之间的秒数。`);
}

function encodeCursor(cursor?: { updatedAt: number; id: string }) {
  return cursor ? Buffer.from(JSON.stringify(cursor)).toString('base64url') : undefined;
}

function decodeCursor(value: string | null): { updatedAt: number; id: string } | undefined {
  if (!value) return undefined;
  try {
    const cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (Number.isFinite(cursor?.updatedAt) && typeof cursor.id === 'string') return cursor;
  } catch { /* 下面统一报告 */ }
  throw new ControlRequestError(400, 'cursor 无效，请使用上一页返回的 nextCursor。');
}

/** 路由表同时是 GET /v1 的接口说明；外部代理读一次就能知道全部用法。 */
export function controlRoutes(application: PlatformApplication, options: {
  router: ApplicationRouter;
  streamEvents(context: RouteContext): void;
}): ControlRoute[] {
  const conversationOf = async (id: string) => {
    try { return await application.conversation(session.actorId, id); }
    catch (error) {
      if ((error as { code?: string }).code) throw error;
      throw new ControlRequestError(404, `会话不存在：${id}`);
    }
  };
  const runOf = async (id: string) => {
    const run = await application.storage.getRun(id);
    if (!run) throw new ControlRequestError(404, `任务不存在：${id}`);
    return run;
  };
  const approvalOf = (runId: string, id: string) => {
    const request = application.runtime.pendingApprovals().find(item => item.id === id && item.runId === runId);
    if (!request) throw new ControlRequestError(404, '这个审批不存在或已经处理。');
    return request;
  };
  /** 运行中的任务附带正在等待的审批与问题，代理据此决定批准、拒绝或回答。 */
  const pendingOf = (runId: string) => {
    const approvals = application.runtime.pendingApprovals().filter(item => item.runId === runId).map(item => ({
      id: item.id, toolName: item.toolName, input: preview(item.args), effects: item.effects,
      ...(item.reason ? { reason: item.reason } : {}), ...(item.choices ? { choices: item.choices } : {}),
    }));
    const questions = application.runtime.pendingQuestions().filter(item => item.runId === runId)
      .map(item => ({ id: item.id, questions: item.questions, expiresAt: item.expiresAt }));
    return approvals.length || questions.length ? { pending: { approvals, questions } } : {};
  };
  /** 结束的任务附带最终回复，调用方不必再翻历史。 */
  const describeRun = async (run: RunRecord) => {
    if (!runFinished(run)) return { run, done: false, ...pendingOf(run.id) };
    const tail = await application.storage.readHistory(run.conversationId, { limit: replyWindow });
    const reply = runReply(tail.messages, run.id);
    return { run, done: true, ...(reply ? { reply } : {}) };
  };
  const settle = async (run: RunRecord, wait: number | true | undefined): Promise<RunRecord> => {
    if (wait === undefined || runFinished(run)) return run;
    const done = application.runtime.wait(run.id);
    if (wait === true) await done;
    else {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([done, new Promise<void>(resolve => { timer = setTimeout(resolve, wait * 1000); })]);
      clearTimeout(timer);
    }
    return runOf(run.id);
  };

  const routes: ControlRoute[] = [
    {
      method: 'GET', path: '/v1', summary: '列出全部接口、参数与约定（本说明）。',
      handle: async () => [200, {
        name: 'GrayCode Control API', version: packageMetadata.version,
        auth: '每个请求带 Authorization: Bearer <token> 或 X-GrayCode-Token: <token>。',
        conventions: [
          '请求与响应都是 JSON；错误响应为 { error, code? }，按 HTTP 状态区分：400 参数错误，401 令牌错误，404 不存在，'
            + '409 会话已有任务在运行或数据已变化，502 上游服务失败。',
          '任务状态 awaiting_approval / awaiting_input 时，响应的 pending 列出待审批的工具调用与待回答的问题，'
            + '可以用 /v1/runs/:id/approvals/:approvalId 批准或拒绝、用 /v1/runs/:id/questions/:questionId 回答，GrayCode 界面也能处理。',
          '长任务建议 wait 传秒数（如 120），超时返回 202 与当前状态，再用 GET /v1/runs/:id?wait=120 继续等待。',
        ],
        routes: routes.map(({ method, path, summary, query, body }) => ({ method, path, summary,
          ...(query ? { query } : {}), ...(body ? { body } : {}) })),
      }],
    },
    {
      method: 'GET', path: '/v1/health', summary: '连接检查，返回名称与版本。',
      handle: async () => [200, { name: 'GrayCode', version: packageMetadata.version, status: 'ok' }],
    },
    {
      method: 'GET', path: '/v1/status', summary: '活动任务数，以及发送消息时可选的智能体、模型渠道与工作区。',
      handle: async () => {
        const settings = application.settings.read('agents', 'providers', 'workspaces');
        return [200, {
          name: 'GrayCode', version: packageMetadata.version, actorId: session.actorId, activeRuns: application.runtime.activeCount,
          agents: settings.agents.map(agent => ({ id: agent.id, name: agent.name })),
          providers: settings.providers.map(provider => ({ id: provider.id, name: provider.name, model: provider.model,
            models: provider.models.map(model => model.id) })),
          workspaces: settings.workspaces.filter(workspace => !workspace.managedConversationId)
            .map(workspace => ({ id: workspace.id, name: workspace.name, directory: workspace.directory })),
        }];
      },
    },
    {
      method: 'GET', path: '/v1/conversations', summary: '按最近更新列出会话。',
      query: { limit: '1-100，默认 50', query: '标题与内容关键字', workspaceUri: '只看该工作区', cursor: '上一页的 nextCursor' },
      handle: async ({ url }) => {
        const list = await application.storage.listConversations({
          limit: integer(url.searchParams.get('limit'), 50, 1, 100, 'limit'),
          ...(url.searchParams.get('workspaceUri') ? { workspaceUri: url.searchParams.get('workspaceUri')! } : {}),
          ...(url.searchParams.get('query') ? { query: url.searchParams.get('query')! } : {}),
          ...(url.searchParams.get('cursor') ? { cursor: decodeCursor(url.searchParams.get('cursor')) } : {}),
        });
        return [200, { items: list.items, ...(list.nextCursor ? { nextCursor: encodeCursor(list.nextCursor) } : {}) }];
      },
    },
    {
      method: 'POST', path: '/v1/conversations', summary: '新建会话，返回会话元数据（含 id）。',
      body: { title: '可选，默认“外部控制对话”', workspaceId: '可选，取自 /v1/status 的 workspaces' },
      handle: async ({ body }) => {
        const input = await body();
        const title = typeof input.title === 'string' && input.title.trim() ? input.title.trim().slice(0, 200) : '外部控制对话';
        const workspaceId = typeof input.workspaceId === 'string' && input.workspaceId ? input.workspaceId : undefined;
        return [201, await application.createConversation(session.actorId, title, workspaceId)];
      },
    },
    {
      method: 'GET', path: '/v1/conversations/:id', summary: '读取会话元数据。',
      handle: async ({ params }) => [200, await conversationOf(params.id)],
    },
    {
      method: 'GET', path: '/v1/conversations/:id/messages', summary: '读取历史分页，默认最近 50 条。',
      query: { limit: '1-200，默认 50', beforeIndex: '只读这个位置之前的消息', offset: '从这个位置开始读',
        view: 'compact（默认：正文、工具调用摘要、附件类型）或 raw（原始结构，含 base64 附件）' },
      handle: async ({ params, url }) => {
        await conversationOf(params.id);
        const view = url.searchParams.get('view') ?? 'compact';
        if (view !== 'compact' && view !== 'raw') throw new ControlRequestError(400, 'view 只能是 compact 或 raw。');
        const page = await application.storage.readHistory(params.id, {
          limit: integer(url.searchParams.get('limit'), 50, 1, 200, 'limit'),
          ...(url.searchParams.has('beforeIndex') ? { beforeIndex: integer(url.searchParams.get('beforeIndex'), 0, 0, Number.MAX_SAFE_INTEGER, 'beforeIndex') } : {}),
          ...(url.searchParams.has('offset') ? { offset: integer(url.searchParams.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER, 'offset') } : {}),
        });
        return [200, view === 'raw' ? page : { ...page,
          messages: page.messages.map((message: PlatformMessage, index: number) => compactMessage(message, page.startIndex + index)) }];
      },
    },
    {
      method: 'POST', path: '/v1/conversations/:id/messages',
      summary: '发送用户消息并启动任务。结束时返回 200 与最终回复 reply，仍在运行时返回 202。',
      body: {
        text: '消息正文', attachments: '可选，[{ name, mimeType, data(base64) }]',
        agentId: '可选，默认第一个智能体', providerId: '可选，模型渠道', model: '可选，覆盖模型', reasoningEffort: '可选',
        wait: `可选，true 等到结束，或最多等待的秒数（1-${maxWaitSeconds}）`,
        requestKey: '可选，幂等键；也可用 Idempotency-Key 请求头。重发同一个键返回同一任务，不会重复执行',
      },
      handle: async ({ params, body, request }) => {
        const conversation = await conversationOf(params.id);
        const input = await body();
        if (input.attachments !== undefined && !Array.isArray(input.attachments)) throw new ControlRequestError(400, 'attachments 必须是数组。');
        const message = chatUserMessage({ attachments: input.attachments }, typeof input.text === 'string' ? input.text : '');
        if (!message.parts.length) throw new ControlRequestError(400, '请提供 text 或 attachments。');
        const agents = application.settings.read('agents').agents;
        const agentId = typeof input.agentId === 'string' && input.agentId ? input.agentId : agents[0]?.id;
        if (!agents.some(agent => agent.id === agentId))
          throw new ControlRequestError(400, `智能体不存在，可用：${agents.map(agent => agent.id).join(', ') || '无'}。`);
        const wait = waitSeconds(input.wait);
        const idempotency = request.headers['idempotency-key'];
        const key = typeof input.requestKey === 'string' && input.requestKey ? input.requestKey
          : typeof idempotency === 'string' && idempotency ? idempotency : randomUUID();
        const started = await application.runtime.start({
          requestKey: `control:${key}`, actorId: session.actorId, agentId: agentId!, conversationId: conversation.id,
          ...(typeof conversation.workspaceId === 'string' ? { workspaceId: conversation.workspaceId } : {}),
          ...(typeof input.providerId === 'string' && input.providerId ? { providerId: input.providerId } : {}),
          ...(typeof input.model === 'string' && input.model ? { modelOverride: input.model } : {}),
          ...(typeof input.reasoningEffort === 'string' && input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
          message,
        });
        const result = await describeRun(await settle(started, wait));
        return [result.done ? 200 : 202, { conversationId: conversation.id, ...result }];
      },
    },
    {
      method: 'GET', path: '/v1/runs/:id', summary: '任务状态；结束后附带最终回复 reply。',
      query: { wait: `可选，最多等待任务结束的秒数（1-${maxWaitSeconds}）` },
      handle: async ({ params, url }) => {
        const wait = url.searchParams.has('wait') ? integer(url.searchParams.get('wait'), 0, 1, maxWaitSeconds, 'wait') : undefined;
        const result = await describeRun(await settle(await runOf(params.id), wait));
        return [200, result];
      },
    },
    {
      method: 'GET', path: '/v1/runs/:id/events', summary: '任务事件，按序号递增。',
      query: { after: '只返回这个序号之后的事件，默认 0', limit: '1-1000，默认 200' },
      handle: async ({ params, url }) => {
        const run = await runOf(params.id);
        const events = await application.storage.readRunEvents(run.id, integer(url.searchParams.get('after'), 0, 0, Number.MAX_SAFE_INTEGER, 'after'),
          integer(url.searchParams.get('limit'), 200, 1, 1000, 'limit'));
        return [200, { run, events }];
      },
    },
    {
      method: 'POST', path: '/v1/runs/:id/approvals/:approvalId', summary: '批准或拒绝待审批的工具调用，审批项见任务状态的 pending.approvals。',
      body: { accepted: 'true 批准，false 拒绝', choiceId: '审批带 choices 时改为传其中一个选项的 id（如只允许这一次或始终允许）' },
      handle: async ({ params, body }) => {
        const request = approvalOf((await runOf(params.id)).id, params.approvalId);
        const input = await body();
        const choiceId = typeof input.choiceId === 'string' ? input.choiceId : undefined;
        if (choiceId === undefined && typeof input.accepted !== 'boolean')
          throw new ControlRequestError(400, request.choices ? `请传 choiceId，可选：${request.choices.map(choice => choice.id).join(', ')}。` : 'accepted 必须是 true 或 false。');
        // 带选项的审批由选项决定批准与否，运行时会按选项种类覆盖 accepted。
        await application.runtime.resolveApproval(request.id, session.actorId, input.accepted === true, choiceId);
        return [200, { success: true }];
      },
    },
    {
      method: 'POST', path: '/v1/runs/:id/questions/:questionId', summary: '回答模型提出的问题，问题见任务状态的 pending.questions。',
      body: { answers: '字符串数组，与 questions 一一对应；问题带 options 时可直接填其中一项' },
      handle: async ({ params, body }) => {
        const run = await runOf(params.id);
        const question = application.runtime.pendingQuestions().find(item => item.id === params.questionId && item.runId === run.id);
        if (!question) throw new ControlRequestError(404, '这个问题不存在、已经回答或已过期。');
        await application.runtime.answerQuestion(question.id, session.actorId, (await body()).answers);
        return [200, { success: true }];
      },
    },
    {
      method: 'POST', path: '/v1/runs/:id/cancel', summary: '取消任务。',
      handle: async ({ params }) => {
        const run = await runOf(params.id);
        await application.runtime.cancel(run.id, session.actorId);
        return [202, { success: true }];
      },
    },
    {
      method: 'GET', path: '/v1/events',
      summary: 'SSE 事件流，默认只推送任务事件（run.*、approval.*、question.*、tool.* 等）与 conversation.changed，'
        + '形如 { type, runId, conversationId, sequence, timestamp, status?, payload }。断线后用 Last-Event-ID 续传，收到 event: reset 时重新读取状态。',
      query: { types: '逗号分隔的事件类型，如 run.completed,run.failed,approval.requested', conversationId: '只保留该会话的事件',
        after: '同 Last-Event-ID', raw: '1 表示改为推送全部内部事件（含流式增量），结构随版本变化，不保证兼容' },
      handle: async context => { options.streamEvents(context); },
    },
    {
      method: 'POST', path: '/v1/rpc', summary: '调用界面同款内部 RPC，覆盖尚未封装成 REST 的操作；方法与参数随版本变化，不保证兼容。',
      body: { method: 'RPC 方法名', params: '可选，参数对象' },
      handle: async ({ body }) => {
        const input = await body();
        if (typeof input.method !== 'string' || !input.method) throw new ControlRequestError(400, 'method 不能为空。');
        if (input.params !== undefined && (!input.params || typeof input.params !== 'object' || Array.isArray(input.params)))
          throw new ControlRequestError(400, 'params 必须是对象。');
        return [200, { result: await options.router.call(session, input.method, input.params ?? {}) ?? null }];
      },
    },
    {
      method: 'POST', path: '/v1/speech', summary: '按当前语音设置合成，返回按句切分的音频片段。',
      body: { text: '要朗读的文本，Markdown 会先转成纯文本', voice: '可选，覆盖音色', speed: '可选，0.5-2', format: '可选，mp3 / wav / opus' },
      handle: async ({ body }) => {
        const input = await body();
        return [200, await application.speech.synthesize({
          text: input.text,
          ...(typeof input.voice === 'string' && input.voice ? { voice: input.voice } : {}),
          ...(input.speed !== undefined ? { speed: Number(input.speed) } : {}),
          ...(typeof input.format === 'string' ? { format: input.format as 'mp3' | 'wav' | 'opus' } : {}),
        }, session.clientId)];
      },
    },
    {
      method: 'POST', path: '/v1/speech/clone', summary: '用参考录音创建 Fish Audio 私有克隆音色，返回音色 ID。',
      body: { title: '音色名称', audio: '参考录音 base64', mimeType: '如 audio/wav', text: '可选，录音中实际说出的文字' },
      handle: async ({ body }) => {
        const input = await body(cloneBodyLimit);
        return [201, await application.speech.clone({ title: input.title, audio: input.audio, mimeType: input.mimeType,
          ...(typeof input.text === 'string' ? { text: input.text } : {}) })];
      },
    },
  ];
  return routes;
}
