import type { ModelRequestSnapshot, RpcMethod, RpcParams, RpcResult } from '@graycode/contracts';
import type { PlatformApplication } from '../application';
import type { ClientSession } from './router';

type HostedMethod = 'diagnostics.get' | 'settings.get' | 'settings.save' | 'files.list' | 'files.inspect' | 'files.downloadInfo'
  | 'files.create' | 'files.move' | 'files.remove' | 'files.upload' | 'runs.list' | 'runs.events' | 'runs.request' | 'runs.cancel' | 'approvals.resolve';
type Handler<M extends RpcMethod> = (app: PlatformApplication, session: ClientSession, params: RpcParams<M>) => RpcResult<M> | Promise<RpcResult<M>>;

/** 已迁移的处理器同时检查入参和返回值，服务继续执行原有账号、目录和版本判断。 */
const handlers: { [M in HostedMethod]: Handler<M> } = {
  'diagnostics.get': (app, session) => {
    app.requireOwner(session.actorId);
    return { activeRuns: app.runtime.activeCount, ...app.tools.diagnostics(), managedProcesses: app.processes.activeCount,
      eventStream: app.remoteAccess?.status().eventStream };
  },
  'settings.get': (app, session) => { app.requireOwner(session.actorId); return app.settings.snapshot(); },
  'settings.save': (app, session, params) => { app.requireOwner(session.actorId); return app.settings.save(params); },
  'files.list': (app, session, params) => {
    app.requireOwner(session.actorId);
    return app.files.list(app.workspace(session.actorId, params.workspaceId, ['workspace_read']), params.path);
  },
  'files.inspect': (app, session, params) => app.fileActions.inspect(session.actorId, params.workspaceId, params.path),
  'files.downloadInfo': async (app, session, params) => {
    const { absolute: _absolute, ...info } = await app.fileActions.download(session.actorId, params.workspaceId, params.path); return info;
  },
  'files.create': (app, session, params) => app.fileActions.create(session.actorId, params.workspaceId, params.path, params.kind),
  'files.move': (app, session, params) => app.fileActions.move(session.actorId, params.workspaceId, params.path, params.target, params.expectedVersion),
  'files.remove': (app, session, params) => app.fileActions.remove(session.actorId, params.workspaceId, params.path, params.expectedVersion, params.recursive === true),
  'files.upload': (app, session, params) => app.fileActions.upload(session.actorId, params.workspaceId, params.path, params.expectedVersion, params.bytes),
  'runs.list': (app, session, params) => app.storage.listRuns({ conversationId: params.conversationId,
    actorId: app.actor(session.actorId)?.role === 'owner' ? undefined : session.actorId, activeOnly: params.activeOnly, limit: 100 }),
  'runs.events': async (app, session, params) => {
    const run = await app.storage.getRun(params.id);
    if (!run) throw new Error('Run not found.');
    await app.conversation(session.actorId, run.conversationId);
    return app.storage.readRunEvents(params.id, params.afterSequence);
  },
  'runs.request': async (app, session, params) => {
    const run = await app.storage.getRun(params.id);
    if (!run) throw new Error('Run not found.');
    await app.conversation(session.actorId, run.conversationId);
    if (!Number.isSafeInteger(params.iteration) || params.iteration < 1) throw new Error('请选择模型调用轮次。');
    return app.storage.getRecord('model-requests', `${run.id}:${params.iteration}`) as Promise<ModelRequestSnapshot | null>;
  },
  'runs.cancel': (app, session, params) => app.runtime.cancel(params.id, session.actorId),
  'approvals.resolve': (app, session, params) => app.runtime.resolveApproval(params.id, session.actorId, params.accepted, params.choiceId),
};

export function hasRpcHandler(method: string): method is HostedMethod { return Object.hasOwn(handlers, method); }
export function rpcRequest<M extends HostedMethod>(app: PlatformApplication, session: ClientSession, method: M, params: unknown) {
  // 路由入口已用同一份 contracts 字段表完成检查。
  return handlers[method](app, session, params as RpcParams<M>);
}
